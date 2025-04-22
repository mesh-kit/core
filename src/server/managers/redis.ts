import { Redis, type RedisOptions } from "ioredis";

export class RedisManager {
  private _redis: Redis | null = null;
  private _pubClient: Redis | null = null;
  private _subClient: Redis | null = null;
  private _isShuttingDown = false;
  private _options: RedisOptions | null = null;

  /**
   * Initializes Redis connections with the provided options
   *
   * @param options - Redis connection options
   * @param onError - Error handler callback
   */
  initialize(options: RedisOptions, onError: (err: Error) => void): void {
    this._options = options;

    this._redis = new Redis({
      retryStrategy: (times: number) => {
        if (this._isShuttingDown) {
          return null;
        }

        if (times > 10) {
          return null;
        }

        return Math.min(1000 * Math.pow(2, times), 30000);
      },
      ...options,
    });

    this._redis.on("error", (err) => {
      onError(new Error(`Redis error: ${err}`));
    });

    this._pubClient = this._redis.duplicate();
    this._subClient = this._redis.duplicate();
  }

  /**
   * Gets the main Redis client
   *
   * @returns The Redis client
   * @throws Error if Redis is not initialized
   */
  get redis(): Redis {
    if (!this._redis) {
      throw new Error("Redis not initialized");
    }
    return this._redis;
  }

  /**
   * Gets the Redis client for publishing
   *
   * @returns The publishing Redis client
   * @throws Error if Redis is not initialized
   */
  get pubClient(): Redis {
    if (!this._pubClient) {
      throw new Error("Redis pub client not initialized");
    }
    return this._pubClient;
  }

  /**
   * Gets the Redis client for subscribing
   *
   * @returns The subscribing Redis client
   * @throws Error if Redis is not initialized
   */
  get subClient(): Redis {
    if (!this._subClient) {
      throw new Error("Redis sub client not initialized");
    }
    return this._subClient;
  }

  /**
   * Disconnects all Redis clients
   */
  disconnect(): void {
    this._isShuttingDown = true;

    if (this._pubClient) {
      this._pubClient.disconnect();
      this._pubClient = null;
    }

    if (this._subClient) {
      this._subClient.disconnect();
      this._subClient = null;
    }

    if (this._redis) {
      this._redis.disconnect();
      this._redis = null;
    }
  }

  /**
   * Checks if Redis is shutting down
   *
   * @returns true if Redis is shutting down, false otherwise
   */
  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Sets the shutting down state
   *
   * @param value - The new shutting down state
   */
  set isShuttingDown(value: boolean) {
    this._isShuttingDown = value;
  }

  /**
   * Enables Redis keyspace notifications for expired events by updating the
   * "notify-keyspace-events" configuration. Ensures that both keyevent ('E')
   * and expired event ('x') notifications are enabled. If they are not already
   * present, the method appends them to the current configuration.
   *
   * @returns {Promise<void>} A promise that resolves when the configuration has been updated.
   * @throws {Error} If the Redis CONFIG commands fail or the connection encounters an error.
   */
  async enableKeyspaceNotifications(): Promise<void> {
    const result = await this.redis.config("GET", "notify-keyspace-events");
    const currentConfig =
      Array.isArray(result) && result.length > 1 ? result[1] : "";

    // add expired events notification if not already enabled
    // 'E' enables keyevent notifications, 'x' enables expired events
    let newConfig = currentConfig || "";
    if (!newConfig.includes("E")) newConfig += "E";
    if (!newConfig.includes("x")) newConfig += "x";
    await this.redis.config("SET", "notify-keyspace-events", newConfig);
  }
}
