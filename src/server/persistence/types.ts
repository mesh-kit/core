export interface PersistenceAdapter {
  initialize(): Promise<void>;
  storeMessages(messages: PersistedMessage[]): Promise<void>;
  getMessages(channel: string, since?: string | number, limit?: number): Promise<PersistedMessage[]>;
  close(): Promise<void>;
}

export interface PersistedMessage {
  id: string;
  channel: string;
  message: string;
  instanceId: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface PersistenceOptions {
  /**
   * Maximum number of messages to retain per channel
   * @default 50
   */
  historyLimit?: number;

  /**
   * Maximum message size allowed for persistence in bytes
   * If a message exceeds this size, it will still be delivered to subscribers,
   * but a truncated version (or nothing) will be saved to the database
   * @default 10240 (10KB)
   */
  maxMessageSize?: number;

  /**
   * Function to filter messages for persistence
   * Return false to skip persistence for a specific message
   */
  filter?: (message: string, channel: string) => boolean;

  /**
   * Optional adapter override for this pattern
   */
  adapter?: PersistenceAdapter;

  /**
   * How often (in ms) to flush buffered messages to the database
   * @default 500
   */
  flushInterval?: number;

  /**
   * Maximum number of messages to hold in memory per channel
   * If this limit is reached, the buffer is flushed immediately
   * @default 100
   */
  maxBufferSize?: number;
}

export interface PersistenceAdapterOptions {
  /**
   * Database file path for file-based adapters
   * @default ":memory:"
   */
  filename?: string;
}
