import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ChannelPattern } from "../types";

export class CollectionManager {
  private redis: Redis;
  private exposedCollections: Array<{
    pattern: ChannelPattern;
    resolver: (connection: Connection, collectionId: string) => Promise<any[]> | any[];
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
   * that determines which records belong to the collection.
   *
   * @param {ChannelPattern} pattern - The collection ID or pattern to expose.
   * @param {(connection: Connection, collectionId: string) => Promise<any[]> | any[]} resolver -
   *        Function that resolves which records belong to the collection.
   */
  exposeCollection(pattern: ChannelPattern, resolver: (connection: Connection, collectionId: string) => Promise<any[]> | any[]): void {
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
   * Resolves a collection to its current set of records.
   *
   * @param {string} collectionId - The collection ID to resolve.
   * @param {Connection} connection - The connection requesting the resolution.
   * @returns {Promise<any[]>} The records that belong to the collection.
   * @throws {Error} If the collection is not exposed or the resolver fails.
   */
  async resolveCollection(collectionId: string, connection: Connection): Promise<any[]> {
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
   * @returns {Promise<{ recordIds: string[]; records: any[]; version: number }>} The initial state of the collection.
   */
  async addSubscription(collectionId: string, connectionId: string, connection: Connection): Promise<{ recordIds: string[]; records: any[]; version: number }> {
    if (!this.collectionSubscriptions.has(collectionId)) {
      this.collectionSubscriptions.set(collectionId, new Map());
    }

    const records = await this.resolveCollection(collectionId, connection);
    const recordIds = records.map((record) => record.id); // extract IDs for tracking
    const version = 1;

    this.collectionSubscriptions.get(collectionId)!.set(connectionId, { version });

    await this.redis.set(`mesh:collection:${collectionId}:${connectionId}`, JSON.stringify(recordIds));

    return { recordIds, records, version };
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
   * Lists and processes records matching a pattern. Designed for use in collection resolvers.
   * Returns transformed records (not record IDs) that will be sent to subscribed clients.
   *
   * @param {string} pattern - The pattern to match record IDs against.
   * @param {Object} [options] - Processing options.
   * @param {Function} [options.map] - Transform each record before sorting/slicing.
   * @param {Function} [options.sort] - Sort function for the records.
   * @param {Object} [options.slice] - Pagination slice.
   * @param {number} [options.slice.start] - Start index.
   * @param {number} [options.slice.count] - Number of records to return.
   * @returns {Promise<any[]>} The processed records to send to clients.
   */
  async listRecordsMatching(
    pattern: string,
    options?: {
      map?: (record: any) => any;
      sort?: (a: any, b: any) => number;
      slice?: { start: number; count: number };
    },
  ): Promise<any[]> {
    try {
      const recordKeyPrefix = "mesh:record:";
      const keys = await this.redis.keys(`${recordKeyPrefix}${pattern}`);

      if (keys.length === 0) {
        return [];
      }

      const records = await this.redis.mget(keys);
      const cleanRecordIds = keys.map((key) => key.substring(recordKeyPrefix.length));

      let processedRecords = records
        .map((val, index) => {
          if (val === null) return null;
          try {
            const parsed = JSON.parse(val);
            // ensure record id matches the key (don't overwrite if already correct)
            const recordId = cleanRecordIds[index];
            return parsed.id === recordId ? parsed : { ...parsed, id: recordId };
          } catch (e: any) {
            this.emitError(new Error(`Failed to parse record for processing: ${val} - ${e.message}`));
            return null;
          }
        })
        .filter((record): record is any => record !== null);

      // apply transformations: map -> sort -> slice
      if (options?.map) {
        processedRecords = processedRecords.map(options.map);
      }

      if (options?.sort) {
        processedRecords.sort(options.sort);
      }

      if (options?.slice) {
        const { start, count } = options.slice;
        processedRecords = processedRecords.slice(start, start + count);
      }

      return processedRecords;
    } catch (error: any) {
      this.emitError(new Error(`Failed to list records matching "${pattern}": ${error.message}`));
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
