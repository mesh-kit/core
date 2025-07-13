import { EventEmitter } from "eventemitter3";
import { CodeError } from "../common/codeerror";
import { Status } from "../common/status";
import { Connection } from "./connection";
import type { Operation } from "fast-json-patch";
import { LogLevel, clientLogger } from "../common/logger";

export { Status } from "../common/status";

export type PresenceUpdate =
  | {
      type: "join" | "leave";
      connectionId: string;
      roomName: string;
      timestamp?: number;
    }
  | {
      type: "state";
      connectionId: string;
      roomName: string;
      state: any;
      timestamp?: number;
    };

export type PresenceUpdateCallback = (update: PresenceUpdate) => void | Promise<void>;

export type MeshClientOptions = Partial<{
  /**
   * The number of milliseconds to wait before considering the connection closed due to inactivity.
   * When this happens, the connection will be closed and a reconnect will be attempted if
   * {@link MeshClientOptions.shouldReconnect} is true. This number should match the server's
   * `pingInterval` option.
   *
   * @default 30000
   */
  pingTimeout: number;

  /**
   * The maximum number of consecutive ping intervals the client will wait
   * for a ping message before considering the connection closed.
   * A value of 1 means the client must receive a ping within roughly 2 * pingTimeout
   * before attempting to reconnect.
   *
   * @default 1
   */
  maxMissedPings: number;

  /**
   * Whether or not to reconnect automatically.
   *
   * @default true
   */
  shouldReconnect: boolean;

  /**
   * The number of milliseconds to wait between reconnect attempts.
   *
   * @default 2000
   */
  reconnectInterval: number;

  /**
   * The number of times to attempt to reconnect before giving up and
   * emitting a `reconnectfailed` event.
   *
   * @default Infinity
   */
  maxReconnectAttempts: number;

  /**
   * The log level for client-side logs.
   * Controls which messages are displayed in the console.
   *
   * @default LogLevel.ERROR
   */
  logLevel: LogLevel;
}>;

export class MeshClient extends EventEmitter {
  connection: Connection;
  url: string;
  socket: WebSocket | null = null;
  pingTimeout: ReturnType<typeof setTimeout> | undefined;
  missedPings = 0;
  options: Required<MeshClientOptions>;
  isReconnecting = false;
  private _status: Status = Status.OFFLINE;
  private recordSubscriptions: Map<
    string, // recordId
    {
      callback?: (update: { recordId: string; full?: any; patch?: Operation[]; version: number; deleted?: boolean }) => void | Promise<void>;
      localVersion: number;
      mode: "patch" | "full";
    }
  > = new Map();

  private collectionSubscriptions: Map<
    string, // collectionId
    {
      recordIds: Set<string>;
      version: number;
      onUpdate?: (update: { id: string; record?: any; version: number; deleted?: boolean }) => void | Promise<void>;
      onDiff?: (diff: { added: string[]; removed: string[]; version: number }) => void | Promise<void>;
    }
  > = new Map();

  private presenceSubscriptions: Map<
    string, // roomName
    (update: {
      type: "join" | "leave" | "state";
      connectionId: string;
      roomName: string;
      timestamp: number;
      state?: Record<string, any> | null;
      metadata?: any;
    }) => void | Promise<void>
  > = new Map();

  joinedRooms: Map<
    string, // roomName
    PresenceUpdateCallback | undefined
  > = new Map();

  private channelSubscriptions: Map<
    string, // channel
    {
      callback: (message: string) => void | Promise<void>;
      historyLimit?: number;
    }
  > = new Map();

  constructor(url: string, opts: MeshClientOptions = {}) {
    super();
    this.url = url;
    this.connection = new Connection(null);
    this.options = {
      pingTimeout: opts.pingTimeout ?? 30_000,
      maxMissedPings: opts.maxMissedPings ?? 1,
      shouldReconnect: opts.shouldReconnect ?? true,
      reconnectInterval: opts.reconnectInterval ?? 2_000,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? Infinity,
      logLevel: opts.logLevel ?? LogLevel.ERROR,
    };

    clientLogger.configure({
      level: this.options.logLevel,
      styling: true,
    });

    this.setupConnectionEvents();
    this.setupVisibilityHandling();
  }

  private _lastActivityTime: number = Date.now();
  private _isBrowser: boolean = false;

  /**
   * Periodically check if we've been inactive for too long, and if we have,
   * try to send a noop command to the server to see if we're still connected.
   * If we get no response, we'll assume the connection is dead and force a reconnect.
   */
  private _checkActivity(): void {
    if (!this._isBrowser) return;

    const now = Date.now();
    const timeSinceActivity = now - this._lastActivityTime;

    // if we've been inactive for longer than the ping timeout but think we're online,
    // we might have missed pings from the server
    if (timeSinceActivity > this.options.pingTimeout && this._status === Status.ONLINE) {
      this.command("mesh/noop", {}, 5000).catch(() => {
        clientLogger.info(`No activity for ${timeSinceActivity}ms. Tried reaching server and failed. Forcing reconnect`);
        this.forceReconnect();
      });
    }

    if (this._status === Status.ONLINE) {
      this._lastActivityTime = now;
    }
  }

