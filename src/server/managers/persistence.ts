import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import type { PersistenceAdapter, PersistedMessage, PersistenceOptions } from "../persistence/types";
import { SQLitePersistenceAdapter } from "../persistence/sqlite-adapter";
import { serverLogger } from "../../common/logger";
import { MessageStream } from "../persistence/message-stream";

interface PatternConfig {
  pattern: string | RegExp;
  options: Required<PersistenceOptions>;
}

export class PersistenceManager extends EventEmitter {
  private defaultAdapter: PersistenceAdapter;
  private patterns: PatternConfig[] = [];
  private messageBuffer: Map<string, PersistedMessage[]> = new Map();
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();
  private isShuttingDown = false;
  private initialized = false;

  private messageStream: MessageStream;

  constructor(defaultAdapterOptions: any = {}) {
    super();
    this.defaultAdapter = new SQLitePersistenceAdapter(defaultAdapterOptions);
    this.messageStream = MessageStream.getInstance();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.defaultAdapter.initialize();

      this.messageStream.subscribeToMessages(this.handleStreamMessage.bind(this));

      this.initialized = true;
    } catch (err) {
      serverLogger.error("Failed to initialize persistence manager:", err);
      throw err;
    }
  }

  /**
   * Handle a message received from the internal message stream.
   */
  private handleStreamMessage(message: { channel: string; message: string; instanceId: string; timestamp: number }): void {
    // pass along to main handler which performs necessary checks
    const { channel, message: messageContent, instanceId, timestamp } = message;
    this.handleChannelMessage(channel, messageContent, instanceId, timestamp);
  }

  /**
   * Enable persistence for channels matching the given pattern.
   * @param pattern string or regexp pattern to match channel names
   * @param options persistence options
   */
  enablePersistenceForChannels(pattern: string | RegExp, options: PersistenceOptions = {}): void {
    const fullOptions: Required<PersistenceOptions> = {
      historyLimit: options.historyLimit ?? 50,
      maxMessageSize: options.maxMessageSize ?? 10240,
      filter: options.filter ?? (() => true),
      adapter: options.adapter ?? this.defaultAdapter,
      flushInterval: options.flushInterval ?? 500,
      maxBufferSize: options.maxBufferSize ?? 100,
    };

    // initialize custom adapter if provided and not shutting down
    if (fullOptions.adapter !== this.defaultAdapter && !this.isShuttingDown) {
      fullOptions.adapter.initialize().catch((err) => {
        serverLogger.error(`Failed to initialize adapter for pattern ${pattern}:`, err);
      });
    }

    this.patterns.push({
      pattern,
      options: fullOptions,
    });
  }

  /**
   * Check if a channel has persistence enabled and return its options.
   * @param channel channel name to check
   * @returns the persistence options if enabled, undefined otherwise
   */
  getChannelPersistenceOptions(channel: string): Required<PersistenceOptions> | undefined {
    for (const { pattern, options } of this.patterns) {
      if ((typeof pattern === "string" && pattern === channel) || (pattern instanceof RegExp && pattern.test(channel))) {
        return options;
      }
    }
    return undefined;
  }

  /**
   * Handle an incoming message for potential persistence.
   * @param channel channel the message was published to
   * @param message the message content
   * @param instanceId id of the server instance
   */
  handleChannelMessage(channel: string, message: string, instanceId: string, timestamp?: number): void {
    if (!this.initialized || this.isShuttingDown) return;

    const options = this.getChannelPersistenceOptions(channel);
    if (!options) return; // channel doesn't match any persistence pattern

    if (!options.filter(message, channel)) return; // message filtered out

    if (message.length > options.maxMessageSize) {
      serverLogger.warn(`Message for channel ${channel} exceeds max size (${message.length} > ${options.maxMessageSize}), truncating for persistence`);
      message = message.substring(0, options.maxMessageSize); // truncate
    }

    const persistedMessage: PersistedMessage = {
      id: uuidv4(),
      channel,
      message,
      instanceId,
      timestamp: timestamp || Date.now(),
    };

    if (!this.messageBuffer.has(channel)) {
      this.messageBuffer.set(channel, []);
    }
    this.messageBuffer.get(channel)!.push(persistedMessage);

    // flush if buffer reaches max size
    if (this.messageBuffer.get(channel)!.length >= options.maxBufferSize) {
      this.flushChannel(channel);
      return;
    }

    // start flush timer if not already active for this channel
    if (!this.flushTimers.has(channel)) {
      const timer = setTimeout(() => {
        this.flushChannel(channel);
      }, options.flushInterval);

      // allow process to exit even if timer is pending
      if (timer.unref) {
        timer.unref();
      }

      this.flushTimers.set(channel, timer);
    }
  }

  /**
   * Flush buffered messages for a specific channel to its adapter.
   * @param channel channel to flush
   */
  private async flushChannel(channel: string): Promise<void> {
    if (!this.messageBuffer.has(channel)) return;

    if (this.flushTimers.has(channel)) {
      clearTimeout(this.flushTimers.get(channel)!);
      this.flushTimers.delete(channel);
    }

    const messages = this.messageBuffer.get(channel)!;
    if (messages.length === 0) return;

    // clear buffer before async store to prevent duplicates on potential retry
    this.messageBuffer.set(channel, []);

    const options = this.getChannelPersistenceOptions(channel);
    if (!options) return;

    try {
      await options.adapter.storeMessages(messages);

      this.emit("flushed", { channel, count: messages.length });

      serverLogger.debug(`Flushed ${messages.length} messages for channel ${channel}`);
    } catch (err) {
      serverLogger.error(`Failed to flush messages for channel ${channel}:`, err);

      // on failure, put messages back in buffer for retry (if not shutting down)
      if (!this.isShuttingDown) {
        const currentMessages = this.messageBuffer.get(channel) || [];
        this.messageBuffer.set(channel, [...messages, ...currentMessages]);

        // schedule a retry flush
        if (!this.flushTimers.has(channel)) {
          const timer = setTimeout(() => {
            this.flushChannel(channel);
          }, 1000); // retry after 1s

          if (timer.unref) {
            timer.unref();
          }

          this.flushTimers.set(channel, timer);
        }
      }
    }
  }

  /**
   * Flush all buffered messages across all channels.
   */
  async flushAll(): Promise<void> {
    const channels = Array.from(this.messageBuffer.keys());

    for (const channel of channels) {
      await this.flushChannel(channel);
    }
  }

  /**
   * Get persisted messages for a channel.
   * @param channel channel to get messages for
   * @param since optional cursor (timestamp or message id) to retrieve messages after
   * @param limit maximum number of messages to retrieve
   */
  async getMessages(channel: string, since?: string | number, limit?: number): Promise<PersistedMessage[]> {
    if (!this.initialized) {
      throw new Error("Persistence manager not initialized");
    }

    const options = this.getChannelPersistenceOptions(channel);
    if (!options) {
      throw new Error(`Channel ${channel} does not have persistence enabled`);
    }

    // ensure pending messages are written before retrieving history
    await this.flushChannel(channel);

    return options.adapter.getMessages(channel, since, limit || options.historyLimit);
  }

  /**
   * Shutdown the persistence manager, flushing pending messages and closing adapters.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;

    this.messageStream.unsubscribeFromMessages(this.handleStreamMessage.bind(this));

    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    await this.flushAll();

    const adapters = new Set<PersistenceAdapter>([this.defaultAdapter]);

    for (const { options } of this.patterns) {
      adapters.add(options.adapter);
    }

    for (const adapter of adapters) {
      try {
        await adapter.close();
      } catch (err) {
        serverLogger.error("Error closing persistence adapter:", err);
      }
    }

    this.initialized = false;
  }
}
