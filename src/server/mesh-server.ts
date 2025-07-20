import { IncomingMessage } from "node:http";
import { v4 as uuidv4 } from "uuid";
import { WebSocketServer } from "ws";
import { Status } from "../client";
import { parseCommand } from "../common/message";
import { Connection } from "./connection";
import { MeshContext } from "./mesh-context";
import { LogLevel, serverLogger } from "../common/logger";
import { ConnectionManager } from "./managers/connection";
import { PresenceManager } from "./managers/presence";
import { RecordManager } from "./managers/record";
import { RoomManager } from "./managers/room";
import { BroadcastManager } from "./managers/broadcast";
import { ChannelManager } from "./managers/channel";
import { CommandManager } from "./managers/command";
import { PubSubManager } from "./managers/pubsub";
import { RecordSubscriptionManager } from "./managers/record-subscription";
import { RedisManager } from "./managers/redis";
import { InstanceManager } from "./managers/instance";
import { CollectionManager } from "./managers/collection";
import type { ChannelPattern, MeshServerOptions, SocketMiddleware } from "./types";
import { PersistenceManager } from "./managers/persistence";
import type { RecordPersistenceOptions, ChannelPersistenceOptions } from "./persistence/types";
import { PUB_SUB_CHANNEL_PREFIX } from "./utils/constants";

export class MeshServer extends WebSocketServer {
  readonly instanceId: string;

  private redisManager: RedisManager;
  private instanceManager: InstanceManager;
  private commandManager: CommandManager;
  private channelManager: ChannelManager;
  private pubSubManager: PubSubManager;
  private recordSubscriptionManager: RecordSubscriptionManager;
  private collectionManager: CollectionManager;
  private broadcastManager: BroadcastManager;
  private persistenceManager: PersistenceManager | null = null;
  roomManager: RoomManager;
  recordManager: RecordManager;
  connectionManager: ConnectionManager;
  presenceManager: PresenceManager;

  serverOptions: MeshServerOptions;
  status: Status = Status.OFFLINE;
  private _listening = false;

  get listening(): boolean {
    return this._listening;
  }

  set listening(value: boolean) {
    this._listening = value;
    this.status = value ? Status.ONLINE : Status.OFFLINE;
  }

  constructor(opts: MeshServerOptions) {
    super(opts);

    this.instanceId = uuidv4();
    this.serverOptions = {
      ...opts,
      pingInterval: opts.pingInterval ?? 30_000,
      latencyInterval: opts.latencyInterval ?? 5_000,
      maxMissedPongs: opts.maxMissedPongs ?? 1,
      logLevel: opts.logLevel ?? LogLevel.ERROR,
    };

    serverLogger.configure({
      level: this.serverOptions.logLevel,
      styling: false,
    });

    this.redisManager = new RedisManager();
    this.redisManager.initialize(opts.redisOptions, (err) => this.emit("error", err));

    this.instanceManager = new InstanceManager(this.redisManager.redis, this.instanceId);

    this.roomManager = new RoomManager(this.redisManager.redis);
    this.recordManager = new RecordManager(this.redisManager.redis, this);
    this.connectionManager = new ConnectionManager(this.redisManager.pubClient, this.instanceId, this.roomManager);
    this.presenceManager = new PresenceManager(this.redisManager.redis, this.roomManager, this.redisManager, this.serverOptions.enablePresenceExpirationEvents);
    if (this.serverOptions.enablePresenceExpirationEvents) {
      this.redisManager.enableKeyspaceNotifications().catch((err) => this.emit("error", new Error(`Failed to enable keyspace notifications: ${err}`)));
    }
    this.commandManager = new CommandManager((err) => this.emit("error", err));

    this.persistenceManager = new PersistenceManager(this.serverOptions.persistenceOptions, this.serverOptions.persistenceAdapter);
    this.persistenceManager.initialize().catch((err) => {
      this.emit("error", new Error(`Failed to initialize persistence manager: ${err}`));
    });

    this.channelManager = new ChannelManager(this.redisManager.redis, this.redisManager.pubClient, this.redisManager.subClient, (err) =>
      this.emit("error", err),
    );

    this.channelManager.setPersistenceManager(this.persistenceManager);
    this.recordSubscriptionManager = new RecordSubscriptionManager(
      this.redisManager.pubClient,
      this.recordManager,
      (err) => this.emit("error", err),
      this.persistenceManager,
    );
    this.collectionManager = new CollectionManager(this.redisManager.redis, (err) => this.emit("error", err));

    if (this.persistenceManager) {
      this.persistenceManager.setRecordManager(this.recordManager);
    }

    this.recordManager.onRecordUpdate(async ({ recordId, value }) => {
      try {
        await this.collectionManager.publishRecordChange(recordId);
      } catch (error) {
        this.emit("error", new Error(`Failed to publish record update for collection check: ${error}`));
      }
    });

    this.recordManager.onRecordRemoved(async ({ recordId }) => {
      try {
        await this.collectionManager.publishRecordChange(recordId);
      } catch (error) {
        this.emit("error", new Error(`Failed to publish record removal for collection check: ${error}`));
      }
    });

    this.pubSubManager = new PubSubManager(
      this.redisManager.subClient,
      this.instanceId,
      this.connectionManager,
      this.recordManager,
      this.recordSubscriptionManager.getRecordSubscriptions(),
      this.channelManager.getSubscribers.bind(this.channelManager),
      (err) => this.emit("error", err),
      this.collectionManager,
      this.redisManager.pubClient,
    );

    this.broadcastManager = new BroadcastManager(
      this.connectionManager,
      this.roomManager,
      this.instanceId,
      this.redisManager.pubClient,
      (instanceId) => `${PUB_SUB_CHANNEL_PREFIX}${instanceId}`,
      (err) => this.emit("error", err),
    );

    this.on("listening", () => {
      this.listening = true;
      this.instanceManager.start();
    });

    this.on("error", (err) => {
      serverLogger.error(`Error: ${err}`);
    });

    this.on("close", () => {
      this.listening = false;
    });

    this.pubSubManager.subscribeToInstanceChannel();
    this.registerBuiltinCommands();
    this.registerRecordCommands();
    this.applyListeners();
  }

