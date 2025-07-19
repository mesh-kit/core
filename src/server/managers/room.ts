import Redis from "ioredis";
import type { Connection } from "../connection";
import { deepMerge, isObject } from "../../common/deep-merge";

export class RoomManager {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private roomKey(roomName: string) {
    return `mesh:room:${roomName}`;
  }

  private connectionsRoomKey(connectionId: string) {
    return `mesh:connection:${connectionId}:rooms`;
  }

  private roomMetadataKey(roomName: string) {
    return `mesh:roommeta:${roomName}`;
  }

  /**
   * Retrieves all connection IDs associated with the specified room.
   *
   * @param {string} roomName - The name of the room for which to fetch connection IDs.
   * @returns {Promise<string[]>} A promise that resolves to an array of connection IDs in the room.
   * @throws {Error} If there is an issue communicating with Redis or retrieving the data, the promise will be rejected with an error.
   */
  async getRoomConnectionIds(roomName: string): Promise<string[]> {
    return this.redis.smembers(this.roomKey(roomName));
  }

  /**
   * Checks whether a given connection (by object or ID) is a member of a specified room.
   *
   * @param {string} roomName - The name of the room to check for membership.
   * @param {Connection | string} connection - The connection object or connection ID to check.
   * @returns {Promise<boolean>} A promise that resolves to true if the connection is in the room, false otherwise.
   * @throws {Error} If there is an issue communicating with Redis or processing the request, the promise may be rejected with an error.
   */
  async connectionIsInRoom(roomName: string, connection: Connection | string): Promise<boolean> {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    return !!(await this.redis.sismember(this.roomKey(roomName), connectionId));
  }

  /**
   * Adds a connection to a specified room, associating the connection ID with the room name
   * in Redis. Supports both `Connection` objects and connection IDs as strings.
   *
   * @param {string} roomName - The name of the room to add the connection to.
   * @param {Connection | string} connection - The connection object or connection ID to add to the room.
   * @returns {Promise<void>} A promise that resolves when the operation is complete.
   * @throws {Error} If an error occurs while updating Redis, the promise will be rejected with the error.
   */
  async addToRoom(roomName: string, connection: Connection | string): Promise<void> {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    await this.redis.sadd(this.roomKey(roomName), connectionId);
    await this.redis.sadd(this.connectionsRoomKey(connectionId), roomName);
  }

  /**
   * Retrieves a list of rooms that the specified connection is currently a member of.
   *
   * @param {Connection | string} connection - The connection object or connection ID for which to retrieve room memberships.
   * @returns {Promise<string[]>} A promise that resolves to an array of room names associated with the connection.
   * @throws {Error} If the underlying Redis operation fails, the promise will be rejected with an error.
   */
  async getRoomsForConnection(connection: Connection | string): Promise<string[]> {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    return await this.redis.smembers(this.connectionsRoomKey(connectionId));
  }

  /**
   * Retrieves all room names from Redis.
   *
   * @returns {Promise<string[]>} A promise that resolves to an array of all room names.
   * @throws {Error} If there is an issue communicating with Redis, the promise will be rejected with an error.
   */
  async getAllRooms(): Promise<string[]> {
    const keys = await this.redis.keys("mesh:room:*");
    return keys.map((key) => key.replace("mesh:room:", ""));
  }

  /**
   * Removes a connection from a specified room and updates Redis accordingly.
   * Accepts either a Connection object or a string representing the connection ID.
   * Updates both the room's set of connections and the connection's set of rooms in Redis.
   *
   * @param {string} roomName - The name of the room from which to remove the connection.
   * @param {Connection | string} connection - The connection to be removed, specified as either a Connection object or a connection ID string.
   * @returns {Promise<void>} A promise that resolves when the removal is complete.
   * @throws {Error} If there is an error executing the Redis pipeline, the promise will be rejected with the error.
   */
  async removeFromRoom(roomName: string, connection: Connection | string): Promise<void> {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    const pipeline = this.redis.pipeline();
    pipeline.srem(this.roomKey(roomName), connectionId);
    pipeline.srem(this.connectionsRoomKey(connectionId), roomName);
    await pipeline.exec();
  }

  /**
   * Removes the specified connection from all rooms it is a member of and deletes its room membership record.
   *
   * @param {Connection | string} connection - The connection object or its unique identifier to be removed from all rooms.
   * @returns {Promise<void>} A promise that resolves once the removal from all rooms is complete.
   * @throws {Error} If an error occurs during Redis operations, the promise will be rejected with the error.
   */
  async removeFromAllRooms(connection: Connection | string) {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    const rooms = await this.redis.smembers(this.connectionsRoomKey(connectionId));
    const pipeline = this.redis.pipeline();
    for (const room of rooms) {
      pipeline.srem(this.roomKey(room), connectionId);
    }
    pipeline.del(this.connectionsRoomKey(connectionId));
    await pipeline.exec();
  }

  /**
   * Removes all connections from the specified room but preserves room metadata.
   * This clears the room occupants without destroying the room's configuration.
   *
   * @param {string} roomName - The name of the room to be cleared of occupants.
   * @returns {Promise<void>} A promise that resolves when all occupants have been removed from the room.
   * @throws {Error} If an error occurs while interacting with Redis, the promise will be rejected with the error.
   */
  async clearRoom(roomName: string) {
    const connectionIds = await this.getRoomConnectionIds(roomName);
    const pipeline = this.redis.pipeline();
    for (const connectionId of connectionIds) {
      pipeline.srem(this.connectionsRoomKey(connectionId), roomName);
    }
    pipeline.del(this.roomKey(roomName));
    await pipeline.exec();
  }

