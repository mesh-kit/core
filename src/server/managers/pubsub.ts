import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ConnectionManager } from "./connection";
import type { PubSubMessagePayload, RecordUpdatePubSubPayload } from "../types";
import { PUB_SUB_CHANNEL_PREFIX, RECORD_PUB_SUB_CHANNEL } from "../utils/constants";
import type { CollectionManager } from "./collection";
import type { RecordManager } from "./record";
import type { Operation } from "fast-json-patch";
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
   * Handles a record change notification for collections.
   * Calculates diffs and sends record updates to relevant collection subscribers.
   *
   * @param {string} changedRecordId - The message, which is the ID of the record that has changed.
   * @returns {Promise<void>}
   */
  private async handleCollectionRecordChange(changedRecordId: string): Promise<void> {
    if (!this.collectionManager) return;

    let updatePayloadBase: { recordId: string; version: number; full?: any; patch?: Operation[] } | null = null;
    let recordExists = true;

    try {
      try {
        const { record: fullValue, version } = await this.recordManager.getRecordAndVersion(changedRecordId);
        updatePayloadBase = { recordId: changedRecordId, version, full: fullValue };
      } catch (error) {
        if (error instanceof Error && error.message.includes("Record not found")) {
          // record likely deleted
          recordExists = false;
          serverLogger.info(`Record ${changedRecordId} not found during collection change handling (likely deleted).`);
        } else {
          this.emitError(new Error(`Error fetching record ${changedRecordId} for collection update: ${error}`));
          return;
        }
      }

      // iterate through all collection subscriptions
      const collectionSubsMap = this.collectionManager.getCollectionSubscriptions();
      for (const [collectionId, subscribers] of collectionSubsMap.entries()) {
        if (subscribers.size === 0) continue;

        // for each subscriber of this collection
        for (const [connectionId, { version: currentCollVersion }] of subscribers.entries()) {
          try {
            const connection = this.connectionManager.getLocalConnection(connectionId);
            if (!connection || connection.isDead) {
              // should not be possible, because CollectionManager removes subscribers on client disconnect
              continue;
            }

            const newRecordIds = await this.collectionManager.resolveCollection(collectionId, connection);
            const previousRecordIdsKey = `mesh:collection:${collectionId}:${connectionId}`;
            const previousRecordIdsStr = await this.pubClient.get(previousRecordIdsKey);
            const previousRecordIds = previousRecordIdsStr ? JSON.parse(previousRecordIdsStr) : [];

            const added = newRecordIds.filter((id: string) => !previousRecordIds.includes(id));
            const removed = previousRecordIds.filter((id: string) => !newRecordIds.includes(id));

            let collectionVersionUpdated = false;
            let newCollectionVersion = currentCollVersion;

            // a diff occurs if membership changes OR if a member is deleted
            const changeAffectsMembership = added.length > 0 || removed.length > 0;
            // a deletion only triggers a diff if the deleted record *was* part of the previous set
            const deletionAffectsExistingMember = !recordExists && previousRecordIds.includes(changedRecordId);

            if (changeAffectsMembership || deletionAffectsExistingMember) {
              collectionVersionUpdated = true;
              newCollectionVersion = currentCollVersion + 1;
              subscribers.set(connectionId, { version: newCollectionVersion });
              await this.pubClient.set(previousRecordIdsKey, JSON.stringify(newRecordIds));

              connection.send({
                command: "mesh/collection-diff",
                payload: { collectionId, added, removed, version: newCollectionVersion },
              });
            }

            // send update if the record *still* exists and is currently part of this connection's view of the collection
            if (recordExists && updatePayloadBase && newRecordIds.includes(changedRecordId)) {
              connection.send({
                command: "mesh/record-update",
                // always send full record data for collections
                payload: { ...updatePayloadBase },
              });
            }
          } catch (connError) {
            this.emitError(
              new Error(`Error processing collection ${collectionId} for connection ${connectionId} (record change ${changedRecordId}): ${connError}`),
            );
          }
        }
      }
    } catch (error) {
      this.emitError(new Error(`Failed to handle collection record change for ${changedRecordId}: ${error}`));
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
}