  /**
   * Waits until the service is ready by ensuring it is listening, the instance channel subscription is established,
   * and the persistence manager is fully initialized.
   *
   * @returns {Promise<void>} A promise that resolves when the service is fully ready.
   * @throws {Error} If the readiness process fails or if any awaited promise rejects.
   */
  async ready(): Promise<void> {
    const listeningPromise = this.listening ? Promise.resolve() : new Promise<void>((resolve) => this.once("listening", resolve));
    const persistencePromise = this.persistenceManager ? this.persistenceManager.ready() : Promise.resolve();

    await Promise.all([listeningPromise, this.pubSubManager.getSubscriptionPromise(), persistencePromise]);
  }

  private applyListeners() {
    this.on("connection", async (socket, req: IncomingMessage) => {
      const connection = new Connection(socket, req, this.serverOptions, this);

      connection.on("message", (buffer: Buffer) => {
        try {
          const data = buffer.toString();
          const command = parseCommand(data);

          if (command.id !== undefined && !["latency:response", "pong"].includes(command.command)) {
            this.commandManager.runCommand(command.id, command.command, command.payload, connection, this);
          }
        } catch (err) {
          this.emit("error", err);
        }
      });

      try {
        await this.connectionManager.registerConnection(connection);

        connection.send({
          command: "mesh/assign-id",
          payload: connection.id,
        });
      } catch (error) {
        connection.close();
        return;
      }

      this.emit("connected", connection);

      connection.on("close", async () => {
        await this.cleanupConnection(connection);
        this.emit("disconnected", connection);
      });

      connection.on("error", (err) => {
        this.emit("clientError", err, connection);
      });

      connection.on("pong", async (connectionId) => {
        try {
          const rooms = await this.roomManager.getRoomsForConnection(connectionId);
          for (const roomName of rooms) {
            if (await this.presenceManager.isRoomTracked(roomName)) {
              await this.presenceManager.refreshPresence(connectionId, roomName);
            }
          }
        } catch (err) {
          this.emit("error", new Error(`Failed to refresh presence: ${err}`));
        }
      });
    });
  }

  // #region Command Management

  /**
   * Registers a command with an associated callback and optional middleware.
   *
   * @template T The type for `MeshContext.payload`. Defaults to `any`.
   * @template U The command's return value type. Defaults to `any`.
   * @param {string} command - The unique identifier for the command to register.
   * @param {(context: MeshContext<T>) => Promise<U> | U} callback - The function to execute when the command is invoked. It receives a `MeshContext` of type `T` and may return a value of type `U` or a `Promise` resolving to `U`.
   * @param {SocketMiddleware[]} [middlewares=[]] - An optional array of middleware functions to apply to the command. Defaults to an empty array.
   * @throws {Error} May throw an error if the command registration or middleware addition fails.
   */
  exposeCommand<T = any, U = any>(command: string, callback: (context: MeshContext<T>) => Promise<U> | U, middlewares: SocketMiddleware[] = []) {
    this.commandManager.exposeCommand(command, callback, middlewares);
  }

