import type Redis from "ioredis";
import type { Connection } from "../connection";
import type { RoomManager } from "./room";
import { deepMerge, isObject } from "../../common/deep-merge";

const CONNECTIONS_HASH_KEY = "mesh:connections";
const INSTANCE_CONNECTIONS_KEY_PREFIX = "mesh:connections:";

export class ConnectionManager {
  private redis: Redis;
  private instanceId: string;
  private localConnections: { [id: string]: Connection } = {};
  private roomManager: RoomManager;

  constructor(redis: Redis, instanceId: string, roomManager: RoomManager) {
    this.redis = redis;
    this.instanceId = instanceId;
    this.roomManager = roomManager;
  }

  getLocalConnections(): Connection[] {
    return Object.values(this.localConnections);
  }

  getLocalConnection(id: string): Connection | null {
    return this.localConnections[id] ?? null;
  }

  async registerConnection(connection: Connection): Promise<void> {
    this.localConnections[connection.id] = connection;

    const pipeline = this.redis.pipeline();
    pipeline.hset(CONNECTIONS_HASH_KEY, connection.id, this.instanceId);
    pipeline.sadd(this.getInstanceConnectionsKey(this.instanceId), connection.id);
    await pipeline.exec();
  }

  private getInstanceConnectionsKey(instanceId: string): string {
    return `${INSTANCE_CONNECTIONS_KEY_PREFIX}${instanceId}`;
  }

  private async deregisterConnection(connection: Connection): Promise<void> {
    const instanceId = await this.getInstanceIdForConnection(connection);
    if (!instanceId) {
      return;
    }

    const pipeline = this.redis.pipeline();
    pipeline.hdel(CONNECTIONS_HASH_KEY, connection.id);
    pipeline.srem(this.getInstanceConnectionsKey(instanceId), connection.id);
    await pipeline.exec();
  }

  private async getInstanceIdForConnection(connection: Connection): Promise<string | null> {
    return this.redis.hget(CONNECTIONS_HASH_KEY, connection.id);
  }

  async getInstanceIdsForConnections(connectionIds: string[]): Promise<{ [connectionId: string]: string | null }> {
    if (connectionIds.length === 0) {
      return {};
    }

    const instanceIds = await this.redis.hmget(CONNECTIONS_HASH_KEY, ...connectionIds);
    const result: { [connectionId: string]: string | null } = {};

    connectionIds.forEach((id, index) => {
      result[id] = instanceIds[index] ?? null;
    });

    return result;
  }

  async getAllConnectionIds(): Promise<string[]> {
    return this.redis.hkeys(CONNECTIONS_HASH_KEY);
  }

  async getLocalConnectionIds(): Promise<string[]> {
    return this.redis.smembers(this.getInstanceConnectionsKey(this.instanceId));
  }

  /**
   * Sets metadata for a given connection in the Redis hash.
   * Serializes the metadata as a JSON string and stores it under the connection's ID.
   *
   * @param {Connection} connection - The connection object whose metadata is being set.
   * @param {any} metadata - The metadata to associate with the connection, or partial metadata when using merge strategy.
   * @param {{ strategy?: "replace" | "merge" | "deepMerge" }} [options] - Update options: strategy defaults to "replace" which replaces the entire metadata, "merge" merges with existing metadata properties, "deepMerge" recursively merges nested objects.
   * @returns {Promise<void>} A promise that resolves when the metadata has been successfully set.
   * @throws {Error} If an error occurs while executing the Redis pipeline.
   */
  async setMetadata(connection: Connection, metadata: any, options?: { strategy?: "replace" | "merge" | "deepMerge" }) {
    let finalMetadata: any;
    const strategy = options?.strategy || "replace";

    if (strategy === "replace") {
      finalMetadata = metadata;
    } else {
      const existingMetadata = await this.getMetadata(connection);

      if (strategy === "merge") {
        if (isObject(existingMetadata) && isObject(metadata)) {
          finalMetadata = { ...existingMetadata, ...metadata };
        } else {
          finalMetadata = metadata;
        }
      } else if (strategy === "deepMerge") {
        if (isObject(existingMetadata) && isObject(metadata)) {
          finalMetadata = deepMerge(existingMetadata, metadata);
        } else {
          finalMetadata = metadata;
        }
      }
    }

    const pipeline = this.redis.pipeline();
    pipeline.hset(CONNECTIONS_HASH_KEY, connection.id, JSON.stringify(finalMetadata));
    await pipeline.exec();
  }

  /**
   * Retrieves and parses metadata for the given connection from Redis.
   *
   * @param {Connection} connection - The connection object whose metadata is to be retrieved.
   * @returns {Promise<any|null>} A promise that resolves to the parsed metadata object if found, or null if no metadata exists.
   * @throws {SyntaxError} If the stored metadata is not valid JSON and fails to parse.
   * @throws {Error} If a Redis error occurs during retrieval.
   */
  async getMetadata(connection: Connection) {
    const metadata = await this.redis.hget(CONNECTIONS_HASH_KEY, connection.id);
    return metadata ? JSON.parse(metadata) : null;
  }

  /**
   * Retrieves metadata for all available connections by fetching all connection IDs,
   * obtaining their associated metadata, and parsing the metadata as JSON.
   *
   * @returns {Promise<Array<{ id: string, metadata: any }>>}
   *   A promise that resolves to an array of connection objects with id and metadata properties.
   * @throws {Error} If an error occurs while fetching connection IDs, retrieving metadata, or parsing JSON.
   */
  async getAllMetadata(): Promise<Array<{ id: string; metadata: any }>> {
    const connectionIds = await this.getAllConnectionIds();
    const metadata = await this.getInstanceIdsForConnections(connectionIds);
    const result: Array<{ id: string; metadata: any }> = [];

    connectionIds.forEach((id) => {
      try {
        const parsedMetadata = metadata[id] ? JSON.parse(metadata[id]) : null;
        result.push({ id, metadata: parsedMetadata });
      } catch (e) {
        console.error(`Failed to parse metadata for connection ${id}:`, e);
        result.push({ id, metadata: null });
      }
    });

    return result;
  }

  /**
   * Retrieves all metadata objects for each connection in the specified room.
   * Returns an array of connection objects with id and metadata properties.
   * If no metadata is found for a connection, the metadata value is set to null.
   *
   * @param {string} roomName - The name of the room for which to retrieve connection metadata.
   * @returns {Promise<Array<{ id: string, metadata: any }>>} A promise that resolves to an array of
   * connection objects with id and metadata properties (metadata is null if not available).
   * @throws {Error} If there is an error retrieving connection IDs or metadata, the promise will be rejected with the error.
   */
  async getAllMetadataForRoom(roomName: string): Promise<Array<{ id: string; metadata: any }>> {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName);
    const metadata = await this.getInstanceIdsForConnections(connectionIds);
    const result: Array<{ id: string; metadata: any }> = [];

    connectionIds.forEach((id) => {
      try {
        const parsedMetadata = metadata[id] ? JSON.parse(metadata[id]) : null;
        result.push({ id, metadata: parsedMetadata });
      } catch (e) {
        console.error(`Failed to parse metadata for connection ${id}:`, e);
        result.push({ id, metadata: null });
      }
    });

    return result;
  }

  async cleanupConnection(connection: Connection): Promise<void> {
    await this.deregisterConnection(connection);
  }
}
