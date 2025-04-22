import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ConnectionManager } from "./connection";
import type { PubSubMessagePayload, RecordUpdatePubSubPayload } from "../types";
import {
  PUB_SUB_CHANNEL_PREFIX,
  RECORD_PUB_SUB_CHANNEL,
} from "../utils/constants";

export class PubSubManager {
  private subClient: Redis;
  private instanceId: string;
  private connectionManager: ConnectionManager;
  private recordSubscriptions: Map<
    string, // recordId
    Map<string, "patch" | "full"> // connectionId -> mode
  >;
  private getChannelSubscriptions: (
    channel: string
  ) => Set<Connection> | undefined;
  private emitError: (error: Error) => void;
  private _subscriptionPromise!: Promise<void>;

  constructor(
    subClient: Redis,
    instanceId: string,
    connectionManager: ConnectionManager,
    recordSubscriptions: Map<string, Map<string, "patch" | "full">>,
    getChannelSubscriptions: (channel: string) => Set<Connection> | undefined,
    emitError: (error: Error) => void
  ) {
    this.subClient = subClient;
    this.instanceId = instanceId;
    this.connectionManager = connectionManager;
    this.recordSubscriptions = recordSubscriptions;
    this.getChannelSubscriptions = getChannelSubscriptions;
    this.emitError = emitError;
  }

  /**
   * Subscribes to the instance channel and sets up message handlers
   *
   * @returns A promise that resolves when the subscription is complete
   */
  subscribeToInstanceChannel(): Promise<void> {
    const channel = `${PUB_SUB_CHANNEL_PREFIX}${this.instanceId}`;

    this._subscriptionPromise = new Promise((resolve, reject) => {
      this.subClient.subscribe(channel, RECORD_PUB_SUB_CHANNEL);
      this.subClient.psubscribe("mesh:presence:updates:*", (err) => {
        if (err) {
          this.emitError(
            new Error(
              `Failed to subscribe to channels ${channel}, ${RECORD_PUB_SUB_CHANNEL}:`,
              { cause: err }
            )
          );
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
            this.emitError(
              new Error(`Failed to parse presence update: ${message}`)
            );
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

      if (
        !parsedMessage ||
        !Array.isArray(parsedMessage.targetConnectionIds) ||
        !parsedMessage.command ||
        typeof parsedMessage.command.command !== "string"
      ) {
        throw new Error("Invalid message format");
      }

      const { targetConnectionIds, command } = parsedMessage;

      targetConnectionIds.forEach((connectionId) => {
        const connection =
          this.connectionManager.getLocalConnection(connectionId);

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
      const { recordId, newValue, patch, version } = parsedMessage;

      if (!recordId || typeof version !== "number") {
        throw new Error("Invalid record update message format");
      }

      const subscribers = this.recordSubscriptions.get(recordId);

      if (!subscribers) {
        return;
      }

      subscribers.forEach((mode, connectionId) => {
        const connection =
          this.connectionManager.getLocalConnection(connectionId);
        if (connection && !connection.isDead) {
          if (mode === "patch" && patch) {
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
        } else if (!connection) {
          subscribers.delete(connectionId);
          if (subscribers.size === 0) {
            this.recordSubscriptions.delete(recordId);
          }
        }
      });
    } catch (err) {
      this.emitError(
        new Error(`Failed to parse record update message: ${message}`)
      );
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
