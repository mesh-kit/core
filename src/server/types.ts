import type { ServerOptions } from "ws";
import type { RedisOptions } from "ioredis";
import type { Operation } from "fast-json-patch";
import type { Command } from "../common/message";
import type { MeshContext } from "./mesh-context";
import { LogLevel } from "../common/logger";
import type { PersistenceAdapterOptions, PostgreSQLAdapterOptions } from "./persistence/types";

export type SocketMiddleware = (context: MeshContext<any>) => any | Promise<any>;

export type PubSubMessagePayload = {
  targetConnectionIds: string[];
  command: Command;
};

export type RecordUpdatePubSubPayload = {
  recordId: string;
  newValue?: any;
  patch?: Operation[];
  version: number;
  deleted?: boolean;
};

// Ensure ServerOptions is not tree-shaken from the declaration file
export type { ServerOptions } from "ws";

export interface MeshServerOptions extends ServerOptions {
  /**
   * The interval at which to send ping messages to the client.
   *
   * @default 30000
   */
  pingInterval?: number;

  /**
   * The interval at which to send both latency requests and updates to the client.
   *
   * @default 5000
   */
  latencyInterval?: number;
  redisOptions: RedisOptions;

  /**
   * Whether to enable Redis keyspace notifications for presence expiration.
   * When enabled, connections will be automatically marked as offline when their presence TTL expires.
   *
   * @default true
   */
  enablePresenceExpirationEvents?: boolean;

  /**
   * The maximum number of consecutive ping intervals the server will wait
   * for a pong response before considering the client disconnected.
   * A value of 1 means the client must respond within roughly 2 * pingInterval
   * before being disconnected. Setting it to 0 is not recommended as it will
   * immediately disconnect the client if it doesn't respond to the first ping in
   * exactly `pingInterval` milliseconds, which doesn't provide wiggle room for
   * network latency.
   *
   * @see pingInterval
   * @default 1
   */
  maxMissedPongs?: number;

  /**
   * The log level for server-side logs.
   * Controls which messages are displayed in the console.
   *
   * @default LogLevel.ERROR
   */
  logLevel?: LogLevel;

  /**
   * Options for the persistence layer.
   * By default, persistence uses an in-memory SQLite database.
   * To persist data across restarts, specify a file path.
   *
   * @example
   * ```
   * persistenceOptions: {
   *   filename: "./data/channels.db"
   * }
   * ```
   */
  persistenceOptions?: PersistenceAdapterOptions | PostgreSQLAdapterOptions;

  /**
   * Adapter type for persistence layer.
   * @default "sqlite"
   */
  persistenceAdapter?: "sqlite" | "postgres";
}

export type ChannelPattern = string | RegExp;
