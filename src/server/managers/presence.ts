import type { Redis } from "ioredis";
import type { Connection } from "../connection";
import type { RoomManager } from "./room";
import type { RedisManager } from "./redis";

type ChannelPattern = string | RegExp;

export class PresenceManager {
  private redis: Redis;
  private roomManager: RoomManager;
  private redisManager: RedisManager;
  private presenceExpirationEventsEnabled: boolean;

  private getExpiredEventsPattern(): string {
    const dbIndex = (this.redis as any).options?.db ?? 0;
    return `__keyevent@${dbIndex}__:expired`;
  }

  private readonly PRESENCE_KEY_PATTERN = /^mesh:presence:room:(.+):conn:(.+)$/;
  private readonly PRESENCE_STATE_KEY_PATTERN =
    /^mesh:presence:state:(.+):conn:(.+)$/;
  private trackedRooms: ChannelPattern[] = [];
  private roomGuards: Map<
    ChannelPattern,
    (connection: Connection, roomName: string) => Promise<boolean> | boolean
  > = new Map();
  private roomTTLs: Map<ChannelPattern, number> = new Map();
  private defaultTTL = 120_000; // seconds

  constructor(
    redis: Redis,
    roomManager: RoomManager,
    redisManager: RedisManager,
    enableExpirationEvents: boolean = true
  ) {
    this.redis = redis;
    this.roomManager = roomManager;
    this.redisManager = redisManager;
    this.presenceExpirationEventsEnabled = enableExpirationEvents;

    if (this.presenceExpirationEventsEnabled) {
      this.subscribeToExpirationEvents();
    }
  }

  /**
   * Subscribes to Redis keyspace notifications for expired presence keys
   */
  private subscribeToExpirationEvents(): void {
    const { subClient } = this.redisManager;
    const pattern = this.getExpiredEventsPattern();
    subClient.psubscribe(pattern);

    subClient.on("pmessage", (pattern, channel, key) => {
      if (
        this.PRESENCE_KEY_PATTERN.test(key) ||
        this.PRESENCE_STATE_KEY_PATTERN.test(key)
      ) {
        this.handleExpiredKey(key);
      }
    });
  }

  /**
   * Handles an expired key notification
   */
  private async handleExpiredKey(key: string): Promise<void> {
    try {
      // Check if it's a presence key
      let match = key.match(this.PRESENCE_KEY_PATTERN);
      if (match && match[1] && match[2]) {
        const roomName = match[1];
        const connectionId = match[2];
        await this.markOffline(connectionId, roomName);
        return;
      }

      // Check if it's a presence state key
      match = key.match(this.PRESENCE_STATE_KEY_PATTERN);
      if (match && match[1] && match[2]) {
        const roomName = match[1];
        const connectionId = match[2];
        await this.publishPresenceStateUpdate(roomName, connectionId, null);
      }
    } catch (err) {
      console.error("[PresenceManager] Failed to handle expired key:", err);
    }
  }

  trackRoom(
    roomPattern: ChannelPattern,
    guardOrOptions?:
      | ((
          connection: Connection,
          roomName: string
        ) => Promise<boolean> | boolean)
      | {
          ttl?: number;
          guard?: (
            connection: Connection,
            roomName: string
          ) => Promise<boolean> | boolean;
        }
  ): void {
    this.trackedRooms.push(roomPattern);

    if (typeof guardOrOptions === "function") {
      this.roomGuards.set(roomPattern, guardOrOptions);
    } else if (guardOrOptions && typeof guardOrOptions === "object") {
      if (guardOrOptions.guard) {
        this.roomGuards.set(roomPattern, guardOrOptions.guard);
      }

      if (guardOrOptions.ttl && typeof guardOrOptions.ttl === "number") {
        this.roomTTLs.set(roomPattern, guardOrOptions.ttl);
      }
    }
  }

  async isRoomTracked(
    roomName: string,
    connection?: Connection
  ): Promise<boolean> {
    const matchedPattern = this.trackedRooms.find((pattern) =>
      typeof pattern === "string"
        ? pattern === roomName
        : pattern.test(roomName)
    );

    if (!matchedPattern) {
      return false;
    }

    if (connection) {
      const guard = this.roomGuards.get(matchedPattern);
      if (guard) {
        try {
          return await Promise.resolve(guard(connection, roomName));
        } catch (e) {
          return false;
        }
      }
    }

    return true;
  }

  getRoomTTL(roomName: string): number {
    const matchedPattern = this.trackedRooms.find((pattern) =>
      typeof pattern === "string"
        ? pattern === roomName
        : pattern.test(roomName)
    );

    if (matchedPattern) {
      const ttl = this.roomTTLs.get(matchedPattern);
      if (ttl !== undefined) {
        return ttl;
      }
    }

    return this.defaultTTL;
  }

  private presenceRoomKey(roomName: string): string {
    return `mesh:presence:room:${roomName}`;
  }

  private presenceConnectionKey(
    roomName: string,
    connectionId: string
  ): string {
    return `mesh:presence:room:${roomName}:conn:${connectionId}`;
  }

  private presenceStateKey(roomName: string, connectionId: string): string {
    return `mesh:presence:state:${roomName}:conn:${connectionId}`;
  }

