import type { Redis } from "ioredis";

export class InstanceManager {
  private redis: Redis;
  private instanceId: string;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Time-to-live for the instance heartbeat in seconds.
   * If an instance fails to update its heartbeat within this time, it will be considered dead.
   * This should be at least 2-3 times the heartbeatFrequency to allow for temporary network issues.
   */
  private heartbeatTTL = 120; // seconds

  /**
   * How often to update the instance heartbeat in milliseconds.
   * This should be frequent enough to ensure the heartbeat doesn't expire during normal operation,
   * but not so frequent that it creates excessive Redis traffic.
   */
  private heartbeatFrequency = 15000; // milliseconds

  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * How often to check for and clean up dead instances in milliseconds.
   * This determines how quickly stale connections will be removed after an instance dies.
   * A balance between responsiveness and system load.
   */
  private cleanupFrequency = 60000; // milliseconds

  /**
   * Time-to-live for the cleanup lock in seconds.
   * This prevents multiple instances from cleaning up the same connections simultaneously.
   * Should be long enough to complete cleanup but short enough to recover if the cleaning instance fails.
   */
  private cleanupLockTTL = 10; // seconds

  constructor(redis: Redis, instanceId: string) {
    this.redis = redis;
    this.instanceId = instanceId;
  }

  async start(): Promise<void> {
    await this.registerInstance();
    await this.updateHeartbeat();

    this.heartbeatInterval = setInterval(
      () => this.updateHeartbeat(),
      this.heartbeatFrequency
    );

    this.cleanupInterval = setInterval(
      () => this.performCleanup(),
      this.cleanupFrequency
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    await this.deregisterInstance();
  }

  private async registerInstance(): Promise<void> {
    await this.redis.sadd("mesh:instances", this.instanceId);
  }

  private async deregisterInstance(): Promise<void> {
    await this.redis.srem("mesh:instances", this.instanceId);
    await this.redis.del(this.getHeartbeatKey());
  }

  /**
   * Updates the instance heartbeat in Redis with the current timestamp.
   * Sets a TTL on the key so it will automatically expire if not refreshed.
   */
  private async updateHeartbeat(): Promise<void> {
    const key = this.getHeartbeatKey();
    await this.redis.set(key, Date.now().toString(), "EX", this.heartbeatTTL);
  }

  private getHeartbeatKey(): string {
    return `mesh:instance:${this.instanceId}:heartbeat`;
  }

  /**
   * Attempts to acquire a distributed lock for cleanup operations.
   * Uses Redis SET with NX (only set if not exists) and EX (expiry) options.
   * Returns true if the lock was acquired, false otherwise.
   */
  private async acquireCleanupLock(): Promise<boolean> {
    const lockKey = "mesh:cleanup:lock";
    const result = await this.redis.set(
      lockKey,
      this.instanceId,
      "EX",
      this.cleanupLockTTL,
      "NX"
    );
    return result === "OK";
  }

  private async releaseCleanupLock(): Promise<void> {
    const lockKey = "mesh:cleanup:lock";
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, lockKey, this.instanceId);
  }

  /**
   * Performs the cleanup of dead instances and their connections.
   * This is run periodically on each server instance.
   * Only one instance will perform cleanup at a time due to the distributed lock.
   */
  private async performCleanup(): Promise<void> {
    try {
      const lockAcquired = await this.acquireCleanupLock();
      if (!lockAcquired) {
        // another instance is performing cleanup
        return;
      }

      // get all known, registered instances
      const registeredInstances = await this.redis.smembers("mesh:instances");

      // get all instance IDs from the connections hash
      const allConnections = await this.redis.hgetall("mesh:connections");

      // merge these, because an instance may no longer exist, but still be referenced
      // by a connection that hasn't been cleaned up yet
      const instanceIds = new Set([
        ...registeredInstances,
        ...Object.values(allConnections),
      ]);

      for (const instanceId of instanceIds) {
        if (instanceId === this.instanceId) continue;

        const heartbeatKey = `mesh:instance:${instanceId}:heartbeat`;
        const heartbeat = await this.redis.get(heartbeatKey);

        // if no heartbeat or not in registered instances, consider it dead
        if (!heartbeat) {
          console.log(`Found dead instance: ${instanceId}`);
          await this.cleanupDeadInstance(instanceId);
        }
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    } finally {
      await this.releaseCleanupLock();
    }
  }

  /**
   * Cleans up all connections associated with a dead instance.
   * Removes the instance from the registry and deletes its connections set.
   * Also cleans up any connections in the global hash that belong to this instance.
   */
  async cleanupDeadInstance(instanceId: string): Promise<void> {
    try {
      const connectionsKey = `mesh:connections:${instanceId}`;
      const connections = await this.redis.smembers(connectionsKey);

      for (const connectionId of connections) {
        await this.cleanupConnection(connectionId);
      }

      // find and clean up any connections in the global hash that belong to this instance
      const allConnections = await this.redis.hgetall("mesh:connections");
      for (const [connectionId, connInstanceId] of Object.entries(
        allConnections
      )) {
        if (connInstanceId === instanceId) {
          await this.cleanupConnection(connectionId);
        }
      }

      await this.redis.srem("mesh:instances", instanceId);
      await this.redis.del(connectionsKey);

      console.log(`Cleaned up dead instance: ${instanceId}`);
    } catch (error) {
      console.error(`Error cleaning up instance ${instanceId}:`, error);
    }
  }

  /**
   * Cleans up a single stale connection by:
   * 1. Removing it from all rooms it was a member of
   * 2. Removing it from presence tracking in those rooms
   * 3. Deleting its room membership record
   * 4. Removing it from the connections hash
   */
  private async cleanupConnection(connectionId: string): Promise<void> {
    try {
      const roomsKey = `mesh:connection:${connectionId}:rooms`;
      const rooms = await this.redis.smembers(roomsKey);

      const pipeline = this.redis.pipeline();

      for (const room of rooms) {
        pipeline.srem(`mesh:room:${room}`, connectionId);
        pipeline.srem(`mesh:presence:room:${room}`, connectionId);
        pipeline.del(`mesh:presence:room:${room}:conn:${connectionId}`);
        pipeline.del(`mesh:presence:state:${room}:conn:${connectionId}`);
      }

      pipeline.del(roomsKey);
      pipeline.hdel("mesh:connections", connectionId);

      await pipeline.exec();

      console.log(`Cleaned up stale connection: ${connectionId}`);
    } catch (error) {
      console.error(`Error cleaning up connection ${connectionId}:`, error);
    }
  }
}