  /**
   * Adds one or more middleware functions to the global middleware stack.
   *
   * @param {SocketMiddleware[]} middlewares - An array of middleware functions to be added. Each middleware
   *                                           is expected to conform to the `SocketMiddleware` type.
   * @returns {void}
   * @throws {Error} If the provided middlewares are not valid or fail validation (if applicable).
   */
  useMiddleware(...middlewares: SocketMiddleware[]): void {
    this.commandManager.useMiddleware(...middlewares);
  }

  /**
   * Adds an array of middleware functions to a specific command.
   *
   * @param {string} command - The name of the command to associate the middleware with.
   * @param {SocketMiddleware[]} middlewares - An array of middleware functions to be added to the command.
   * @returns {void}
   */
  useMiddlewareWithCommand(command: string, middlewares: SocketMiddleware[]): void {
    this.commandManager.useMiddlewareWithCommand(command, middlewares);
  }

  // #endregion

  // #region Channel Management

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
    this.channelManager.exposeChannel(channel, guard);
  }

  /**
   * Publishes a message to a specified channel and optionally maintains a history of messages.
   *
   * @param {string} channel - The name of the channel to which the message will be published.
   * @param {any} message - The message to be published. Will not be stringified automatically for you. You need to do that yourself.
   * @param {number} [history=0] - The number of historical messages to retain for the channel. Defaults to 0, meaning no history is retained.
   *                               If greater than 0, the message will be added to the channel's history and the history will be trimmed to the specified size.
   * @returns {Promise<void>} A Promise that resolves once the message has been published and, if applicable, the history has been updated.
   * @throws {Error} This function may throw an error if the underlying `pubClient` operations (e.g., `lpush`, `ltrim`, `publish`) fail.
   */
  async publishToChannel(channel: string, message: any, history: number = 0): Promise<void> {
    return this.channelManager.publishToChannel(channel, message, history, this.instanceId);
  }

  /**
   * Enables persistence for channels matching the specified pattern.
   *
   * @param {ChannelPattern} pattern - The channel pattern to enable persistence for.
   * @param {ChannelPersistenceOptions} [options] - Options for persistence.
   * @throws {Error} If persistence is not enabled for this server instance.
   */
  enableChannelPersistence(pattern: ChannelPattern, options: ChannelPersistenceOptions = {}): void {
    if (!this.persistenceManager) {
      throw new Error("Persistence not enabled. Initialize the persistence manager first.");
    }

    this.persistenceManager.enableChannelPersistence(pattern, options);
  }

  /**
   * Enables persistence for records matching the specified pattern.
   *
   * @param {ChannelPattern} pattern - The record ID pattern to enable persistence for.
   * @param {RecordPersistenceOptions} [options] - Options for persistence.
   * @throws {Error} If persistence is not enabled for this server instance.
   */
  enableRecordPersistence(pattern: ChannelPattern, options: RecordPersistenceOptions = {}): void {
    if (!this.persistenceManager) {
      throw new Error("Persistence not enabled. Initialize the persistence manager first.");
    }

    this.persistenceManager.enableRecordPersistence(pattern, options);
  }

  // #endregion

  // #region Record Management

  /**
   * Exposes a record or pattern for client subscriptions, optionally adding a guard function.
   *
   * @param {ChannelPattern} recordPattern - The record ID or pattern to expose.
   * @param {(connection: Connection, recordId: string) => Promise<boolean> | boolean} [guard] - Optional guard function.
   */
  exposeRecord(recordPattern: ChannelPattern, guard?: (connection: Connection, recordId: string) => Promise<boolean> | boolean): void {
    this.recordSubscriptionManager.exposeRecord(recordPattern, guard);
  }

  /**
   * Exposes a record or pattern for client writes, optionally adding a guard function.
   *
   * @param {ChannelPattern} recordPattern - The record ID or pattern to expose as writable.
   * @param {(connection: Connection, recordId: string) => Promise<boolean> | boolean} [guard] - Optional guard function.
   */
  exposeWritableRecord(recordPattern: ChannelPattern, guard?: (connection: Connection, recordId: string) => Promise<boolean> | boolean): void {
    this.recordSubscriptionManager.exposeWritableRecord(recordPattern, guard);
  }

  /**
   * Updates a record, persists it to Redis, increments its version, computes a patch,
   * and publishes the update via Redis pub/sub.
   *
   * @param {string} recordId - The ID of the record to update.
   * @param {any} newValue - The new value for the record, or partial value when using merge strategy.
   * @param {{ strategy?: "replace" | "merge" | "deepMerge" }} [options] - Update options: strategy defaults to "replace" which replaces the entire record, "merge" merges with existing object properties, "deepMerge" recursively merges nested objects.
   * @returns {Promise<void>}
   * @throws {Error} If the update fails.
   *
   * @example
   * // Replace strategy (default) - replaces entire record
   * await server.publishRecordUpdate("user:123", { name: "John", age: 30 });
   *
   * // Merge strategy - merges with existing record
   * // If record currently contains: { name: "old name", age: 30, city: "NYC" }
   * await server.publishRecordUpdate("user:123", { name: "new name" }, { strategy: "merge" });
   * // Result: { name: "new name", age: 30, city: "NYC" }
   *
   * // Deep merge strategy - recursively merges nested objects
   * // If record currently contains: { name: "John", profile: { age: 30, city: "NYC", preferences: { theme: "dark" } } }
   * await server.publishRecordUpdate("user:123", { profile: { age: 31 } }, { strategy: "deepMerge" });
   * // Result: { name: "John", profile: { age: 31, city: "NYC", preferences: { theme: "dark" } } }
   */
  async publishRecordUpdate(recordId: string, newValue: any, options?: { strategy?: "replace" | "merge" | "deepMerge" }): Promise<void> {
    return this.recordSubscriptionManager.publishRecordUpdate(recordId, newValue, options);
  }

  /**
   * Retrieves the value of a record by its ID.
   *
   * @param {string} recordId - The ID of the record to retrieve.
   * @returns {Promise<any>} A promise that resolves to the value of the record, or null if not found.
   */
  async getRecord(recordId: string): Promise<any> {
    return this.recordManager.getRecord(recordId);
  }

  async deleteRecord(recordId: string): Promise<void> {
    const result = await this.recordManager.deleteRecord(recordId);

    if (result) {
      await this.recordSubscriptionManager.publishRecordDeletion(recordId, result.version);
    }
  }

  /**
   * Lists and processes records matching a pattern. Designed for use in collection resolvers.
   * Returns transformed records that will be sent to subscribed clients.
   *
   * @param {string} pattern - Redis glob pattern to match record IDs against (e.g., "user:*", "post:?", "[abc]*").
   * @param {Object} [options] - Processing options.
   * @param {Function} [options.map] - Transform each record before sorting/slicing.
   * @param {Function} [options.sort] - Sort function for the records.
   * @param {Object} [options.slice] - Pagination slice.
   * @param {number} [options.slice.start] - Start index.
   * @param {number} [options.slice.count] - Number of records to return.
   * @returns {Promise<any[]>} The processed records to send to clients.
   */
  async listRecordsMatching(
    pattern: string,
    options?: {
      map?: (record: any) => any;
      sort?: (a: any, b: any) => number;
      slice?: { start: number; count: number };
    },
  ): Promise<any[]> {
    return this.collectionManager.listRecordsMatching(pattern, options);
  }

  // #endregion

  // #region Collection Management

  /**
   * Exposes a collection pattern for client subscriptions with a resolver function
   * that determines which records belong to the collection.
   *
   * @param {ChannelPattern} pattern - The collection ID or pattern to expose.
   * @param {(connection: Connection, collectionId: string) => Promise<any[]> | any[]} resolver -
   *        Function that resolves which records belong to the collection.
   */
  exposeCollection(pattern: ChannelPattern, resolver: (connection: Connection, collectionId: string) => Promise<any[]> | any[]): void {
    this.collectionManager.exposeCollection(pattern, resolver);
  }

  // #endregion

  // #region Room Management

  async isInRoom(roomName: string, connection: Connection | string) {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    return this.roomManager.connectionIsInRoom(roomName, connectionId);
  }

  async addToRoom(roomName: string, connection: Connection | string) {
    const connectionId = typeof connection === "string" ? connection : connection.id;
    await this.roomManager.addToRoom(roomName, connection);

    if (await this.presenceManager.isRoomTracked(roomName)) {
      await this.presenceManager.markOnline(connectionId, roomName);
    }
  }

  async removeFromRoom(roomName: string, connection: Connection | string) {
    const connectionId = typeof connection === "string" ? connection : connection.id;

    if (await this.presenceManager.isRoomTracked(roomName)) {
      await this.presenceManager.markOffline(connectionId, roomName);
    }

    return this.roomManager.removeFromRoom(roomName, connection);
  }

  async removeFromAllRooms(connection: Connection | string) {
    return this.roomManager.removeFromAllRooms(connection);
  }

  async clearRoom(roomName: string) {
    return this.roomManager.clearRoom(roomName);
  }

  async deleteRoom(roomName: string) {
    return this.roomManager.deleteRoom(roomName);
  }

  async getRoomMembers(roomName: string): Promise<string[]> {
    return this.roomManager.getRoomConnectionIds(roomName);
  }

  async getRoomMembersWithMetadata(roomName: string): Promise<Array<{ id: string; metadata: any }>> {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName);

    return Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          const connection = this.connectionManager.getLocalConnection(connectionId);
          let metadata;

          if (connection) {
            metadata = await this.connectionManager.getMetadata(connection);
          } else {
            const metadataString = await this.redisManager.redis.hget("mesh:connections", connectionId);
            metadata = metadataString ? JSON.parse(metadataString) : null;
          }

          return { id: connectionId, metadata };
        } catch (e) {
          return { id: connectionId, metadata: null };
        }
      }),
    );
  }

  async getAllRooms(): Promise<string[]> {
    return this.roomManager.getAllRooms();
  }

  // #endregion

  // #region Broadcasting

  /**
   * Broadcasts a command and payload to a set of connections or all available connections.
   *
   * @param {string} command - The command to be broadcasted.
   * @param {any} payload - The data associated with the command.
   * @param {Connection[]=} connections - (Optional) A specific list of connections to broadcast to. If not provided, the command will be sent to all connections.
   *
   * @throws {Error} Emits an "error" event if broadcasting fails.
   */
  async broadcast(command: string, payload: any, connections?: Connection[]) {
    return this.broadcastManager.broadcast(command, payload, connections);
  }

  /**
   * Broadcasts a command and associated payload to all active connections within the specified room.
   *
   * @param {string} roomName - The name of the room whose connections will receive the broadcast.
   * @param {string} command - The command to be broadcasted to the connections.
   * @param {unknown} payload - The data payload associated with the command.
   * @returns {Promise<void>} A promise that resolves when the broadcast operation is complete.
   * @throws {Error} If the broadcast operation fails, an error is thrown and the promise is rejected.
   */
  async broadcastRoom(roomName: string, command: string, payload: any): Promise<void> {
    return this.broadcastManager.broadcastRoom(roomName, command, payload);
  }

  /**
   * Broadcasts a command and payload to all active connections except for the specified one(s).
   * Excludes the provided connection(s) from receiving the broadcast.
   *
   * @param {string} command - The command to broadcast to connections.
   * @param {any} payload - The payload to send along with the command.
   * @param {Connection | Connection[]} exclude - A single connection or an array of connections to exclude from the broadcast.
   * @returns {Promise<void>} A promise that resolves when the broadcast is complete.
   * @emits {Error} Emits an "error" event if broadcasting the command fails.
   */
  async broadcastExclude(command: string, payload: any, exclude: Connection | Connection[]): Promise<void> {
    return this.broadcastManager.broadcastExclude(command, payload, exclude);
  }

  /**
   * Broadcasts a command with a payload to all connections in a specified room,
   * excluding one or more given connections. If the broadcast fails, emits an error event.
   *
   * @param {string} roomName - The name of the room to broadcast to.
   * @param {string} command - The command to broadcast.
   * @param {any} payload - The payload to send with the command.
   * @param {Connection | Connection[]} exclude - A connection or array of connections to exclude from the broadcast.
   * @returns {Promise<void>} A promise that resolves when the broadcast is complete.
   * @emits {Error} Emits an error event if broadcasting fails.
   */
  async broadcastRoomExclude(roomName: string, command: string, payload: any, exclude: Connection | Connection[]): Promise<void> {
    return this.broadcastManager.broadcastRoomExclude(roomName, command, payload, exclude);
  }

  // #endregion

  // #region Presence Management

  trackPresence(
    roomPattern: string | RegExp,
    guardOrOptions?:
      | ((connection: Connection, roomName: string) => Promise<boolean> | boolean)
      | {
          ttl?: number;
          guard?: (connection: Connection, roomName: string) => Promise<boolean> | boolean;
        },
  ): void {
    this.presenceManager.trackRoom(roomPattern, guardOrOptions);
  }

  // #endregion

  // #region Command Registration

  private registerBuiltinCommands() {
    // this no-op command is just for allowing clients to test their connection
    // after a period of inactivity
    this.exposeCommand("mesh/noop", async () => true);
    this.exposeCommand<{ channel: string; historyLimit?: number; since?: string | number }, { success: boolean; history?: string[] }>(
      "mesh/subscribe-channel",
      async (ctx) => {
        const { channel, historyLimit, since } = ctx.payload;

        if (!(await this.channelManager.isChannelExposed(channel, ctx.connection))) {
          return { success: false, history: [] };
        }

        try {
          if (!this.channelManager.getSubscribers(channel)) {
            await this.channelManager.subscribeToRedisChannel(channel);
          }
          this.channelManager.addSubscription(channel, ctx.connection);

          const history: string[] = historyLimit && historyLimit > 0 ? await this.channelManager.getChannelHistory(channel, historyLimit, since) : [];

          return {
            success: true,
            history,
          };
        } catch (e) {
          return { success: false, history: [] };
        }
      },
    );

    this.exposeCommand<{ channel: string }, boolean>("mesh/unsubscribe-channel", async (ctx) => {
      const { channel } = ctx.payload;
      const wasSubscribed = this.channelManager.removeSubscription(channel, ctx.connection);

      if (wasSubscribed && !this.channelManager.getSubscribers(channel)) {
        await this.channelManager.unsubscribeFromRedisChannel(channel);
      }

      return wasSubscribed;
    });

    this.exposeCommand<{ channel: string; limit?: number; since?: string | number }, { success: boolean; history: string[] }>(
      "mesh/get-channel-history",
      async (ctx) => {
        const { channel, limit, since } = ctx.payload;

        if (!(await this.channelManager.isChannelExposed(channel, ctx.connection))) {
          return { success: false, history: [] };
        }

        try {
          if (this.persistenceManager?.getChannelPersistenceOptions(channel)) {
            const messages = await this.persistenceManager.getMessages(
              channel,
              since,
              limit || this.persistenceManager.getChannelPersistenceOptions(channel)?.historyLimit,
            );

            return {
              success: true,
              history: messages.map((msg) => msg.message),
            };
          } else {
            const history = await this.channelManager.getChannelHistory(channel, limit || 50, since);

            return {
              success: true,
              history,
            };
          }
        } catch (e) {
          return { success: false, history: [] };
        }
      },
    );

    this.exposeCommand<{ roomName: string }, { success: boolean; present: Array<{ id: string; metadata: any }> }>("mesh/join-room", async (ctx) => {
      const { roomName } = ctx.payload;
      await this.addToRoom(roomName, ctx.connection);
      const present = await this.getRoomMembersWithMetadata(roomName);
      return { success: true, present };
    });

    this.exposeCommand<{ roomName: string }, { success: boolean }>("mesh/leave-room", async (ctx) => {
      const { roomName } = ctx.payload;
      await this.removeFromRoom(roomName, ctx.connection);
      return { success: true };
    });

    this.exposeCommand<{ connectionId: string }, { metadata: any }>("mesh/get-connection-metadata", async (ctx) => {
      const { connectionId } = ctx.payload;
      const connection = this.connectionManager.getLocalConnection(connectionId);

      if (connection) {
        const metadata = await this.connectionManager.getMetadata(connection);
        return { metadata };
      } else {
        const metadata = await this.redisManager.redis.hget("mesh:connections", connectionId);
        return { metadata: metadata ? JSON.parse(metadata) : null };
      }
    });

    this.exposeCommand<{}, { metadata: any }>("mesh/get-my-connection-metadata", async (ctx) => {
      const connectionId = ctx.connection.id;
      const connection = this.connectionManager.getLocalConnection(connectionId);
      if (connection) {
        const metadata = await this.connectionManager.getMetadata(connection);
        return { metadata };
      } else {
        const metadata = await this.redisManager.redis.hget("mesh:connections", connectionId);
        return { metadata: metadata ? JSON.parse(metadata) : null };
      }
    });

    this.exposeCommand<{ metadata: any; options?: { strategy?: "replace" | "merge" | "deepMerge" } }, { success: boolean }>(
      "mesh/set-my-connection-metadata",
      async (ctx) => {
        const { metadata, options } = ctx.payload;
        const connectionId = ctx.connection.id;
        const connection = this.connectionManager.getLocalConnection(connectionId);

        if (connection) {
          try {
            await this.connectionManager.setMetadata(connection, metadata, options);
            return { success: true };
          } catch (error) {
            return { success: false };
          }
        } else {
          return { success: false };
        }
      },
    );

    this.exposeCommand<{ roomName: string }, { metadata: any }>("mesh/get-room-metadata", async (ctx) => {
      const { roomName } = ctx.payload;
      const metadata = await this.roomManager.getMetadata(roomName);
      return { metadata };
    });
  }

  private registerRecordCommands() {
    this.exposeCommand<{ recordId: string; mode?: "patch" | "full" }, { success: boolean; record?: any; version?: number }>(
      "mesh/subscribe-record",
      async (ctx) => {
        const { recordId, mode = "full" } = ctx.payload;
        const connectionId = ctx.connection.id;

        if (!(await this.recordSubscriptionManager.isRecordExposed(recordId, ctx.connection))) {
          return { success: false };
        }

        try {
          const { record, version } = await this.recordManager.getRecordAndVersion(recordId);

          this.recordSubscriptionManager.addSubscription(recordId, connectionId, mode);

          return { success: true, record, version };
        } catch (e) {
          console.error(`Failed to subscribe to record ${recordId}:`, e);
          return { success: false };
        }
      },
    );

    this.exposeCommand<{ recordId: string }, boolean>("mesh/unsubscribe-record", async (ctx) => {
      const { recordId } = ctx.payload;
      const connectionId = ctx.connection.id;
      return this.recordSubscriptionManager.removeSubscription(recordId, connectionId);
    });

    this.exposeCommand<{ recordId: string; newValue: any; options?: { strategy?: "replace" | "merge" | "deepMerge" } }, { success: boolean }>(
      "mesh/publish-record-update",
      async (ctx) => {
        const { recordId, newValue, options } = ctx.payload;

        if (!(await this.recordSubscriptionManager.isRecordWritable(recordId, ctx.connection))) {
          throw new Error(`Record "${recordId}" is not writable by this connection.`);
        }

        try {
          await this.publishRecordUpdate(recordId, newValue, options);
          return { success: true };
        } catch (e: any) {
          throw new Error(`Failed to publish update for record "${recordId}": ${e.message}`);
        }
      },
    );

    this.exposeCommand<
      { roomName: string },
      {
        success: boolean;
        present: Array<{ id: string; metadata: any }>;
        states?: Record<string, Record<string, any>>;
      }
    >("mesh/subscribe-presence", async (ctx) => {
      const { roomName } = ctx.payload;

      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection))) {
        return { success: false, present: [] };
      }

      try {
        const presenceChannel = `mesh:presence:updates:${roomName}`;

        this.channelManager.addSubscription(presenceChannel, ctx.connection);

        if (!this.channelManager.getSubscribers(presenceChannel) || this.channelManager.getSubscribers(presenceChannel)?.size === 1) {
          await this.channelManager.subscribeToRedisChannel(presenceChannel);
        }

        const present = await this.getRoomMembersWithMetadata(roomName);

        // get all presence states for the room
        const statesMap = await this.presenceManager.getAllPresenceStates(roomName);
        const states: Record<string, Record<string, any>> = {};

        statesMap.forEach((state, connectionId) => {
          states[connectionId] = state;
        });

        return {
          success: true,
          present,
          states,
        };
      } catch (e) {
        console.error(`Failed to subscribe to presence for room ${roomName}:`, e);
        return { success: false, present: [] };
      }
    });

    this.exposeCommand<{ roomName: string }, boolean>("mesh/unsubscribe-presence", async (ctx) => {
      const { roomName } = ctx.payload;
      const presenceChannel = `mesh:presence:updates:${roomName}`;
      return this.channelManager.removeSubscription(presenceChannel, ctx.connection);
    });

    this.exposeCommand<
      {
        roomName: string;
        state: Record<string, any>;
        expireAfter?: number;
        silent?: boolean;
      },
      boolean
    >("mesh/publish-presence-state", async (ctx) => {
      const { roomName, state, expireAfter, silent } = ctx.payload;
      const connectionId = ctx.connection.id;

      if (!state) {
        return false;
      }

      // ensure presence is tracked for this room and the connection is in the room
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection)) || !(await this.isInRoom(roomName, connectionId))) {
        return false;
      }

      try {
        await this.presenceManager.publishPresenceState(connectionId, roomName, state, expireAfter, silent);
        return true;
      } catch (e) {
        console.error(`Failed to publish presence state for room ${roomName}:`, e);
        return false;
      }
    });

    this.exposeCommand<{ roomName: string }, boolean>("mesh/clear-presence-state", async (ctx) => {
      const { roomName } = ctx.payload;
      const connectionId = ctx.connection.id;

      // ensure presence is tracked for this room and the connection is in the room
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection)) || !(await this.isInRoom(roomName, connectionId))) {
        return false;
      }

      try {
        await this.presenceManager.clearPresenceState(connectionId, roomName);
        return true;
      } catch (e) {
        console.error(`Failed to clear presence state for room ${roomName}:`, e);
        return false;
      }
    });

    this.exposeCommand<
      { roomName: string },
      {
        success: boolean;
        present: string[];
        states?: Record<string, Record<string, any>>;
      }
    >("mesh/get-presence-state", async (ctx) => {
      const { roomName } = ctx.payload;

      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection))) {
        return { success: false, present: [] };
      }

      try {
        const present = await this.presenceManager.getPresentConnections(roomName);
        const statesMap = await this.presenceManager.getAllPresenceStates(roomName);
        const states: Record<string, Record<string, any>> = {};

        statesMap.forEach((state, connectionId) => {
          states[connectionId] = state;
        });

        return {
          success: true,
          present,
          states,
        };
      } catch (e) {
        console.error(`Failed to get presence state for room ${roomName}:`, e);
        return { success: false, present: [] };
      }
    });

    this.exposeCommand<{ collectionId: string }, { success: boolean; ids: string[]; records: any[]; version: number }>(
      "mesh/subscribe-collection",
      async (ctx) => {
        const { collectionId } = ctx.payload;
        const connectionId = ctx.connection.id;

        if (!(await this.collectionManager.isCollectionExposed(collectionId, ctx.connection))) {
          return { success: false, ids: [], records: [], version: 0 };
        }

        try {
          const { ids, records, version } = await this.collectionManager.addSubscription(collectionId, connectionId, ctx.connection);

          // records already contain the data, just format for client
          const recordsWithId = records.map((record) => ({ id: record.id, record }));

          return { success: true, ids, records: recordsWithId, version };
        } catch (e) {
          console.error(`Failed to subscribe to collection ${collectionId}:`, e);
          return { success: false, ids: [], records: [], version: 0 };
        }
      },
    );

    this.exposeCommand<{ collectionId: string }, boolean>("mesh/unsubscribe-collection", async (ctx) => {
      const { collectionId } = ctx.payload;
      const connectionId = ctx.connection.id;

      return this.collectionManager.removeSubscription(collectionId, connectionId);
    });
  }

  // #endregion

  async cleanupConnection(connection: Connection) {
    serverLogger.info("Cleaning up connection:", connection.id);
    connection.stopIntervals();

    try {
      await this.presenceManager.cleanupConnection(connection);
      await this.connectionManager.cleanupConnection(connection);
      await this.roomManager.cleanupConnection(connection);
      this.recordSubscriptionManager.cleanupConnection(connection);
      this.channelManager.cleanupConnection(connection);
      await this.collectionManager.cleanupConnection(connection);
    } catch (err) {
      this.emit("error", new Error(`Failed to clean up connection: ${err}`));
    }
  }

  /**
   * Gracefully closes all active connections, cleans up resources,
   * and shuts down the service. Optionally accepts a callback function
   * that will be invoked once shutdown is complete or if an error occurs.
   *
   * @param {((err?: Error) => void)=} callback - Optional callback to be invoked when closing is complete or if an error occurs.
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   * @throws {Error} If an error occurs during shutdown, the promise will be rejected with the error.
   */
  async close(callback?: (err?: Error) => void): Promise<void> {
    this.redisManager.isShuttingDown = true;

    const connections = Object.values(this.connectionManager.getLocalConnections());
    await Promise.all(
      connections.map(async (connection) => {
        if (!connection.isDead) {
          await connection.close();
        }
        await this.cleanupConnection(connection);
      }),
    );

    await new Promise<void>((resolve, reject) => {
      super.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (this.persistenceManager) {
      try {
        await this.persistenceManager.shutdown();
      } catch (err) {
        serverLogger.error("Error shutting down persistence manager:", err);
      }
    }

    await this.instanceManager.stop();

    this.redisManager.disconnect();

    this.listening = false;
    this.removeAllListeners();

    if (callback) {
      callback();
    }
  }

  /**
   * Registers a callback function to be executed when a new connection is established.
   *
   * @param {(connection: Connection) => Promise<void> | void} callback - The function to execute when a new connection is established.
   * @returns {MeshServer} The server instance for method chaining.
   */
  onConnection(callback: (connection: Connection) => Promise<void> | void): MeshServer {
    this.on("connected", callback);
    return this;
  }

  /**
   * Registers a callback function to be executed when a connection is closed.
   *
   * @param {(connection: Connection) => Promise<void> | void} callback - The function to execute when a connection is closed.
   * @returns {MeshServer} The server instance for method chaining.
   */
  onDisconnection(callback: (connection: Connection) => Promise<void> | void): MeshServer {
    this.on("disconnected", callback);
    return this;
  }

  async dispose() {
    await this.instanceManager.cleanupDeadInstance(this.instanceId);
  }

  /**
   * Registers a callback function to be executed when a record is updated.
   *
   * @param {(data: { recordId: string; value: any }) => Promise<void> | void} callback - The function to execute when a record is updated.
   * @returns {() => void} A function that, when called, will unregister the callback.
   */
  onRecordUpdate(callback: (data: { recordId: string; value: any }) => Promise<void> | void): () => void {
    return this.recordManager.onRecordUpdate(callback);
  }

  /**
   * Registers a callback function to be executed when a record is removed.
   *
   * @param {(data: { recordId: string; value: any }) => Promise<void> | void} callback - The function to execute when a record is removed.
   * @returns {() => void} A function that, when called, will unregister the callback.
   */
  onRecordRemoved(callback: (data: { recordId: string; value: any }) => Promise<void> | void): () => void {
    return this.recordManager.onRecordRemoved(callback);
  }
}