  /**
   * Sets up event listeners and periodic timer to monitor user activity and tab visibility.
   * Reconnects when the user returns to the tab after a period of inactivity.
   */
  private setupVisibilityHandling(): void {
    try {
      this._isBrowser = !!(global as any).document && typeof (global as any).document.addEventListener === "function";

      if (!this._isBrowser) {
        return;
      }

      // periodic activity check
      setInterval(() => {
        this._checkActivity();
      }, 10000);

      // update activity time on any user interaction
      try {
        const doc = (global as any).document;
        const events = ["mousedown", "keydown", "touchstart", "visibilitychange"];

        events.forEach((eventName) => {
          doc.addEventListener(eventName, () => {
            // const wasInactive =
            //   Date.now() - this._lastActivityTime > this.options.pingTimeout;
            this._lastActivityTime = Date.now();

            if (eventName === "visibilitychange" && doc.visibilityState === "visible") {
              if (this._status === Status.OFFLINE) return;

              // send noop. if it fails for any reason, force reconnect
              this.command("mesh/noop", {}, 5000)
                .then(() => {
                  clientLogger.info("Tab is visible again, no reconnect needed");

                  this.emit("republish");
                })
                .catch(() => {
                  clientLogger.info("Tab is visible again, forcing reconnect");
                  this.forceReconnect();
                });
            }

            // if visibility changed to visible and we were inactive for too long, reconnect
            // if (
            //   eventName === "visibilitychange" &&
            //   doc.visibilityState === "visible" &&
            //   wasInactive &&
            //   this._status !== Status.CONNECTING &&
            //   this._status !== Status.RECONNECTING
            // ) {
            //   console.log("[mesh] Tab is visible again, reconnecting...");
            //   this.forceReconnect();
            // }
          });
        });
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // ignore
    }
  }

  // force a reconnection
  private forceReconnect(): void {
    if (this.isReconnecting) {
      return;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
    }

    this._status = Status.OFFLINE;
    this.connection.socket = null;
    this.connection.status = Status.OFFLINE;

    this.reconnect();
  }

  get status(): Status {
    return this._status;
  }

  get connectionId(): string | undefined {
    return this.connection.connectionId;
  }

  private setupConnectionEvents(): void {
    this.connection.on("message", (data) => {
      this.emit("message", data);

      if (data.command === "mesh/record-update") {
        this.handleRecordUpdate(data.payload);
      } else if (data.command === "mesh/record-deleted") {
        this.handleRecordDeleted(data.payload);
      } else if (data.command === "mesh/presence-update") {
        this.handlePresenceUpdate(data.payload);
      } else if (data.command === "mesh/subscription-message") {
        this.handleChannelMessage(data.payload);
      } else if (data.command === "mesh/collection-diff") {
        this.handleCollectionDiff(data.payload);
      } else {
        const systemCommands = ["ping", "pong", "latency", "latency:request", "latency:response"];
        if (data.command && !systemCommands.includes(data.command)) {
          this.emit(data.command, data.payload);
        }
      }
    });

    this.connection.on("close", () => {
      this._status = Status.OFFLINE;
      this.emit("close");
      this.reconnect();
    });

    this.connection.on("error", (error) => {
      this.emit("error", error);
    });

    this.connection.on("ping", () => {
      this.heartbeat();
      this.emit("ping");
    });

    this.connection.on("latency", (data) => {
      this.emit("latency", data);
    });
  }

  /**
   * Connect to the WebSocket server.
   *
   * @returns {Promise<void>} A promise that resolves when the connection is established.
   */
  connect(): Promise<void> {
    if (this._status === Status.ONLINE) {
      return Promise.resolve();
    }

    if (this._status === Status.CONNECTING || this._status === Status.RECONNECTING) {
      return new Promise((resolve, reject) => {
        const onConnect = () => {
          this.removeListener("connect", onConnect);
          this.removeListener("error", onError);
          resolve();
        };

        const onError = (error: Error) => {
          this.removeListener("connect", onConnect);
          this.removeListener("error", onError);
          reject(error);
        };

        this.once("connect", onConnect);
        this.once("error", onError);
      });
    }

    this._status = Status.CONNECTING;

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
          this._status = Status.ONLINE;
          this.connection.socket = this.socket;
          this.connection.status = Status.ONLINE;
          this.connection.applyListeners();
          this.heartbeat();

          const onIdAssigned = () => {
            this.connection.removeListener("id-assigned", onIdAssigned);
            this.emit("connect");
            resolve();
          };

          if (this.connection.connectionId) {
            this.emit("connect");
            resolve();
          } else {
            this.connection.once("id-assigned", onIdAssigned);
          }
        };

        this.socket.onerror = (error) => {
          this._status = Status.OFFLINE;
          reject(new CodeError("WebSocket connection error", "ECONNECTION", "ConnectionError"));
        };
      } catch (error) {
        this._status = Status.OFFLINE;
        reject(error);
      }
    });
  }

  private heartbeat(): void {
    this.missedPings = 0;

    if (!this.pingTimeout) {
      this.pingTimeout = setTimeout(() => {
        this.checkPingStatus();
      }, this.options.pingTimeout);
    }
  }

  private checkPingStatus(): void {
    this.missedPings++;

    if (this.missedPings > this.options.maxMissedPings) {
      if (this.options.shouldReconnect) {
        clientLogger.warn(`Missed ${this.missedPings} pings, reconnecting...`);
        this.reconnect();
      }
    } else {
      this.pingTimeout = setTimeout(() => {
        this.checkPingStatus();
      }, this.options.pingTimeout);
    }
  }

  /**
   * Disconnect the client from the server.
   * The client will not attempt to reconnect.
   *
   * @returns {Promise<void>} A promise that resolves when the connection is closed.
   */
  close(): Promise<void> {
    this.options.shouldReconnect = false;

    if (this._status === Status.OFFLINE) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onClose = () => {
        this.removeListener("close", onClose);
        this._status = Status.OFFLINE;
        this.emit("disconnect");
        resolve();
      };

      this.once("close", onClose);

      clearTimeout(this.pingTimeout);
      this.pingTimeout = undefined;

      if (this.socket) {
        this.socket.close();
      }
    });
  }

  private reconnect(): void {
    if (!this.options.shouldReconnect || this.isReconnecting) {
      return;
    }

    this._status = Status.RECONNECTING;
    this.isReconnecting = true;

    // Reset ping tracking
    clearTimeout(this.pingTimeout);
    this.pingTimeout = undefined;
    this.missedPings = 0;

    let attempt = 1;

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // ignore errors during close
      }

      this.emit("disconnect");
    }

    const connect = () => {
      this.socket = new WebSocket(this.url);

      this.socket.onerror = () => {
        attempt++;

        if (attempt <= this.options.maxReconnectAttempts) {
          setTimeout(connect, this.options.reconnectInterval);
          return;
        }

        this.isReconnecting = false;
        this._status = Status.OFFLINE;
        this.emit("reconnectfailed");
      };

      this.socket.onopen = () => {
        this.isReconnecting = false;
        this._status = Status.ONLINE;
        this.connection.socket = this.socket;
        this.connection.status = Status.ONLINE;
        this.connection.applyListeners(true);
        this.heartbeat();

        const onIdAssigned = async () => {
          this.connection.removeListener("id-assigned", onIdAssigned);

          await this.resubscribeAll();

          this.emit("connect");
          this.emit("reconnect");
        };

        if (this.connection.connectionId) {
          this.resubscribeAll().then(() => {
            this.emit("connect");
            this.emit("reconnect");
          });
        } else {
          this.connection.once("id-assigned", onIdAssigned);
        }
      };
    };

    connect();
  }

  /**
   * Send a command to the server and wait for a response.
   *
   * @param {string} command - The command name to send.
   * @param {unknown} payload - The payload to send with the command.
   * @param {number} expiresIn - Timeout in milliseconds.
   * @returns {Promise<unknown>} A promise that resolves with the command result.
   */
  async command(command: string, payload?: any, expiresIn: number = 30000): Promise<any> {
    if (this._status !== Status.ONLINE) {
      return this.connect()
        .then(() => this.connection.command(command, payload, expiresIn))
        .catch((error) => Promise.reject(error));
    }

    return this.connection.command(command, payload, expiresIn);
  }

  private async handlePresenceUpdate(payload: {
    type: "join" | "leave" | "state";
    connectionId: string;
    roomName: string;
    timestamp: number;
    state?: Record<string, any> | null;
    metadata?: any;
  }) {
    const { roomName } = payload;
    const callback = this.presenceSubscriptions.get(roomName);

    if (callback) {
      await callback(payload);
    }
  }

  private async handleChannelMessage(payload: { channel: string; message: string }) {
    const { channel, message } = payload;
    const subscription = this.channelSubscriptions.get(channel);

    if (subscription) {
      try {
        await subscription.callback(message);
      } catch (error) {
        clientLogger.error(`Error in channel callback for ${channel}:`, error);
      }
    }
  }

  private async handleRecordUpdate(payload: { recordId: string; full?: any; patch?: Operation[]; version: number }) {
    const { recordId, full, patch, version } = payload;

    // first, check if this record is part of any collections and notify their onUpdate callbacks
    for (const [collectionId, collectionSub] of this.collectionSubscriptions.entries()) {
      if (collectionSub.recordIds.has(recordId) && collectionSub.onUpdate) {
        try {
          // Transform the payload to match the {id, record} shape for consistency with initial collection data
          const transformedPayload = {
            id: recordId,
            record: full,
            version,
            deleted: false,
          };
          await collectionSub.onUpdate(transformedPayload);
        } catch (error) {
          clientLogger.error(`Error in collection record update callback for ${collectionId}:`, error);
        }
      }
    }

    // then check for direct record subscriptions
    const subscription = this.recordSubscriptions.get(recordId);
    if (!subscription) {
      // if there's no direct subscription (e.g., only via collection), we might still have processed
      // the collection update above. if not, this update isn't relevant to the client directly
      return;
    }

    // handle the direct subscription logic (version checks, callback)
    if (patch) {
      if (version !== subscription.localVersion + 1) {
        // desync
        clientLogger.warn(
          `Desync detected for record ${recordId}. Expected version ${subscription.localVersion + 1}, got ${version}. Resubscribing to request full record.`,
        );
        // unsubscribe and resubscribe to force a full update
        await this.unsubscribeRecord(recordId);
        await this.subscribeRecord(recordId, subscription.callback, {
          mode: subscription.mode,
        });
        return;
      }

      subscription.localVersion = version;
      if (subscription.callback) {
        await subscription.callback({ recordId, patch, version });
      }
    } else if (full !== undefined) {
      subscription.localVersion = version;
      if (subscription.callback) {
        await subscription.callback({ recordId, full, version });
      }
    }
  }

  private async handleRecordDeleted(payload: { recordId: string; version: number }) {
    const { recordId, version } = payload;

    const subscription = this.recordSubscriptions.get(recordId);
    if (subscription && subscription.callback) {
      try {
        await subscription.callback({ recordId, deleted: true, version });
      } catch (error) {
        clientLogger.error(`Error in record deletion callback for ${recordId}:`, error);
      }
    }

    this.recordSubscriptions.delete(recordId);
  }

  /**
   * Handles collection diff messages from the server.
   * Updates the local collection state and triggers callbacks.
   *
   * @param {Object} payload - The collection diff payload.
   * @param {string} payload.collectionId - The ID of the collection.
   * @param {string[]} payload.added - Array of record IDs added to the collection.
   * @param {string[]} payload.removed - Array of record IDs removed from the collection.
   * @param {number} payload.version - The new version of the collection.
   */
  private async handleCollectionDiff(payload: { collectionId: string; added: string[]; removed: string[]; version: number }) {
    const { collectionId, added, removed, version } = payload;

    const subscription = this.collectionSubscriptions.get(collectionId);

    if (!subscription) {
      return;
    }

    // check for version mismatch
    if (version !== subscription.version + 1) {
      clientLogger.warn(
        `Desync detected for collection ${collectionId}. Expected version ${
          subscription.version + 1
        }, got ${version}. Resubscribing to request full collection.`,
      );

      // unsubscribe and resubscribe to force a full update
      await this.unsubscribeCollection(collectionId);
      await this.subscribeCollection(collectionId, {
        onUpdate: subscription.onUpdate,
        onDiff: subscription.onDiff,
      });

      return;
    }

    // update the local version
    subscription.version = version;

    // update the local record IDs set
    for (const recordId of added) {
      subscription.recordIds.add(recordId);
    }

    for (const recordId of removed) {
      subscription.recordIds.delete(recordId);
    }

    // notify the diff callback
    if (subscription.onDiff) {
      try {
        await subscription.onDiff({ added, removed, version });
      } catch (error) {
        clientLogger.error(`Error in collection diff callback for ${collectionId}:`, error);
      }
    }
  }

  /**
   * Subscribes to a specific channel and registers a callback to be invoked
   * whenever a message is received on that channel. Optionally retrieves a
   * limited number of historical messages and passes them to the callback upon subscription.
   *
   * @param {string} channel - The name of the channel to subscribe to.
   * @param {(message: string) => void | Promise<void>} callback - The function to be called for each message received on the channel.
   * @param {{ historyLimit?: number; since?: string | number }} [options] - Optional subscription options:
   *   - historyLimit: The maximum number of historical messages to retrieve.
   *   - since: Retrieve messages after this timestamp or message ID (requires persistence to be enabled for the channel).
   * @returns {Promise<{ success: boolean; history: string[] }>} A promise that resolves with the subscription result,
   *          including a success flag and an array of historical messages.
   */
  async subscribeChannel(
    channel: string,
    callback: (message: string) => void | Promise<void>,
    options?: { historyLimit?: number; since?: string | number },
  ): Promise<{ success: boolean; history: string[] }> {
    this.channelSubscriptions.set(channel, {
      callback,
      historyLimit: options?.historyLimit,
    });

    const historyLimit = options?.historyLimit;
    const since = options?.since;

    return this.command("mesh/subscribe-channel", {
      channel,
      historyLimit,
      since,
    }).then((result) => {
      if (result.success && result.history && result.history.length > 0) {
        result.history.forEach((message: string) => {
          callback(message);
        });
      }

      return {
        success: result.success,
        history: result.history || [],
      };
    });
  }

  /**
   * Unsubscribes from a specified channel.
   *
   * @param {string} channel - The name of the channel to unsubscribe from.
   * @returns {Promise<boolean>} A promise that resolves to true if the unsubscription is successful, or false otherwise.
   */
  unsubscribeChannel(channel: string): Promise<boolean> {
    this.channelSubscriptions.delete(channel);
    return this.command("mesh/unsubscribe-channel", { channel });
  }

  /**
   * Retrieves historical messages from a channel without subscribing to it.
   * This method requires persistence to be enabled for the channel on the server.
   *
   * @param {string} channel - The name of the channel to retrieve history from.
   * @param {{ limit?: number; since?: string | number }} [options] - Optional retrieval options:
   *   - limit: The maximum number of messages to retrieve (defaults to server's historyLimit).
   *   - since: Retrieve messages after this timestamp or message ID.
   * @returns {Promise<{ success: boolean; history: string[] }>} A promise that resolves with the retrieval result,
   *          including a success flag and an array of historical messages.
   */
  async getChannelHistory(channel: string, options?: { limit?: number; since?: string | number }): Promise<{ success: boolean; history: string[] }> {
    try {
      const result = await this.command("mesh/get-channel-history", {
        channel,
        limit: options?.limit,
        since: options?.since,
      });

      return {
        success: result.success,
        history: result.history || [],
      };
    } catch (error) {
      clientLogger.error(`Failed to get history for channel ${channel}:`, error);
      return { success: false, history: [] };
    }
  }

  /**
   * Subscribes to a specific record and registers a callback for updates.
   *
   * @param {string} recordId - The ID of the record to subscribe to.
   * @param {(update: { full?: any; patch?: Operation[]; version: number; deleted?: boolean }) => void | Promise<void>} callback - Function called on updates.
   * @param {{ mode?: "patch" | "full" }} [options] - Subscription mode ('patch' or 'full', default 'full').
   * @returns {Promise<{ success: boolean; record: any | null; version: number }>} Initial state of the record.
   */
  async subscribeRecord(
    recordId: string,
    callback?: (update: { recordId: string; full?: any; patch?: Operation[]; version: number; deleted?: boolean }) => void | Promise<void>,
    options?: { mode?: "patch" | "full" },
  ): Promise<{ success: boolean; record: any | null; version: number }> {
    const mode = options?.mode ?? "full";

    try {
      const result = await this.command("mesh/subscribe-record", {
        recordId,
        mode,
      });

      if (result.success) {
        this.recordSubscriptions.set(recordId, {
          callback,
          localVersion: result.version,
          mode,
        });

        if (callback) {
          await callback({
            recordId,
            full: result.record,
            version: result.version,
          });
        }
      }

      return {
        success: result.success,
        record: result.record ?? null,
        version: result.version ?? 0,
      };
    } catch (error) {
      clientLogger.error(`Failed to subscribe to record ${recordId}:`, error);
      return { success: false, record: null, version: 0 };
    }
  }

  /**
   * Unsubscribes from a specific record.
   *
   * @param {string} recordId - The ID of the record to unsubscribe from.
   * @returns {Promise<boolean>} True if successful, false otherwise.
   */
  async unsubscribeRecord(recordId: string): Promise<boolean> {
    try {
      const success = await this.command("mesh/unsubscribe-record", {
        recordId,
      });
      if (success) {
        this.recordSubscriptions.delete(recordId);
      }
      return success;
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from record ${recordId}:`, error);
      return false;
    }
  }

  /**
   * Subscribes to a collection and registers callbacks for updates and diffs.
   *
   * @param {string} collectionId - The ID of the collection to subscribe to.
   * @param {Object} options - Subscription options.
   * @param {Function} [options.onUpdate] - Callback for record updates.
   * @param {Function} [options.onDiff] - Callback for collection membership changes.
   * @returns {Promise<{success: boolean; recordIds: string[]; records: Array<{id: string; record: any}>; version: number}>} Initial state of the collection including records data structured as {id, record}.
   */
  async subscribeCollection(
    collectionId: string,
    options: {
      onUpdate?: (update: { id: string; record?: any; version: number; deleted?: boolean }) => void | Promise<void>;
      onDiff?: (diff: { added: string[]; removed: string[]; version: number }) => void | Promise<void>;
    } = {},
  ): Promise<{ success: boolean; recordIds: string[]; records: Array<{ id: string; record: any }>; version: number }> {
    try {
      const result = await this.command("mesh/subscribe-collection", {
        collectionId,
      });

      if (result.success) {
        this.collectionSubscriptions.set(collectionId, {
          recordIds: new Set(result.recordIds),
          version: result.version,
          onUpdate: options.onUpdate,
          onDiff: options.onDiff,
        });
        // if onDiff is provided, call it with the initial set of records
        if (options.onDiff) {
          try {
            await options.onDiff({
              added: result.recordIds,
              removed: [],
              version: result.version,
            });
          } catch (error) {
            clientLogger.error(`Error in initial collection diff callback for ${collectionId}:`, error);
          }
        }
      }

      return {
        success: result.success,
        recordIds: result.recordIds || [],
        records: result.records || [],
        version: result.version || 0,
      };
    } catch (error) {
      clientLogger.error(`Failed to subscribe to collection ${collectionId}:`, error);
      return { success: false, recordIds: [], records: [], version: 0 };
    }
  }

  /**
   * Unsubscribes from a collection.
   *
   * @param {string} collectionId - The ID of the collection to unsubscribe from.
   * @returns {Promise<boolean>} True if successful, false otherwise.
   */
  async unsubscribeCollection(collectionId: string): Promise<boolean> {
    try {
      const success = await this.command("mesh/unsubscribe-collection", {
        collectionId,
      });

      if (success) {
        this.collectionSubscriptions.delete(collectionId);
      }

      return success;
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from collection ${collectionId}:`, error);
      return false;
    }
  }

  /**
   * Manually refreshes a collection subscription to check for changes.
   *
   * @param {string} collectionId - The ID of the collection to refresh.
   * @returns {Promise<{success: boolean; added: string[]; removed: string[]; version: number}>} The refresh result.
   */
  async refreshCollection(collectionId: string): Promise<{ success: boolean; added: string[]; removed: string[]; version: number }> {
    try {
      const result = await this.command("mesh/refresh-collection", {
        collectionId,
      });

      if (result.success) {
        const subscription = this.collectionSubscriptions.get(collectionId);

        if (subscription) {
          // update the local version
          subscription.version = result.version;

          // update the local record IDs set
          for (const recordId of result.added) {
            subscription.recordIds.add(recordId);
          }

          for (const recordId of result.removed) {
            subscription.recordIds.delete(recordId);
          }

          // notify the diff callback
          if (subscription.onDiff && (result.added.length > 0 || result.removed.length > 0)) {
            try {
              await subscription.onDiff({
                added: result.added,
                removed: result.removed,
                version: result.version,
              });
            } catch (error) {
              clientLogger.error(`Error in collection diff callback for ${collectionId}:`, error);
            }
          }
        }
      }

      return {
        success: result.success,
        added: result.added || [],
        removed: result.removed || [],
        version: result.version || 0,
      };
    } catch (error) {
      clientLogger.error(`Failed to refresh collection ${collectionId}:`, error);
      return { success: false, added: [], removed: [], version: 0 };
    }
  }

  /**
   * Publishes an update to a specific record if the client has write permissions.
   *
   * @param {string} recordId - The ID of the record to update.
   * @param {any} newValue - The new value for the record, or partial value when using merge strategy.
   * @param {Object} [options] - Optional update options.
   * @param {"replace" | "merge"} [options.strategy="replace"] - Update strategy: "replace" (default) replaces the entire record, "merge" merges with existing object properties.
   * @returns {Promise<boolean>} True if the update was successfully published, false otherwise.
   *
   * @example
   * // Replace strategy (default) - replaces entire record
   * await client.publishRecordUpdate("user:123", { name: "John", age: 30 });
   *
   * // Merge strategy - merges with existing record
   * // If record currently contains: { name: "old name", age: 30, city: "NYC" }
   * await client.publishRecordUpdate("user:123", { name: "new name" }, { strategy: "merge" });
   * // Result: { name: "new name", age: 30, city: "NYC" }
   */
  async publishRecordUpdate(recordId: string, newValue: any, options?: { strategy?: "replace" | "merge" }): Promise<boolean> {
    try {
      const result = await this.command("mesh/publish-record-update", {
        recordId,
        newValue,
        strategy: options?.strategy || "replace",
      });
      return result.success === true;
    } catch (error) {
      clientLogger.error(`Failed to publish update for record ${recordId}:`, error);
      return false;
    }
  }

  /**
   * Attempts to join the specified room and optionally subscribes to presence updates.
   * If a callback for presence updates is provided, the method subscribes to presence changes and invokes the callback when updates occur.
   *
   * @param {string} roomName - The name of the room to join.
   * @param {PresenceUpdateCallback=} onPresenceUpdate - Optional callback to receive presence updates for the room.
   * @returns {Promise<{ success: boolean; present: string[] }>} A promise that resolves with an object indicating whether joining was successful and the list of present members.
   * @throws {Error} If an error occurs during the join or subscription process, the promise may be rejected with the error.
   */
  async joinRoom(roomName: string, onPresenceUpdate?: PresenceUpdateCallback): Promise<{ success: boolean; present: string[] }> {
    const joinResult = await this.command("mesh/join-room", { roomName });

    if (!joinResult.success) {
      return { success: false, present: [] };
    }

    this.joinedRooms.set(roomName, onPresenceUpdate);

    if (!onPresenceUpdate) {
      return { success: true, present: joinResult.present || [] };
    }

    const { success: subSuccess, present } = await this.subscribePresence(roomName, onPresenceUpdate);
    return { success: subSuccess, present };
  }

  /**
   * Leaves the specified room and unsubscribes from presence updates if subscribed.
   *
   * @param {string} roomName - The name of the room to leave.
   * @returns {Promise<{ success: boolean }>} A promise that resolves to an object indicating whether leaving the room was successful.
   * @throws {Error} If the underlying command or unsubscribe operation fails, the promise may be rejected with an error.
   */
  async leaveRoom(roomName: string): Promise<{ success: boolean }> {
    const result = await this.command("mesh/leave-room", { roomName });

    if (result.success) {
      this.joinedRooms.delete(roomName);

      if (this.presenceSubscriptions.has(roomName)) {
        await this.unsubscribePresence(roomName);
      }
    }

    return { success: result.success };
  }

  /**
   * Subscribes to presence updates for a specific room.
   *
   * @param {string} roomName - The name of the room to subscribe to presence updates for.
   * @param {PresenceUpdateCallback} callback - Function called on presence updates.
   * @returns {Promise<{ success: boolean; present: string[]; states?: Record<string, Record<string, any>> }>} Initial state of presence in the room.
   */
  async subscribePresence(
    roomName: string,
    callback: PresenceUpdateCallback,
  ): Promise<{
    success: boolean;
    present: string[];
    states?: Record<string, Record<string, any>>;
  }> {
    try {
      const result = await this.command("mesh/subscribe-presence", {
        roomName,
      });

      if (result.success) {
        this.presenceSubscriptions.set(roomName, callback as any);

        if (result.present && result.present.length > 0) {
          await callback(result as any);
        }
      }

      return {
        success: result.success,
        present: result.present || [],
        states: result.states || {},
      };
    } catch (error) {
      clientLogger.error(`Failed to subscribe to presence for room ${roomName}:`, error);
      return { success: false, present: [] };
    }
  }

  /**
   * Unsubscribes from presence updates for a specific room.
   *
   * @param {string} roomName - The name of the room to unsubscribe from.
   * @returns {Promise<boolean>} True if successful, false otherwise.
   */
  async unsubscribePresence(roomName: string): Promise<boolean> {
    try {
      const success = await this.command("mesh/unsubscribe-presence", {
        roomName,
      });
      if (success) {
        this.presenceSubscriptions.delete(roomName);
      }
      return success;
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from presence for room ${roomName}:`, error);
      return false;
    }
  }

  /**
   * Publishes a presence state for the current client in a room
   *
   * @param {string} roomName - The name of the room
   * @param {object} options - Options including state and optional TTL
   * @param {Record<string, any>} options.state - The state object to publish
   * @param {number} [options.expireAfter] - Optional TTL in milliseconds
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async publishPresenceState(
    roomName: string,
    options: {
      state: Record<string, any>;
      expireAfter?: number; // optional, in milliseconds
      silent?: boolean; // optional, if true, don't emit presence updates
    },
  ): Promise<boolean> {
    clientLogger.info(`publishPresenceState (silent=${Boolean(options.silent)}): ${roomName}`, options.state);
    try {
      return await this.command("mesh/publish-presence-state", {
        roomName,
        state: options.state,
        expireAfter: options.expireAfter,
        silent: options.silent,
      });
    } catch (error) {
      clientLogger.error(`Failed to publish presence state for room ${roomName}:`, error);
      return false;
    }
  }

  /**
   * Clears the presence state for the current client in a room
   *
   * @param {string} roomName - The name of the room
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async clearPresenceState(roomName: string): Promise<boolean> {
    try {
      return await this.command("mesh/clear-presence-state", {
        roomName,
      });
    } catch (error) {
      clientLogger.error(`Failed to clear presence state for room ${roomName}:`, error);
      return false;
    }
  }

  /**
   * Manually refreshes presence for a specific room
   *
   * @param {string} roomName - The name of the room to refresh presence for
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  // async refreshPresence(roomName: string): Promise<boolean> {
  //   return this._refreshPresenceForRoom(roomName);
  // }

  /**
   * Gets metadata for a specific room.
   *
   * @param {string} roomName - The name of the room to get metadata for.
   * @returns {Promise<any>} A promise that resolves with the room metadata.
   */
  async getRoomMetadata(roomName: string): Promise<any> {
    try {
      const result = await this.command("mesh/get-room-metadata", {
        roomName,
      });
      return result.metadata;
    } catch (error) {
      clientLogger.error(`Failed to get metadata for room ${roomName}:`, error);
      return null;
    }
  }

  /**
   * Gets metadata for a connection.
   *
   * @param {string} [connectionId] - The ID of the connection to get metadata for. If not provided, gets metadata for the current connection.
   * @returns {Promise<any>} A promise that resolves with the connection metadata.
   */
  async getConnectionMetadata(connectionId?: string): Promise<any> {
    try {
      if (connectionId) {
        const result = await this.command("mesh/get-connection-metadata", {
          connectionId,
        });
        return result.metadata;
      } else {
        const result = await this.command("mesh/get-my-connection-metadata");
        return result.metadata;
      }
    } catch (error) {
      const idText = connectionId ? ` ${connectionId}` : "";
      clientLogger.error(`Failed to get metadata for connection${idText}:`, error);
      return null;
    }
  }

  /**
   * Forces a complete refresh of presence data for a room.
   * This will fetch the current state of all users in the room and trigger the presence handler.
   *
   * @param {string} roomName - The name of the room to refresh presence for
   * @returns {Promise<boolean>} - True if successful, false otherwise
   */
  async forcePresenceUpdate(roomName: string): Promise<boolean> {
    try {
      // get the presence handler for this room
      const handler = this.presenceSubscriptions.get(roomName);
      if (!handler) return false;

      const result = await this.command("mesh/get-presence-state", { roomName }, 5000).catch((err) => {
        clientLogger.error(`Failed to get presence state for room ${roomName}:`, err);
        return { success: false };
      });

      if (!result.success) return false;

      const { present, states } = result;

      type PresenceHandlerWithInit = typeof handler & {
        init: (present: string[], states: Record<string, any>) => void;
      };

      const handlerWithInit = handler as PresenceHandlerWithInit;
      if (handlerWithInit.init && typeof handlerWithInit.init === "function") {
        handlerWithInit.init(present, states || {});
      }

      return true;
    } catch (error) {
      clientLogger.error(`(forcePresenceUpdate) Failed to force presence update for room ${roomName}:`, error);
      return false;
    }
  }

  /**
   * Register a callback for the connect event.
   * This event is emitted when the client successfully connects to the server.
   *
   * @param {() => void} callback - The function to call when the client connects
   * @returns {this} The client instance for chaining
   */
  onConnect(callback: () => void): this {
    this.on("connect", callback);
    return this;
  }

  /**
   * Register a callback for the disconnect event.
   * This event is emitted when the client disconnects from the server.
   *
   * @param {() => void} callback - The function to call when the client disconnects
   * @returns {this} The client instance for chaining
   */
  onDisconnect(callback: () => void): this {
    this.on("disconnect", callback);
    return this;
  }

  /**
   * Register a callback for the reconnect event.
   * This event is emitted when the client successfully reconnects to the server
   * after a disconnection.
   *
   * @param {() => void} callback - The function to call when the client reconnects
   * @returns {this} The client instance for chaining
   */
  onReconnect(callback: () => void): this {
    this.on("reconnect", callback);
    return this;
  }

  /**
   * Register a callback for the reconnect failed event.
   * This event is emitted when the client fails to reconnect after reaching
   * the maximum number of reconnect attempts.
   *
   * @param {() => void} callback - The function to call when reconnection fails
   * @returns {this} The client instance for chaining
   */
  onReconnectFailed(callback: () => void): this {
    this.on("reconnectfailed", callback);
    return this;
  }

  /**
   * Resubscribes to all rooms, records, and channels after a reconnection.
   * Triggered during reconnection to restore the client's subscriptions, their handlers, and their configuration.
   *
   * @returns {Promise<void>} A promise that resolves when all resubscriptions are complete.
   */
  private async resubscribeAll(): Promise<void> {
    clientLogger.info("Resubscribing to all subscriptions after reconnect");

    try {
      // rooms
      const roomPromises = Array.from(this.joinedRooms.entries()).map(async ([roomName, presenceCallback]) => {
        try {
          clientLogger.info(`Rejoining room: ${roomName}`);
          await this.joinRoom(roomName, presenceCallback);
          return { roomName, success: true };
        } catch (error) {
          clientLogger.error(`Failed to rejoin room ${roomName}:`, error);
          return { roomName, success: false };
        }
      });

      // wait for rooms to be rejoined first
      const roomResults = await Promise.allSettled(roomPromises);
      const successfulRooms = roomResults
        .filter((r) => r.status === "fulfilled" && r.value.success)
        .map(
          (r) =>
            (
              r as PromiseFulfilledResult<{
                roomName: string;
                success: boolean;
              }>
            ).value.roomName,
        );

      clientLogger.info(`Rejoined ${successfulRooms.length}/${roomPromises.length} rooms`);

      // records
      const recordPromises = Array.from(this.recordSubscriptions.entries()).map(async ([recordId, { callback, mode }]) => {
        try {
          clientLogger.info(`Resubscribing to record: ${recordId}`);
          await this.subscribeRecord(recordId, callback, { mode });
          return true;
        } catch (error) {
          clientLogger.error(`Failed to resubscribe to record ${recordId}:`, error);
          return false;
        }
      });

      // collections
      const collectionPromises = Array.from(this.collectionSubscriptions.entries()).map(async ([collectionId, subscription]) => {
        try {
          clientLogger.info(`Resubscribing to collection: ${collectionId}`);
          await this.subscribeCollection(collectionId, {
            onUpdate: subscription.onUpdate,
            onDiff: subscription.onDiff,
          });
          return true;
        } catch (error) {
          clientLogger.error(`Failed to resubscribe to collection ${collectionId}:`, error);
          return false;
        }
      });

      // channels
      const channelPromises = Array.from(this.channelSubscriptions.entries()).map(async ([channel, { callback, historyLimit }]) => {
        try {
          clientLogger.info(`Resubscribing to channel: ${channel}`);
          await this.subscribeChannel(channel, callback, { historyLimit });
          return true;
        } catch (error) {
          clientLogger.error(`Failed to resubscribe to channel ${channel}:`, error);
          return false;
        }
      });

      // wait for all subscriptions to be resubscribed
      const results = await Promise.allSettled([
        // ...roomPromises,
        ...recordPromises,
        ...channelPromises,
        ...collectionPromises,
      ]);

      const successCount = results.filter((r) => r.status === "fulfilled" && r.value === true).length;

      clientLogger.info(`Resubscribed to ${successfulRooms.length + successCount}/${roomPromises.length + results.length} total subscriptions`);

      // after all resubscriptions are complete,
      // force a presence update for each room
      if (successfulRooms.length > 0) {
        clientLogger.info("Forcing presence update for all rooms after reconnect");

        for (const roomName of successfulRooms) {
          try {
            const updated = await this.forcePresenceUpdate(roomName);
            if (updated) {
              clientLogger.info(`Successfully refreshed presence for room ${roomName}`);
            } else {
              clientLogger.warn(`Failed to refresh presence for room ${roomName} (ARGH)`);
            }
          } catch (err) {
            clientLogger.error(`Error refreshing presence for room ${roomName}:`, err);
          }

          // Small delay between room updates
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch (error) {
      clientLogger.error("Error during resubscription:", error);
    }
  }
}
