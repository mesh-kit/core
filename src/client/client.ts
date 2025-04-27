import { EventEmitter } from "eventemitter3";
import { CodeError } from "../common/codeerror";
import { Status } from "../common/status";
import { Connection } from "./connection";
import type { Operation } from "fast-json-patch";

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

export type PresenceUpdateCallback = (
  update: PresenceUpdate
) => void | Promise<void>;

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
      callback: (update: {
        recordId: string;
        full?: any;
        patch?: Operation[];
        version: number;
      }) => void | Promise<void>;
      localVersion: number;
      mode: "patch" | "full";
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

  private presenceTrackedRooms: Set<string> = new Set();
  private presenceRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private presenceRefreshInterval = 15000;

  private joinedRooms: Map<
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
    };

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
    if (
      timeSinceActivity > this.options.pingTimeout &&
      this._status === Status.ONLINE
    ) {
      try {
        this.command("mesh/noop", {}, 5000).catch(() => {
          console.log(
            `[MeshClient] No activity for ${timeSinceActivity}ms, forcing reconnect`
          );
          this.forceReconnect();
        });
      } catch (e) {
        // if we get no response from the noop, we'll assume the connection is dead
        // and force a reconnect
        this.forceReconnect();
      }
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
      this._isBrowser =
        !!(global as any).document &&
        typeof (global as any).document.addEventListener === "function";

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
        const events = [
          "mousedown",
          "keydown",
          "touchstart",
          "visibilitychange",
        ];

        events.forEach((eventName) => {
          doc.addEventListener(eventName, () => {
            const wasInactive =
              Date.now() - this._lastActivityTime > this.options.pingTimeout;
            this._lastActivityTime = Date.now();

            // if visibility changed to visible and we were inactive for too long, reconnect
            if (
              eventName === "visibilitychange" &&
              doc.visibilityState === "visible" &&
              wasInactive
            ) {
              this.forceReconnect();
            }
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
      } else if (data.command === "mesh/presence-update") {
        this.handlePresenceUpdate(data.payload);
      } else if (data.command === "mesh/subscription-message") {
        this.emit(data.command, data.payload);
      } else {
        const systemCommands = [
          "ping",
          "pong",
          "latency",
          "latency:request",
          "latency:response",
        ];
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

    if (
      this._status === Status.CONNECTING ||
      this._status === Status.RECONNECTING
    ) {
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
          reject(
            new CodeError(
              "WebSocket connection error",
              "ECONNECTION",
              "ConnectionError"
            )
          );
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

    this.startPresenceRefreshTimer();
  }

  private startPresenceRefreshTimer(): void {
    if (this.presenceRefreshTimer) {
      return;
    }

    this.presenceRefreshTimer = setInterval(() => {
      this.refreshAllPresence();
    }, this.presenceRefreshInterval);
  }

  private stopPresenceRefreshTimer(): void {
    if (this.presenceRefreshTimer) {
      clearInterval(this.presenceRefreshTimer);
      this.presenceRefreshTimer = undefined;
    }
  }

  private async refreshAllPresence(): Promise<void> {
    if (
      this._status !== Status.ONLINE ||
      this.presenceTrackedRooms.size === 0
    ) {
      return;
    }

    const roomsToRefresh = Array.from(this.presenceTrackedRooms);

    const results = await Promise.allSettled(
      roomsToRefresh.map(async (roomName) => {
        try {
          return await this.command(
            "mesh/refresh-presence",
            { roomName },
            10000
          );
        } catch (error) {
          console.error(
            `[MeshClient] Failed to refresh presence for room ${roomName}:`,
            error
          );
          return false;
        }
      })
    );

    const successCount = results.filter(
      (r) => r.status === "fulfilled" && r.value === true
    ).length;
    if (successCount < roomsToRefresh.length) {
      console.warn(
        `[MeshClient] Refreshed presence for ${successCount}/${roomsToRefresh.length} rooms`
      );
    }
  }

  private checkPingStatus(): void {
    this.missedPings++;

    if (this.missedPings > this.options.maxMissedPings) {
      if (this.options.shouldReconnect) {
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

    this.stopPresenceRefreshTimer();

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

    this.stopPresenceRefreshTimer();

    let attempt = 1;

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // ignore errors during close
      }
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
  command(
    command: string,
    payload?: any,
    expiresIn: number = 30000
  ): Promise<any> {
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

  private async handleRecordUpdate(payload: {
    recordId: string;
    full?: any;
    patch?: Operation[];
    version: number;
  }) {
    const { recordId, full, patch, version } = payload;
    const subscription = this.recordSubscriptions.get(recordId);

    if (!subscription) {
      return;
    }

    if (patch) {
      if (version !== subscription.localVersion + 1) {
        // desync
        console.warn(
          `[MeshClient] Desync detected for record ${recordId}. Expected version ${
            subscription.localVersion + 1
          }, got ${version}. Resubscribing to request full record.`
        );
        // unsubscribe and resubscribe to force a full update
        await this.unsubscribeRecord(recordId);
        await this.subscribeRecord(recordId, subscription.callback, {
          mode: subscription.mode,
        });
        return;
      }

      subscription.localVersion = version;
      await subscription.callback({ recordId, patch, version });

      return;
    }

    if (full !== undefined) {
      subscription.localVersion = version;
      await subscription.callback({ recordId, full, version });
    }
  }

  /**
   * Subscribes to a specific channel and registers a callback to be invoked
   * whenever a message is received on that channel. Optionally retrieves a
   * limited number of historical messages and passes them to the callback upon subscription.
   *
   * @param {string} channel - The name of the channel to subscribe to.
   * @param {(message: string) => void | Promise<void>} callback - The function to be called for each message received on the channel.
   * @param {{ historyLimit?: number }} [options] - Optional subscription options, such as the maximum number of historical messages to retrieve.
   * @returns {Promise<{ success: boolean; history: string[] }>} A promise that resolves with the subscription result,
   *          including a success flag and an array of historical messages.
   */
  subscribeChannel(
    channel: string,
    callback: (message: string) => void | Promise<void>,
    options?: { historyLimit?: number }
  ): Promise<{ success: boolean; history: string[] }> {
    this.channelSubscriptions.set(channel, {
      callback,
      historyLimit: options?.historyLimit,
    });

    this.on(
      "mesh/subscription-message",
      async (data: { channel: string; message: string }) => {
        if (data.channel === channel) {
          await callback(data.message);
        }
      }
    );

    const historyLimit = options?.historyLimit;

    return this.command("mesh/subscribe-channel", {
      channel,
      historyLimit,
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
   * Subscribes to a specific record and registers a callback for updates.
   *
   * @param {string} recordId - The ID of the record to subscribe to.
   * @param {(update: { full?: any; patch?: Operation[]; version: number }) => void | Promise<void>} callback - Function called on updates.
   * @param {{ mode?: "patch" | "full" }} [options] - Subscription mode ('patch' or 'full', default 'full').
   * @returns {Promise<{ success: boolean; record: any | null; version: number }>} Initial state of the record.
   */
  async subscribeRecord(
    recordId: string,
    callback: (update: {
      recordId: string;
      full?: any;
      patch?: Operation[];
      version: number;
    }) => void | Promise<void>,
    options?: { mode?: "patch" | "full" }
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

        await callback({
          recordId,
          full: result.record,
          version: result.version,
        });
      }

      return {
        success: result.success,
        record: result.record ?? null,
        version: result.version ?? 0,
      };
    } catch (error) {
      console.error(
        `[MeshClient] Failed to subscribe to record ${recordId}:`,
        error
      );
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
      console.error(
        `[MeshClient] Failed to unsubscribe from record ${recordId}:`,
        error
      );
      return false;
    }
  }

  /**
   * Publishes an update to a specific record if the client has write permissions.
   *
   * @param {string} recordId - The ID of the record to update.
   * @param {any} newValue - The new value for the record.
   * @returns {Promise<boolean>} True if the update was successfully published, false otherwise.
   */
  async publishRecordUpdate(recordId: string, newValue: any): Promise<boolean> {
    try {
      const result = await this.command("mesh/publish-record-update", {
        recordId,
        newValue,
      });
      return result.success === true;
    } catch (error) {
      console.error(
        `[MeshClient] Failed to publish update for record ${recordId}:`,
        error
      );
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
  async joinRoom(
    roomName: string,
    onPresenceUpdate?: PresenceUpdateCallback
  ): Promise<{ success: boolean; present: string[] }> {
    const joinResult = await this.command("mesh/join-room", { roomName });

    if (!joinResult.success) {
      return { success: false, present: [] };
    }

    this.joinedRooms.set(roomName, onPresenceUpdate);

    // ensures presence is refreshed even without a presence subscription
    this.presenceTrackedRooms.add(roomName);
    this.startPresenceRefreshTimer();

    if (!onPresenceUpdate) {
      return { success: true, present: joinResult.present || [] };
    }

    const { success: subSuccess, present } = await this.subscribePresence(
      roomName,
      onPresenceUpdate
    );
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
      this.presenceTrackedRooms.delete(roomName);

      if (this.presenceTrackedRooms.size === 0) {
        this.stopPresenceRefreshTimer();
      }

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
    callback: PresenceUpdateCallback
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
        this.presenceTrackedRooms.add(roomName);
        this.startPresenceRefreshTimer();

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
      console.error(
        `[MeshClient] Failed to subscribe to presence for room ${roomName}:`,
        error
      );
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
        this.presenceTrackedRooms.delete(roomName);

        if (this.presenceTrackedRooms.size === 0) {
          this.stopPresenceRefreshTimer();
        }
      }
      return success;
    } catch (error) {
      console.error(
        `[MeshClient] Failed to unsubscribe from presence for room ${roomName}:`,
        error
      );
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
    }
  ): Promise<boolean> {
    try {
      return await this.command("mesh/publish-presence-state", {
        roomName,
        state: options.state,
        expireAfter: options.expireAfter,
      });
    } catch (error) {
      console.error(
        `[MeshClient] Failed to publish presence state for room ${roomName}:`,
        error
      );
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
      console.error(
        `[MeshClient] Failed to clear presence state for room ${roomName}:`,
        error
      );
      return false;
    }
  }

  /**
   * Manually refreshes presence for a specific room
   *
   * @param {string} roomName - The name of the room to refresh presence for
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async refreshPresence(roomName: string): Promise<boolean> {
    try {
      if (this._status !== Status.ONLINE) {
        return false;
      }

      const result = await this.command(
        "mesh/refresh-presence",
        { roomName },
        10000
      );

      // ensure the room is in the tracked set for future auto-refreshes
      if (result === true) {
        this.presenceTrackedRooms.add(roomName);
        this.startPresenceRefreshTimer();
      }

      return result === true;
    } catch (error) {
      console.error(
        `[MeshClient] Failed to refresh presence for room ${roomName}:`,
        error
      );
      return false;
    }
  }

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
      console.error(
        `[MeshClient] Failed to get metadata for room ${roomName}:`,
        error
      );
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
      console.error(
        `[MeshClient] Failed to get metadata for connection${idText}:`,
        error
      );
      return null;
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
    console.log(
      "[MeshClient] Resubscribing to all subscriptions after reconnect"
    );

    try {
      // rooms
      const roomPromises = Array.from(this.joinedRooms.entries()).map(
        async ([roomName, presenceCallback]) => {
          try {
            console.log(`[MeshClient] Rejoining room: ${roomName}`);
            await this.joinRoom(roomName, presenceCallback);
            return true;
          } catch (error) {
            console.error(
              `[MeshClient] Failed to rejoin room ${roomName}:`,
              error
            );
            return false;
          }
        }
      );

      // records
      const recordPromises = Array.from(this.recordSubscriptions.entries()).map(
        async ([recordId, { callback, mode }]) => {
          try {
            console.log(`[MeshClient] Resubscribing to record: ${recordId}`);
            await this.subscribeRecord(recordId, callback, { mode });
            return true;
          } catch (error) {
            console.error(
              `[MeshClient] Failed to resubscribe to record ${recordId}:`,
              error
            );
            return false;
          }
        }
      );

      // channels
      const channelPromises = Array.from(
        this.channelSubscriptions.entries()
      ).map(async ([channel, { callback, historyLimit }]) => {
        try {
          console.log(`[MeshClient] Resubscribing to channel: ${channel}`);
          await this.subscribeChannel(channel, callback, { historyLimit });
          return true;
        } catch (error) {
          console.error(
            `[MeshClient] Failed to resubscribe to channel ${channel}:`,
            error
          );
          return false;
        }
      });

      // wait for all subscriptions to be resubscribed
      const results = await Promise.allSettled([
        ...roomPromises,
        ...recordPromises,
        ...channelPromises,
      ]);

      const successCount = results.filter(
        (r) => r.status === "fulfilled" && r.value === true
      ).length;

      console.log(
        `[MeshClient] Resubscribed to ${successCount}/${results.length} subscriptions`
      );
    } catch (error) {
      console.error("[MeshClient] Error during resubscription:", error);
    }
  }
}
