import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ConnectionManager } from "./connection";
import type { PubSubMessagePayload, RecordUpdatePubSubPayload } from "../types";
import { PUB_SUB_CHANNEL_PREFIX, RECORD_PUB_SUB_CHANNEL } from "../utils/constants";
import type { CollectionManager } from "./collection";
import type { RecordManager } from "./record";
import { serverLogger } from "../../common/logger";

export class PubSubManager {
  private subClient: Redis;
  private pubClient: Redis;
  private instanceId: string;
  private connectionManager: ConnectionManager;
  private recordManager: RecordManager;
  private recordSubscriptions: Map<
    string, // recordId
    Map<string, "patch" | "full"> // connectionId -> mode
  >;
  private getChannelSubscriptions: (channel: string) => Set<Connection> | undefined;
  private emitError: (error: Error) => void;
  private _subscriptionPromise!: Promise<void>;
  private collectionManager: CollectionManager | null = null;

  private collectionUpdateTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private collectionMaxDelayTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private pendingCollectionUpdates: Map<string, Set<string>> = new Map();
  private readonly COLLECTION_UPDATE_DEBOUNCE_MS = 50;
  private readonly COLLECTION_MAX_DELAY_MS = 200;

  constructor(
    subClient: Redis,
    instanceId: string,
    connectionManager: ConnectionManager,
    recordManager: RecordManager,
    recordSubscriptions: Map<string, Map<string, "patch" | "full">>,
    getChannelSubscriptions: (channel: string) => Set<Connection> | undefined,
    emitError: (error: Error) => void,
    collectionManager: CollectionManager | null,
    pubClient: Redis,
  ) {
    this.subClient = subClient;
    this.pubClient = pubClient;
    this.instanceId = instanceId;
    this.connectionManager = connectionManager;
    this.recordManager = recordManager;
    this.recordSubscriptions = recordSubscriptions;
    this.getChannelSubscriptions = getChannelSubscriptions;
    this.emitError = emitError;
    this.collectionManager = collectionManager || null;
  }

