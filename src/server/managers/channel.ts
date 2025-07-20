import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ChannelPattern } from "../types";
import { MessageStream } from "../persistence/message-stream";
import type { PersistedMessage } from "../persistence/types";
import type { PersistenceManager } from "./persistence";

export class ChannelManager {
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private exposedChannels: ChannelPattern[] = [];
  private channelGuards: Map<ChannelPattern, (connection: Connection, channel: string) => Promise<boolean> | boolean> = new Map();
  private channelSubscriptions: { [channel: string]: Set<Connection> } = {};
  private emitError: (error: Error) => void;
  private messageStream: MessageStream;
  private persistenceManager?: PersistenceManager;

  constructor(redis: Redis, pubClient: Redis, subClient: Redis, emitError: (error: Error) => void) {
    this.redis = redis;
    this.pubClient = pubClient;
    this.subClient = subClient;
    this.emitError = emitError;
    this.messageStream = MessageStream.getInstance();
  }

  /**
   * Set the persistence manager for this channel manager
   * @param manager The persistence manager to use
   */
  setPersistenceManager(manager: PersistenceManager): void {
    this.persistenceManager = manager;
  }

  /**
   * Exposes a channel for external access and optionally associates a guard function
   * to control access to that channel. The guard function determines whether a given
   * connection is permitted to access the channel.
   *
   * @param {ChannelPattern} channel - The channel or pattern to expose.
   * @param {(connection: Connection, channel: string) => Promise<boolean> | boolean} [guard] -
   *   Optional guard function that receives the connection and channel name, returning
   *   a boolean or a promise that resolves to a boolean indicating whether access is allowed.
   * @returns {void}
   */
  exposeChannel(channel: ChannelPattern, guard?: (connection: Connection, channel: string) => Promise<boolean> | boolean): void {
    this.exposedChannels.push(channel);
    if (guard) {
      this.channelGuards.set(channel, guard);
    }
  }

  /**
   * Checks if a channel is exposed and if the connection has access to it.
   *
   * @param channel - The channel to check
   * @param connection - The connection requesting access
   * @returns A promise that resolves to true if the channel is exposed and the connection has access
   */
  async isChannelExposed(channel: string, connection: Connection): Promise<boolean> {
    const matchedPattern = this.exposedChannels.find((pattern) => (typeof pattern === "string" ? pattern === channel : pattern.test(channel)));

    if (!matchedPattern) {
      return false;
    }

    const guard = this.channelGuards.get(matchedPattern);
    if (guard) {
      try {
        return await Promise.resolve(guard(connection, channel));
      } catch (e) {
        return false;
      }
    }

    return true;
  }

  /**
   * Publishes a message to a specified channel and optionally maintains a history of messages.
   *
   * @param {string} channel - The name of the channel to which the message will be published.
   * @param {any} message - The message to be published. Will not be stringified automatically for you. You need to do that yourself.
   * @param {number} [history=0] - The number of historical messages to retain for the channel. Defaults to 0, meaning no history is retained.
   *                               If greater than 0, the message will be added to the channel's history and the history will be trimmed to the specified size.
   *                               Messages are appended to the end of the history list using RPUSH.
   * @param {string} instanceId - The ID of the server instance.
   * @returns {Promise<void>} A Promise that resolves once the message has been published and, if applicable, the history has been updated.
   * @throws {Error} This function may throw an error if the underlying `pubClient` operations (e.g., `rpush`, `ltrim`, `publish`) fail.
   */
  async writeChannel(channel: string, message: any, history: number = 0, instanceId: string): Promise<void> {
    const parsedHistory = parseInt(history as any, 10);
    if (!isNaN(parsedHistory) && parsedHistory > 0) {
      await this.pubClient.rpush(`mesh:history:${channel}`, message);
      await this.pubClient.ltrim(`mesh:history:${channel}`, -parsedHistory, -1);
    }

    // publish to the message stream for persistence and other subscribers
    this.messageStream.publishMessage(channel, message, instanceId);

    await this.pubClient.publish(channel, message);
  }

  /**
   * Subscribes a connection to a channel
   *
   * @param channel - The channel to subscribe to
   * @param connection - The connection to subscribe
   */
  addSubscription(channel: string, connection: Connection): void {
    if (!this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel] = new Set();
    }
    this.channelSubscriptions[channel].add(connection);
  }

  /**
   * Unsubscribes a connection from a channel
   *
   * @param channel - The channel to unsubscribe from
   * @param connection - The connection to unsubscribe
   * @returns true if the connection was subscribed and is now unsubscribed, false otherwise
   */
  removeSubscription(channel: string, connection: Connection): boolean {
    if (this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel].delete(connection);
      if (this.channelSubscriptions[channel].size === 0) {
        delete this.channelSubscriptions[channel];
      }
      return true;
    }
    return false;
  }

  /**
   * Gets all subscribers for a channel
   *
   * @param channel - The channel to get subscribers for
   * @returns A set of connections subscribed to the channel, or undefined if none
   */
  getSubscribers(channel: string): Set<Connection> | undefined {
    return this.channelSubscriptions[channel];
  }

  /**
   * Subscribes to a Redis channel
   *
   * @param channel - The channel to subscribe to
   * @returns A promise that resolves when the subscription is complete
   */
  async subscribeToRedisChannel(channel: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.subClient.subscribe(channel, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Unsubscribes from a Redis channel
   *
   * @param channel - The channel to unsubscribe from
   * @returns A promise that resolves when the unsubscription is complete
   */
  async unsubscribeFromRedisChannel(channel: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.subClient.unsubscribe(channel, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Gets channel history from Redis or persistence
   *
   * @param channel - The channel to get history for
   * @param limit - The maximum number of history items to retrieve
   * @param since - Optional cursor (timestamp or message ID) to retrieve messages after
   * @returns A promise that resolves to an array of history items
   */
  async getChannelHistory(channel: string, limit: number, since?: string | number): Promise<string[]> {
    // if persistence is enabled for this channel and we have a since parameter,
    // use the persistence system to get the history
    if (this.persistenceManager && since !== undefined) {
      try {
        const messages = await this.persistenceManager.getMessages(channel, since, limit);
        return messages.map((msg: PersistedMessage) => msg.message);
      } catch (err) {
        // if persistence fails or isn't enabled for this channel, fall back to Redis
        const historyKey = `mesh:history:${channel}`;
        return this.redis.lrange(historyKey, 0, limit - 1);
      }
    }

    const historyKey = `mesh:history:${channel}`;
    return this.redis.lrange(historyKey, 0, limit - 1);
  }

  /**
   * Get persisted messages for a channel with full metadata
   * @param channel Channel to get messages for
   * @param since Optional cursor (timestamp or message ID) to retrieve messages after
   * @param limit Maximum number of messages to retrieve
   */
  async getPersistedMessages(channel: string, since?: string | number, limit?: number): Promise<PersistedMessage[]> {
    if (!this.persistenceManager) {
      throw new Error("Persistence not enabled");
    }

    return this.persistenceManager.getMessages(channel, since, limit);
  }

  /**
   * Cleans up all subscriptions for a connection
   *
   * @param connection - The connection to clean up
   */
  cleanupConnection(connection: Connection): void {
    for (const channel in this.channelSubscriptions) {
      this.removeSubscription(channel, connection);
    }
  }
}
