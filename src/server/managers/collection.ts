import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ChannelPattern } from "../types";

export class CollectionManager {
  private redis: Redis;
  private exposedCollections: Array<{
    pattern: ChannelPattern;
    resolver: (connection: Connection, collectionId: string) => Promise<string[]> | string[];
  }> = [];
  private collectionSubscriptions: Map<
    string, // collectionId
    Map<string, { version: number }> // connectionId -> { version }
  > = new Map();
  private emitError: (error: Error) => void;

  constructor(redis: Redis, emitError: (error: Error) => void) {
    this.redis = redis;
    this.emitError = emitError;
  }

  /**
   * Exposes a collection pattern for client subscriptions with a resolver function
   * that determines which record IDs belong to the collection.
   *
   * @param {ChannelPattern} pattern - The collection ID or pattern to expose.
   * @param {(connection: Connection, collectionId: string) => Promise<string[]> | string[]} resolver -
   *        Function that resolves which record IDs belong to the collection.
   */
  exposeCollection(pattern: ChannelPattern, resolver: (connection: Connection, collectionId: string) => Promise<string[]> | string[]): void {
    this.exposedCollections.push({ pattern, resolver });
  }

  /**
   * Checks if a collection is exposed for a specific connection.
   *
   * @param {string} collectionId - The collection ID to check.
   * @param {Connection} connection - The connection requesting access.
   * @returns {Promise<boolean>} True if the collection is exposed for the connection.
   */
  async isCollectionExposed(collectionId: string, connection: Connection): Promise<boolean> {
    const matchedPattern = this.exposedCollections.find((entry) =>
      typeof entry.pattern === "string" ? entry.pattern === collectionId : entry.pattern.test(collectionId),
    );

    return !!matchedPattern;
  }

  /**
   * Resolves a collection to its current set of record IDs.
   *
   * @param {string} collectionId - The collection ID to resolve.
   * @param {Connection} connection - The connection requesting the resolution.
   * @returns {Promise<string[]>} The record IDs that belong to the collection.
   * @throws {Error} If the collection is not exposed or the resolver fails.
   */
  async resolveCollection(collectionId: string, connection: Connection): Promise<string[]> {
    const matchedPattern = this.exposedCollections.find((entry) =>
      typeof entry.pattern === "string" ? entry.pattern === collectionId : entry.pattern.test(collectionId),
    );

    if (!matchedPattern) {
      throw new Error(`Collection "${collectionId}" is not exposed`);
    }

    try {
      return await Promise.resolve(matchedPattern.resolver(connection, collectionId));
    } catch (error) {
      this.emitError(new Error(`Failed to resolve collection "${collectionId}": ${error}`));
      throw error;
    }
  }

  /**
   * Adds a subscription to a collection for a connection.
   *
   * @param {string} collectionId - The collection ID to subscribe to.
   * @param {string} connectionId - The connection ID subscribing.
   * @param {Connection} connection - The connection object.
   * @returns {Promise<{ recordIds: string[]; version: number }>} The initial state of the collection.
   */
  async addSubscription(collectionId: string, connectionId: string, connection: Connection): Promise<{ recordIds: string[]; version: number }> {
    if (!this.collectionSubscriptions.has(collectionId)) {
      this.collectionSubscriptions.set(collectionId, new Map());
    }

    const recordIds = await this.resolveCollection(collectionId, connection);
    const version = 1;

    this.collectionSubscriptions.get(collectionId)!.set(connectionId, { version });

    await this.redis.set(`mesh:collection:${collectionId}:${connectionId}`, JSON.stringify(recordIds));

    return { recordIds, version };
  }

  /**
   * Removes a subscription to a collection for a connection.
   *
   * @param {string} collectionId - The collection ID to unsubscribe from.
   * @param {string} connectionId - The connection ID unsubscribing.
   * @returns {Promise<boolean>} True if the subscription was removed, false if it didn't exist.
   */
  async removeSubscription(collectionId: string, connectionId: string): Promise<boolean> {
    const collectionSubs = this.collectionSubscriptions.get(collectionId);
    if (collectionSubs?.has(connectionId)) {
      collectionSubs.delete(connectionId);
      if (collectionSubs.size === 0) {
        this.collectionSubscriptions.delete(collectionId);
      }

      await this.redis.del(`mesh:collection:${collectionId}:${connectionId}`);

      return true;
    }
    return false;
  }

