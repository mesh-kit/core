import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ChannelPattern } from "../types";
import type { RecordManager } from "./record";
import type { PersistenceManager } from "./persistence";
import { RECORD_PUB_SUB_CHANNEL } from "../utils/constants";

export class RecordSubscriptionManager {
  private pubClient: Redis;
  private recordManager: RecordManager;
  private persistenceManager: PersistenceManager | null = null;
  private exposedRecords: ChannelPattern[] = [];
  private exposedWritableRecords: ChannelPattern[] = [];
  private recordGuards: Map<ChannelPattern, (connection: Connection, recordId: string) => Promise<boolean> | boolean> = new Map();
  private writableRecordGuards: Map<ChannelPattern, (connection: Connection, recordId: string) => Promise<boolean> | boolean> = new Map();
  private recordSubscriptions: Map<
    string, // recordId
    Map<string, "patch" | "full"> // connectionId -> mode
  > = new Map();
  private emitError: (error: Error) => void;

  constructor(pubClient: Redis, recordManager: RecordManager, emitError: (error: Error) => void, persistenceManager?: PersistenceManager) {
    this.pubClient = pubClient;
    this.recordManager = recordManager;
    this.emitError = emitError;
    this.persistenceManager = persistenceManager || null;
  }

  /**
   * Sets the persistence manager for this subscription manager
   *
   * @param persistenceManager The persistence manager to use
   */
  setPersistenceManager(persistenceManager: PersistenceManager): void {
    this.persistenceManager = persistenceManager;
  }

  /**
   * Exposes a record or pattern for client subscriptions, optionally adding a guard function.
   *
   * @param {ChannelPattern} recordPattern - The record ID or pattern to expose.
   * @param {(connection: Connection, recordId: string) => Promise<boolean> | boolean} [guard] - Optional guard function.
   */
  exposeRecord(recordPattern: ChannelPattern, guard?: (connection: Connection, recordId: string) => Promise<boolean> | boolean): void {
    this.exposedRecords.push(recordPattern);
    if (guard) {
      this.recordGuards.set(recordPattern, guard);
    }
  }

  /**
   * Exposes a record or pattern for client writes, optionally adding a guard function.
   *
   * @param {ChannelPattern} recordPattern - The record ID or pattern to expose as writable.
   * @param {(connection: Connection, recordId: string) => Promise<boolean> | boolean} [guard] - Optional guard function.
   */
  exposeWritableRecord(recordPattern: ChannelPattern, guard?: (connection: Connection, recordId: string) => Promise<boolean> | boolean): void {
    this.exposedWritableRecords.push(recordPattern);
    if (guard) {
      this.writableRecordGuards.set(recordPattern, guard);
    }
  }

  /**
   * Checks if a record is exposed for reading
   *
   * @param recordId - The record ID to check
   * @param connection - The connection requesting access
   * @returns A promise that resolves to true if the record is exposed and the connection has access
   */
  async isRecordExposed(recordId: string, connection: Connection): Promise<boolean> {
    const readPattern = this.exposedRecords.find((pattern) => (typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)));

    let canRead = false;
    if (readPattern) {
      const guard = this.recordGuards.get(readPattern);
      if (guard) {
        try {
          canRead = await Promise.resolve(guard(connection, recordId));
        } catch (e) {
          canRead = false;
        }
      } else {
        canRead = true;
      }
    }

    if (canRead) {
      return true;
    }

