import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { ChannelPattern } from "../types";

export class ChannelManager {
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private exposedChannels: ChannelPattern[] = [];
  private channelGuards: Map<
    ChannelPattern,
    (connection: Connection, channel: string) => Promise<boolean> | boolean
  > = new Map();
  private channelSubscriptions: { [channel: string]: Set<Connection> } = {};
  private emitError: (error: Error) => void;

  constructor(
    redis: Redis,
    pubClient: Redis,
    subClient: Redis,
    emitError: (error: Error) => void
  ) {
    this.redis = redis;
    this.pubClient = pubClient;
    this.subClient = subClient;
    this.emitError = emitError;
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
  exposeChannel(
    channel: ChannelPattern,
    guard?: (
      connection: Connection,
      channel: string
    ) => Promise<boolean> | boolean
  ): void {
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
  async isChannelExposed(
    channel: string,
    connection: Connection
  ): Promise<boolean> {
    const matchedPattern = this.exposedChannels.find((pattern) =>
      typeof pattern === "string" ? pattern === channel : pattern.test(channel)
    );

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
   * @returns {Promise<void>} A Promise that resolves once the message has been published and, if applicable, the history has been updated.
   * @throws {Error} This function may throw an error if the underlying `pubClient` operations (e.g., `rpush`, `ltrim`, `publish`) fail.
   */
  async publishToChannel(
    channel: string,
    message: any,
    history: number = 0
  ): Promise<void> {
    const parsedHistory = parseInt(history as any, 10);
    if (!isNaN(parsedHistory) && parsedHistory > 0) {
      await this.pubClient.rpush(`mesh:history:${channel}`, message);
      await this.pubClient.ltrim(`mesh:history:${channel}`, -parsedHistory, -1);
    }
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
   * Gets channel history from Redis
   *
   * @param channel - The channel to get history for
   * @param limit - The maximum number of history items to retrieve
   * @returns A promise that resolves to an array of history items
   */
  async getChannelHistory(channel: string, limit: number): Promise<string[]> {
    const historyKey = `mesh:history:${channel}`;
    return this.redis.lrange(historyKey, 0, limit - 1);
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