  /**
   * Refreshes a collection subscription for a specific connection.
   * Computes the diff between the current and previous record IDs,
   * updates the version, and returns the changes.
   *
   * @param {string} collectionId - The collection ID to refresh.
   * @param {string} connectionId - The connection ID to refresh for.
   * @param {Connection} connection - The connection object.
   * @returns {Promise<{ added: string[]; removed: string[]; version: number }>}
   */
  async refreshCollection(
    collectionId: string,
    connectionId: string,
    connection: Connection,
  ): Promise<{ added: string[]; removed: string[]; version: number }> {
    const collectionSubs = this.collectionSubscriptions.get(collectionId);
    if (!collectionSubs || !collectionSubs.has(connectionId)) {
      throw new Error(`Connection ${connectionId} is not subscribed to collection ${collectionId}`);
    }

    const { version } = collectionSubs.get(connectionId)!;
    const newRecordIds = await this.resolveCollection(collectionId, connection);

    // get the previous record IDs for this connection
    const previousRecordIdsKey = `mesh:collection:${collectionId}:${connectionId}`;
    const previousRecordIdsStr = await this.redis.get(previousRecordIdsKey);
    const previousRecordIds = previousRecordIdsStr ? JSON.parse(previousRecordIdsStr) : [];

    // compute the diff
    const added = newRecordIds.filter((id: string) => !previousRecordIds.includes(id));
    const removed = previousRecordIds.filter((id: string) => !newRecordIds.includes(id));

    // update the version if there are changes
    let newVersion = version;
    if (added.length > 0 || removed.length > 0) {
      newVersion = version + 1;
      collectionSubs.set(connectionId, { version: newVersion });

      // store the new record IDs
      await this.redis.set(previousRecordIdsKey, JSON.stringify(newRecordIds));
    }

    return {
      added,
      removed,
      version: newVersion,
    };
  }

  /**
   * Publishes a collection update to Redis.
   * This should be called when a record is updated or deleted.
   *
   * @param {string} recordId - The record ID that was changed.
   * @returns {Promise<void>}
   */
  async publishRecordChange(recordId: string): Promise<void> {
    try {
      await this.redis.publish("mesh:collection:record-change", recordId);
    } catch (error) {
      this.emitError(new Error(`Failed to publish record change for ${recordId}: ${error}`));
    }
  }

  /**
   * Cleans up all subscriptions for a connection.
   *
   * @param {Connection} connection - The connection to clean up.
   */
  async cleanupConnection(connection: Connection): Promise<void> {
    const connectionId = connection.id;
    const cleanupPromises: Promise<void>[] = [];

    this.collectionSubscriptions.forEach((subscribers, collectionId) => {
      if (!subscribers.has(connectionId)) {
        return;
      }

      subscribers.delete(connectionId);

      if (subscribers.size === 0) {
        this.collectionSubscriptions.delete(collectionId);
      }

      // remove the stored record IDs
      cleanupPromises.push(
        this.redis
          .del(`mesh:collection:${collectionId}:${connectionId}`)
          .then(() => {})
          .catch((err) => {
            this.emitError(new Error(`Failed to clean up collection subscription for "${collectionId}": ${err}`));
          }),
      );
    });

    await Promise.all(cleanupPromises);
  }

  /**
   * Lists all records matching a pattern in Redis.
   *
   * @param {string} pattern - The pattern to match record IDs against.
   * @returns {Promise<string[]>} The matching record IDs.
   */
  async listRecordsMatching(pattern: string): Promise<string[]> {
    try {
      const recordKeyPrefix = "mesh:record:";
      const keys = await this.redis.keys(`${recordKeyPrefix}${pattern}`);
      return keys.map((key) => key.substring(recordKeyPrefix.length));
    } catch (error) {
      this.emitError(new Error(`Failed to list records matching "${pattern}": ${error}`));
      return [];
    }
  }

  /**
   * Gets all collection subscriptions.
   *
   * @returns {Map<string, Map<string, { version: number }>>} The collection subscriptions.
   */
  getCollectionSubscriptions(): Map<string, Map<string, { version: number }>> {
    return this.collectionSubscriptions;
  }

  /**
   * Updates the version of a collection subscription.
   *
   * @param {string} collectionId - The collection ID.
   * @param {string} connectionId - The connection ID.
   * @param {number} version - The new version.
   */
  updateSubscriptionVersion(collectionId: string, connectionId: string, version: number): void {
    const collectionSubs = this.collectionSubscriptions.get(collectionId);
    if (collectionSubs?.has(connectionId)) {
      const subscription = collectionSubs.get(connectionId)!;
      collectionSubs.set(connectionId, { version });
    }
  }
}