  async markOnline(connectionId: string, roomName: string): Promise<void> {
    const roomKey = this.presenceRoomKey(roomName);
    const connKey = this.presenceConnectionKey(roomName, connectionId);
    const ttl = this.getRoomTTL(roomName);

    const pipeline = this.redis.pipeline();
    pipeline.sadd(roomKey, connectionId);
    const ttlSeconds = Math.max(1, Math.floor(ttl / 1000));
    pipeline.set(connKey, "", "EX", ttlSeconds);
    await pipeline.exec();

    await this.publishPresenceUpdate(roomName, connectionId, "join");
  }

  async markOffline(connectionId: string, roomName: string): Promise<void> {
    const roomKey = this.presenceRoomKey(roomName);
    const connKey = this.presenceConnectionKey(roomName, connectionId);
    const stateKey = this.presenceStateKey(roomName, connectionId);

    const pipeline = this.redis.pipeline();
    pipeline.srem(roomKey, connectionId);
    pipeline.del(connKey);
    pipeline.del(stateKey);
    await pipeline.exec();

    await this.publishPresenceUpdate(roomName, connectionId, "leave");
  }

  async refreshPresence(connectionId: string, roomName: string): Promise<void> {
    const connKey = this.presenceConnectionKey(roomName, connectionId);
    const ttl = this.getRoomTTL(roomName);
    const ttlSeconds = Math.max(1, Math.floor(ttl / 1000));
    await this.redis.set(connKey, "", "EX", ttlSeconds);
  }

  async getPresentConnections(roomName: string): Promise<string[]> {
    return this.redis.smembers(this.presenceRoomKey(roomName));
  }

  private async publishPresenceUpdate(
    roomName: string,
    connectionId: string,
    type: "join" | "leave"
  ): Promise<void> {
    const channel = `mesh:presence:updates:${roomName}`;
    const message = JSON.stringify({
      type,
      connectionId,
      roomName,
      timestamp: Date.now(),
    });

    await this.redis.publish(channel, message);
  }

  /**
   * Publishes a presence state for a connection in a room
   *
   * @param connectionId The ID of the connection
   * @param roomName The name of the room
   * @param state The state object to publish
   * @param expireAfter Optional TTL in milliseconds
   */
  async publishPresenceState(
    connectionId: string,
    roomName: string,
    state: Record<string, any>,
    expireAfter?: number,
    silent?: boolean
  ): Promise<void> {
    const key = this.presenceStateKey(roomName, connectionId);
    const value = JSON.stringify(state);

    const pipeline = this.redis.pipeline();

    if (expireAfter && expireAfter > 0) {
      pipeline.set(key, value, "PX", expireAfter);
    } else {
      pipeline.set(key, value);
    }

    await pipeline.exec();

    if (silent) return;

    await this.publishPresenceStateUpdate(roomName, connectionId, state);
  }

  /**
   * Clears the presence state for a connection in a room
   *
   * @param connectionId The ID of the connection
   * @param roomName The name of the room
   */
  async clearPresenceState(
    connectionId: string,
    roomName: string
  ): Promise<void> {
    const key = this.presenceStateKey(roomName, connectionId);
    await this.redis.del(key);
    await this.publishPresenceStateUpdate(roomName, connectionId, null);
  }

  /**
   * Gets the current presence state for a connection in a room
   *
   * @param connectionId The ID of the connection
   * @param roomName The name of the room
   * @returns The presence state or null if not found
   */
  async getPresenceState(
    connectionId: string,
    roomName: string
  ): Promise<Record<string, any> | null> {
    const key = this.presenceStateKey(roomName, connectionId);
    const value = await this.redis.get(key);

    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(`[PresenceManager] Failed to parse presence state: ${e}`);
      return null;
    }
  }

  /**
   * Gets all presence states for a room
   *
   * @param roomName The name of the room
   * @returns A map of connection IDs to their presence states
   */
  async getAllPresenceStates(
    roomName: string
  ): Promise<Map<string, Record<string, any>>> {
    const result = new Map<string, Record<string, any>>();
    const connections = await this.getPresentConnections(roomName);

    if (connections.length === 0) {
      return result;
    }

    const pipeline = this.redis.pipeline();

    for (const connectionId of connections) {
      pipeline.get(this.presenceStateKey(roomName, connectionId));
    }

    const responses = await pipeline.exec();

    if (!responses) {
      return result;
    }

    for (let i = 0; i < connections.length; i++) {
      const connectionId = connections[i];
      if (!connectionId) continue;

      const [err, value] = responses[i] || [];

      if (err || !value) {
        continue;
      }

      try {
        const state = JSON.parse(value as string);
        result.set(connectionId, state);
      } catch (e) {
        console.error(`[PresenceManager] Failed to parse presence state: ${e}`);
      }
    }

    return result;
  }

  /**
   * Publishes a presence state update to Redis
   *
   * @param roomName The name of the room
   * @param connectionId The ID of the connection
   * @param state The state object or null
   */
  private async publishPresenceStateUpdate(
    roomName: string,
    connectionId: string,
    state: Record<string, any> | null
  ): Promise<void> {
    const channel = `mesh:presence:updates:${roomName}`;
    const message = JSON.stringify({
      type: "state",
      connectionId,
      roomName,
      state,
      timestamp: Date.now(),
    });

    await this.redis.publish(channel, message);
  }

  async cleanupConnection(connection: Connection): Promise<void> {
    const connectionId = connection.id;
    const rooms = await this.roomManager.getRoomsForConnection(connectionId);

    for (const roomName of rooms) {
      if (await this.isRoomTracked(roomName)) {
        await this.markOffline(connectionId, roomName);
      }
    }
  }
}
