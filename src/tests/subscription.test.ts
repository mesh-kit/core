import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import "./websocket-polyfill";
import { MeshServer } from "../server";
import { MeshClient } from "../client";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT
  ? parseInt(process.env.REDIS_PORT, 10)
  : 6379;

const createTestServer = (port: number) =>
  new MeshServer({
    port,
    redisOptions: {
      host: REDIS_HOST,
      port: REDIS_PORT,
    },
  });

const flushRedis = async () => {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.flushdb();
  await redis.quit();
};

describe("Redis Channel Subscription", () => {
  const port = 8129;
  let server: MeshServer;
  let client1: MeshClient;
  let client2: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    server.exposeChannel("test:channel");
    server.exposeChannel("test:channel2");
    await server.ready();

    client1 = new MeshClient(`ws://localhost:${port}`);
    client2 = new MeshClient(`ws://localhost:${port}`);
  });

  afterEach(async () => {
    await client1.close();
    await client2.close();
    await server.close();
  });

  test("client can subscribe to a Redis channel", async () => {
    await client1.connect();

    const result = await client1.subscribeChannel("test:channel", () => {});
    expect(result.success).toBe(true);
    expect(Array.isArray(result.history)).toBe(true);
  });

  test("client cannot subscribe to an unexposed channel", async () => {
    await client1.connect();

    const result = await client1.subscribeChannel("unexposed:channel", () => {});
    expect(result.success).toBe(false);
    expect(Array.isArray(result.history)).toBe(true);
    expect(result.history.length).toBe(0);
  });

  test("client receives messages from subscribed channel", async () => {
    await client1.connect();

    let receivedMessage: string | null = null;

    await client1.subscribeChannel("test:channel", (message) => {
      receivedMessage = message;
    });

    await server.publishToChannel("test:channel", "Hello, Redis!");

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (receivedMessage !== null) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);

      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 1000);
    });

    expect(receivedMessage).toBe("Hello, Redis!");
  });

  test("client can unsubscribe from a channel", async () => {
    await client1.connect();

    let messageCount = 0;

    await client1.subscribeChannel("test:channel", () => {
      messageCount++;
    });

    await server.publishToChannel("test:channel", "Message 1");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    const unsubResult = await client1.unsubscribeChannel("test:channel");
    expect(unsubResult).toBe(true);

    await server.publishToChannel("test:channel", "Message 2");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(messageCount).toBe(1);
  });

  test("multiple clients can subscribe to the same channel", async () => {
    await client1.connect();
    await client2.connect();

    let client1Received: string | null = null;
    let client2Received: string | null = null;

    await client1.subscribeChannel("test:channel", (message) => {
      client1Received = message;
    });

    await client2.subscribeChannel("test:channel", (message) => {
      client2Received = message;
    });

    await server.publishToChannel("test:channel", "Broadcast message");

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client1Received !== null && client2Received !== null) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);

      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 1000);
    });

    expect(client1Received).toBe("Broadcast message");
    expect(client2Received).toBe("Broadcast message");
  });

  test("messages are only delivered to subscribed channels", async () => {
    await client1.connect();

    const channel1Messages: string[] = [];
    const channel2Messages: string[] = [];

    await client1.subscribeChannel("test:channel", (message) => {
      channel1Messages.push(message);
    });

    await client1.subscribeChannel("test:channel2", (message) => {
      channel2Messages.push(message);
    });

    await server.publishToChannel("test:channel", "Message for channel 1");
    await server.publishToChannel("test:channel2", "Message for channel 2");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(channel1Messages).toContain("Message for channel 1");
    expect(channel1Messages).not.toContain("Message for channel 2");

    expect(channel2Messages).toContain("Message for channel 2");
    expect(channel2Messages).not.toContain("Message for channel 1");
  });

  test("unsubscribing from a non-subscribed channel returns false", async () => {
    await client1.connect();

    const result = await client1.unsubscribeChannel("not:subscribed");
    expect(result).toBe(false);
  });

  test("channel guard prevents unauthorized subscriptions", async () => {
    await client1.connect();
    await client2.connect();

    const connections = Object.values(
      server.connectionManager.getLocalConnections()
    );
    const connection1 = connections[0]!;

    // only allow the first client to subscribe to the channel
    server.exposeChannel(
      "guarded:channel",
      (connection, channel) => connection.id === connection1.id
    );

    const result1 = await client1.subscribeChannel("guarded:channel", () => {});
    const result2 = await client2.subscribeChannel("guarded:channel", () => {});

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(false);
  });

  test("exposeChannel guard callback passes the correct channel name", async () => {
    await client1.connect();

    let receivedChannel: string | null = null;

    server.exposeChannel("test:channel", (connection, channel) => {
      receivedChannel = channel;
      return true;
    });

    await client1.subscribeChannel("test:channel", () => {});

    expect(receivedChannel).toBe("test:channel");

    receivedChannel = null;

    server.exposeChannel(/^test:channel:\d+$/, (connection, channel) => {
      receivedChannel = channel;
      return true;
    });

    await client1.subscribeChannel("test:channel:1", () => {});

    expect(receivedChannel).toBe("test:channel:1");
  });

  test("client receives channel history when subscribing with historyLimit", async () => {
    await client1.connect();

    const historySize = 10;
    await server.publishToChannel("test:channel", "History message 1", historySize);
    await server.publishToChannel("test:channel", "History message 2", historySize);
    await server.publishToChannel("test:channel", "History message 3", historySize);
    await server.publishToChannel("test:channel", "History message 4", historySize);
    await server.publishToChannel("test:channel", "History message 5", historySize);
    
    const receivedMessages: string[] = [];
    
    const { success, history } = await client1.subscribeChannel("test:channel", (message) => {
      receivedMessages.push(message);
    }, { historyLimit: 3 });
    
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    
    expect(success).toBe(true);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(3);
    
    // ensure newest are first
    expect(history[0]).toBe("History message 5");
    expect(history[1]).toBe("History message 4");
    expect(history[2]).toBe("History message 3");
    
    expect(receivedMessages).toContain("History message 3");
    expect(receivedMessages).toContain("History message 4");
    expect(receivedMessages).toContain("History message 5");
    expect(receivedMessages.length).toBe(3);
  });
});
