import { EventEmitter } from "events";

/**
 * MessageStream provides a unified internal event stream for channel messages.
 * It decouples channel message delivery from persistence, making testing and
 * monitoring easier, and allowing future extensions such as logging, metrics,
 * or replication without changing core logic.
 */
export class MessageStream extends EventEmitter {
  private static instance: MessageStream;

  /**
   * Get the singleton instance of MessageStream
   */
  public static getInstance(): MessageStream {
    if (!MessageStream.instance) {
      MessageStream.instance = new MessageStream();
    }
    return MessageStream.instance;
  }

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Publish a message to the stream
   * @param channel The channel the message was published to
   * @param message The message content
   * @param instanceId ID of the server instance
   */
  publishMessage(channel: string, message: string, instanceId: string): void {
    const timestamp = Date.now();

    this.emit("message", {
      channel,
      message,
      instanceId,
      timestamp,
    });
  }

  /**
   * Subscribe to all messages in the stream
   * @param callback Function to call for each message
   */
  subscribeToMessages(callback: (message: { channel: string; message: string; instanceId: string; timestamp: number }) => void): void {
    this.on("message", callback);
  }

  /**
   * Unsubscribe from messages
   * @param callback The callback function to remove
   */
  unsubscribeFromMessages(callback: (message: { channel: string; message: string; instanceId: string; timestamp: number }) => void): void {
    this.off("message", callback);
  }
}