    // if exposed as writable, it is implicitly readable
    const writePattern = this.exposedWritableRecords.find((pattern) => (typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)));

    // If exposed as writable, it's readable. No need to check the *write* guard here.
    if (writePattern) {
      return true;
    }

    return false;
  }

  /**
   * Checks if a record is exposed for writing
   *
   * @param recordId - The record ID to check
   * @param connection - The connection requesting access
   * @returns A promise that resolves to true if the record is writable and the connection has access
   */
  async isRecordWritable(recordId: string, connection: Connection): Promise<boolean> {
    const matchedPattern = this.exposedWritableRecords.find((pattern) => (typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)));

    if (!matchedPattern) {
      return false;
    }

    const guard = this.writableRecordGuards.get(matchedPattern);
    if (guard) {
      try {
        return await Promise.resolve(guard(connection, recordId));
      } catch (e) {
        return false;
      }
    }

    return true;
  }

  /**
   * Subscribes a connection to a record
   *
   * @param recordId - The record ID to subscribe to
   * @param connectionId - The connection ID to subscribe
   * @param mode - The subscription mode (patch or full)
   */
  addSubscription(recordId: string, connectionId: string, mode: "patch" | "full"): void {
    if (!this.recordSubscriptions.has(recordId)) {
      this.recordSubscriptions.set(recordId, new Map());
    }
    this.recordSubscriptions.get(recordId)!.set(connectionId, mode);
  }

  /**
   * Unsubscribes a connection from a record
   *
   * @param recordId - The record ID to unsubscribe from
   * @param connectionId - The connection ID to unsubscribe
   * @returns true if the connection was subscribed and is now unsubscribed, false otherwise
   */
  removeSubscription(recordId: string, connectionId: string): boolean {
    const recordSubs = this.recordSubscriptions.get(recordId);
    if (recordSubs?.has(connectionId)) {
      recordSubs.delete(connectionId);
      if (recordSubs.size === 0) {
        this.recordSubscriptions.delete(recordId);
      }
      return true;
    }
    return false;
  }

  /**
   * Gets all subscribers for a record
   *
   * @param recordId - The record ID to get subscribers for
   * @returns A map of connection IDs to subscription modes, or undefined if none
   */
  getSubscribers(recordId: string): Map<string, "patch" | "full"> | undefined {
    return this.recordSubscriptions.get(recordId);
  }

  /**
   * Updates a record, persists it to Redis, increments its version, computes a patch,
   * and publishes the update via Redis pub/sub.
   *
   * @param {string} recordId - The ID of the record to update.
   * @param {any} newValue - The new value for the record, or partial value when using merge strategy.
   * @param {{ strategy?: "replace" | "merge" | "deepMerge" }} [options] - Update options: strategy defaults to "replace" which replaces the entire record, "merge" merges with existing object properties, "deepMerge" recursively merges nested objects.
   * @returns {Promise<void>}
   * @throws {Error} If the update fails.
   */
  async writeRecord(recordId: string, newValue: any, options?: { strategy?: "replace" | "merge" | "deepMerge" }): Promise<void> {
    const updateResult = await this.recordManager.publishUpdate(recordId, newValue, options?.strategy || "replace");

    if (!updateResult) {
      return;
    }

    const { patch, version, finalValue } = updateResult;

    if (this.persistenceManager) {
      this.persistenceManager.handleRecordUpdate(recordId, finalValue, version);
    }

    const messagePayload = {
      recordId,
      newValue: finalValue,
      patch,
      version,
    };

    try {
      await this.pubClient.publish(RECORD_PUB_SUB_CHANNEL, JSON.stringify(messagePayload));
    } catch (err) {
      this.emitError(new Error(`Failed to publish record update for "${recordId}": ${err}`));
    }
  }

  /**
   * Cleans up all subscriptions for a connection
   *
   * @param connection - The connection to clean up
   */
  cleanupConnection(connection: Connection): void {
    const connectionId = connection.id;
    this.recordSubscriptions.forEach((subscribers, recordId) => {
      if (subscribers.has(connectionId)) {
        subscribers.delete(connectionId);
        if (subscribers.size === 0) {
          this.recordSubscriptions.delete(recordId);
        }
      }
    });
  }

  /**
   * Publishes a record deletion event to all subscribed clients.
   *
   * @param {string} recordId - The ID of the record that was deleted.
   * @param {number} version - The final version of the record before deletion.
   * @returns {Promise<void>}
   */
  async publishRecordDeletion(recordId: string, version: number): Promise<void> {
    const messagePayload = {
      recordId,
      deleted: true,
      version,
    };

    try {
      await this.pubClient.publish(RECORD_PUB_SUB_CHANNEL, JSON.stringify(messagePayload));
    } catch (err) {
      this.emitError(new Error(`Failed to publish record deletion for "${recordId}": ${err}`));
    }
  }

  /**
   * Gets all record subscriptions
   *
   * @returns The record subscriptions map
   */
  getRecordSubscriptions(): Map<string, Map<string, "patch" | "full">> {
    return this.recordSubscriptions;
  }
}