  /**
   * Completely deletes the specified room, removing all occupants and destroying
   * all associated room metadata. This permanently removes the room from the system.
   *
   * @param {string} roomName - The name of the room to be completely deleted.
   * @returns {Promise<void>} A promise that resolves when the room has been completely deleted.
   * @throws {Error} If an error occurs while interacting with Redis, the promise will be rejected with the error.
   */
  async deleteRoom(roomName: string) {
    const connectionIds = await this.getRoomConnectionIds(roomName);
    const pipeline = this.redis.pipeline();
    for (const connectionId of connectionIds) {
      pipeline.srem(this.connectionsRoomKey(connectionId), roomName);
    }
    pipeline.del(this.roomKey(roomName));
    pipeline.del(this.roomMetadataKey(roomName));
    await pipeline.exec();
  }

  /**
   * Cleans up all Redis references for a given connection by removing the connection
   * from all rooms it is associated with and deleting the connection's room key.
   *
   * @param {Connection} connection - The connection object whose references should be cleaned up.
   * @returns {Promise<void>} A promise that resolves when the cleanup is complete.
   * @throws {Error} If an error occurs while interacting with Redis, the promise will be rejected with the error.
   */
  async cleanupConnection(connection: Connection): Promise<void> {
    const rooms = await this.redis.smembers(this.connectionsRoomKey(connection.id));
    const pipeline = this.redis.pipeline();
    for (const room of rooms) {
      pipeline.srem(this.roomKey(room), connection.id);
    }
    pipeline.del(this.connectionsRoomKey(connection.id));
    await pipeline.exec();
  }

  /**
   * Sets the metadata for a given room by storing the serialized metadata
   * object in Redis under the room's metadata key.
   *
   * @param {string} roomName - The unique name of the room whose metadata is being set.
   * @param {any} metadata - The metadata object to associate with the room, or partial metadata when using merge strategy.
   * @param {{ strategy?: "replace" | "merge" | "deepMerge" }} [options] - Update options: strategy defaults to "replace" which replaces the entire metadata, "merge" merges with existing metadata properties, "deepMerge" recursively merges nested objects.
   * @returns {Promise<void>} A promise that resolves when the metadata has been successfully set.
   * @throws {Error} If an error occurs while storing metadata in Redis, the promise will be rejected with the error.
   */
  async setMetadata(roomName: string, metadata: any, options?: { strategy?: "replace" | "merge" | "deepMerge" }): Promise<void> {
    let finalMetadata: any;
    const strategy = options?.strategy || "replace";

    if (strategy === "replace") {
      finalMetadata = metadata;
    } else {
      const existingMetadata = await this.getMetadata(roomName);

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

    await this.redis.hset(this.roomMetadataKey(roomName), "data", JSON.stringify(finalMetadata));
  }

  /**
   * Retrieves and parses metadata associated with the specified room from Redis storage.
   *
   * @param {string} roomName - The name of the room whose metadata is to be retrieved.
   * @returns {Promise<any | null>} A promise that resolves to the parsed metadata object if found,
   * or null if no metadata exists for the given room.
   * @throws {SyntaxError} If the retrieved data is not valid JSON and cannot be parsed.
   * @throws {Error} If there is an issue communicating with Redis.
   */
  async getMetadata(roomName: string): Promise<any | null> {
    const data = await this.redis.hget(this.roomMetadataKey(roomName), "data");
    return data ? JSON.parse(data) : null;
  }

  /**
   * Retrieves and returns all room metadata stored in Redis.
   * Fetches all keys matching the pattern "mesh:roommeta:*", retrieves their "data" fields,
   * parses them as JSON, and returns an object mapping room names to their metadata.
   * Optionally filters the results based on the provided filter function.
   *
   * @param {Function} filterFn - Optional filter function that takes a room name and metadata,
   *                             and returns a boolean indicating whether to include the room.
   * @returns {Promise<{ [roomName: string]: any }>} A promise that resolves to an object mapping room names to their metadata.
   * @throws {SyntaxError} If the stored metadata cannot be parsed as JSON, an error is logged and the room is omitted from the result.
   */
  async getAllMetadata(filterFn?: (roomName: string, metadata: any) => boolean): Promise<{ [roomName: string]: any }> {
    const keys = await this.redis.keys("mesh:roommeta:*");
    const metadata: { [roomName: string]: any } = {};

    if (keys.length === 0) {
      return metadata;
    }

    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.hget(key, "data"));
    const results = await pipeline.exec();

    keys.forEach((key, index) => {
      const roomName = key.replace("mesh:roommeta:", "");
      const data = results?.[index]?.[1];
      if (data) {
        try {
          const parsedData = JSON.parse(data as string);
          if (!filterFn || filterFn(roomName, parsedData)) {
            metadata[roomName] = parsedData;
          }
        } catch (e) {
          console.error(`Failed to parse metadata for room ${roomName}:`, e);
        }
      }
    });

    return metadata;
  }
}