  /**
   * Subscribes to the instance channel and sets up message handlers
   *
   * @returns A promise that resolves when the subscription is complete
   */
  subscribeToInstanceChannel(): Promise<void> {
    const channel = `${PUB_SUB_CHANNEL_PREFIX}${this.instanceId}`;

    this._subscriptionPromise = new Promise((resolve, reject) => {
      this.subClient.subscribe(channel, RECORD_PUB_SUB_CHANNEL, "mesh:collection:record-change");
      this.subClient.psubscribe("mesh:presence:updates:*", (err) => {
        if (err) {
          this.emitError(new Error(`Failed to subscribe to channels/patterns:`, { cause: err }));
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.setupMessageHandlers();

    return this._subscriptionPromise;
  }

  /**
   * Sets up message handlers for the subscribed channels
   */
  private setupMessageHandlers(): void {
    this.subClient.on("message", async (channel, message) => {
      if (channel.startsWith(PUB_SUB_CHANNEL_PREFIX)) {
        this.handleInstancePubSubMessage(channel, message);
      } else if (channel === RECORD_PUB_SUB_CHANNEL) {
        this.handleRecordUpdatePubSubMessage(message);
      } else if (channel === "mesh:collection:record-change") {
        this.handleCollectionRecordChange(message);
      } else {
        const subscribers = this.getChannelSubscriptions(channel);
        if (subscribers) {
          for (const connection of subscribers) {
            if (!connection.isDead) {
              connection.send({
                command: "mesh/subscription-message",
                payload: { channel, message },
              });
            }
          }
        }
      }
    });

    this.subClient.on("pmessage", async (pattern, channel, message) => {
      if (pattern === "mesh:presence:updates:*") {
        // channel here is the actual channel, e.g., mesh:presence:updates:roomName
        const subscribers = this.getChannelSubscriptions(channel);
        if (subscribers) {
          try {
            const payload = JSON.parse(message);
            subscribers.forEach((connection: Connection) => {
              if (!connection.isDead) {
                connection.send({
                  command: "mesh/presence-update",
                  payload: payload,
                });
              } else {
                // clean up dead connections from subscription list
                subscribers.delete(connection);
              }
            });
          } catch (e) {
            this.emitError(new Error(`Failed to parse presence update: ${message}`));
          }
        }
      }
    });
  }

  /**
   * Handles messages from the instance PubSub channel
   *
   * @param channel - The channel the message was received on
   * @param message - The message content
   */
  private handleInstancePubSubMessage(channel: string, message: string) {
    try {
      const parsedMessage = JSON.parse(message) as PubSubMessagePayload;

      if (!parsedMessage || !Array.isArray(parsedMessage.targetConnectionIds) || !parsedMessage.command || typeof parsedMessage.command.command !== "string") {
        throw new Error("Invalid message format");
      }

      const { targetConnectionIds, command } = parsedMessage;

      targetConnectionIds.forEach((connectionId) => {
        const connection = this.connectionManager.getLocalConnection(connectionId);

        if (connection && !connection.isDead) {
          connection.send(command);
        }
      });
    } catch (err) {
      this.emitError(new Error(`Failed to parse message: ${message}`));
    }
  }

  /**
   * Handles record update messages from the record PubSub channel
   *
   * @param message - The message content
   */
  private handleRecordUpdatePubSubMessage(message: string) {
    try {
      const parsedMessage = JSON.parse(message) as RecordUpdatePubSubPayload;
      const { recordId, newValue, patch, version, deleted } = parsedMessage;

      if (!recordId || typeof version !== "number") {
        throw new Error("Invalid record update message format");
      }

      const subscribers = this.recordSubscriptions.get(recordId);

      if (!subscribers) {
        return;
      }

      subscribers.forEach((mode, connectionId) => {
        const connection = this.connectionManager.getLocalConnection(connectionId);
        if (connection && !connection.isDead) {
          if (deleted) {
            connection.send({
              command: "mesh/record-deleted",
              payload: { recordId, version },
            });
          } else if (mode === "patch" && patch) {
            connection.send({
              command: "mesh/record-update",
              payload: { recordId, patch, version },
            });
          } else if (mode === "full" && newValue !== undefined) {
            connection.send({
              command: "mesh/record-update",
              payload: { recordId, full: newValue, version },
            });
          }
        } else if (!connection || connection.isDead) {
          subscribers.delete(connectionId);
          if (subscribers.size === 0) {
            this.recordSubscriptions.delete(recordId);
          }
        }
      });

      if (deleted) {
        this.recordSubscriptions.delete(recordId);
      }
    } catch (err) {
      this.emitError(new Error(`Failed to parse record update message: ${message}`));
    }
  }

  /**
   * Handles a record change notification for collections with debouncing.
   * Batches rapid updates to avoid race conditions and improve performance.
   *
   * @param {string} changedRecordId - The message, which is the ID of the record that has changed.
   * @returns {Promise<void>}
   */
  private async handleCollectionRecordChange(changedRecordId: string): Promise<void> {
    if (!this.collectionManager) return;

    const collectionSubsMap = this.collectionManager.getCollectionSubscriptions();
    const affectedCollections = new Set<string>();

    // optimization: could check patterns/resolver hints in the future
    for (const [collectionId] of collectionSubsMap.entries()) {
      affectedCollections.add(collectionId);
    }

    for (const collectionId of affectedCollections) {
      const existingTimeout = this.collectionUpdateTimeouts.get(collectionId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      if (!this.pendingCollectionUpdates.has(collectionId)) {
        this.pendingCollectionUpdates.set(collectionId, new Set());
      }
      this.pendingCollectionUpdates.get(collectionId)!.add(changedRecordId);

      const debounceTimeout = setTimeout(async () => {
        await this.processCollectionUpdates(collectionId);
      }, this.COLLECTION_UPDATE_DEBOUNCE_MS);
      this.collectionUpdateTimeouts.set(collectionId, debounceTimeout);

      if (!this.collectionMaxDelayTimeouts.has(collectionId)) {
        const maxDelayTimeout = setTimeout(async () => {
          await this.processCollectionUpdates(collectionId);
        }, this.COLLECTION_MAX_DELAY_MS);
        this.collectionMaxDelayTimeouts.set(collectionId, maxDelayTimeout);
      }
    }
  }

  /**
   * Processes batched collection updates for a specific collection.
   * Handles all pending record changes and sends appropriate updates to subscribers.
   *
   * @param {string} collectionId - The collection ID to process updates for.
   * @returns {Promise<void>}
   */
  private async processCollectionUpdates(collectionId: string): Promise<void> {
    const changedRecordIds = this.pendingCollectionUpdates.get(collectionId);
    if (!changedRecordIds || changedRecordIds.size === 0) return;

    const debounceTimeout = this.collectionUpdateTimeouts.get(collectionId);
    const maxDelayTimeout = this.collectionMaxDelayTimeouts.get(collectionId);

    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
      this.collectionUpdateTimeouts.delete(collectionId);
    }

    if (maxDelayTimeout) {
      clearTimeout(maxDelayTimeout);
      this.collectionMaxDelayTimeouts.delete(collectionId);
    }

    this.pendingCollectionUpdates.delete(collectionId);

    if (!this.collectionManager) return;

    const subscribers = this.collectionManager.getCollectionSubscriptions().get(collectionId);
    if (!subscribers || subscribers.size === 0) return;

    for (const [connectionId, { version: currentCollVersion }] of subscribers.entries()) {
      try {
        const connection = this.connectionManager.getLocalConnection(connectionId);
        if (!connection || connection.isDead) {
          continue;
        }

        const newRecords = await this.collectionManager.resolveCollection(collectionId, connection);
        const newRecordIds = newRecords.map((record) => record.id); // extract IDs from records
        const previousRecordIdsKey = `mesh:collection:${collectionId}:${connectionId}`;
        const previousRecordIdsStr = await this.pubClient.get(previousRecordIdsKey);
        const previousRecordIds = previousRecordIdsStr ? JSON.parse(previousRecordIdsStr) : [];

        const addedIds = newRecordIds.filter((id: string) => !previousRecordIds.includes(id));
        const added = newRecords.filter((record) => addedIds.includes(record.id)); // full records for added
        const removedIds = previousRecordIds.filter((id: string) => !newRecordIds.includes(id));

        // for removed items, try to get full records if they still exist, otherwise use IDs
        const removed = [];
        for (const removedId of removedIds) {
          try {
            const record = await this.recordManager.getRecord(removedId);
            removed.push(record || { id: removedId }); // use record if exists, otherwise just ID object
          } catch {
            removed.push({ id: removedId }); // fallback to ID object
          }
        }

        const deletedRecords = [];
        for (const recordId of changedRecordIds) {
          if (previousRecordIds.includes(recordId) && !newRecordIds.includes(recordId)) {
            deletedRecords.push(recordId);
          }
        }

        const changeAffectsMembership = added.length > 0 || removed.length > 0;
        const deletionAffectsExistingMember = deletedRecords.length > 0;

        if (changeAffectsMembership || deletionAffectsExistingMember) {
          const newCollectionVersion = currentCollVersion + 1;
          this.collectionManager.updateSubscriptionVersion(collectionId, connectionId, newCollectionVersion);

          await this.pubClient.set(previousRecordIdsKey, JSON.stringify(newRecordIds));

          connection.send({
            command: "mesh/collection-diff",
            payload: { collectionId, added, removed, version: newCollectionVersion },
          });
        }

        // send record updates for changed records that are still in the collection
        for (const recordId of changedRecordIds) {
          if (newRecordIds.includes(recordId)) {
            try {
              const { record, version } = await this.recordManager.getRecordAndVersion(recordId);
              if (record) {
                connection.send({
                  command: "mesh/record-update",
                  payload: { recordId, version, full: record },
                });
              }
            } catch (recordError) {
              serverLogger.info(`Record ${recordId} not found during collection update (likely deleted).`);
            }
          }
        }
      } catch (connError) {
        this.emitError(new Error(`Error processing collection ${collectionId} for connection ${connectionId}: ${connError}`));
      }
    }
  }

  /**
   * Gets the subscription promise
   *
   * @returns The subscription promise
   */
  getSubscriptionPromise(): Promise<void> {
    return this._subscriptionPromise;
  }

  /**
   * Gets the PubSub channel for an instance
   *
   * @param instanceId - The instance ID
   * @returns The PubSub channel name
   */
  getPubSubChannel(instanceId: string): string {
    return `${PUB_SUB_CHANNEL_PREFIX}${instanceId}`;
  }

  /**
   * Cleans up all pending timeouts and collections.
   * Call this when the PubSubManager is being destroyed.
   */
  cleanup(): void {
    for (const timeout of this.collectionUpdateTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.collectionUpdateTimeouts.clear();

    for (const timeout of this.collectionMaxDelayTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.collectionMaxDelayTimeouts.clear();

    this.pendingCollectionUpdates.clear();
  }
}
