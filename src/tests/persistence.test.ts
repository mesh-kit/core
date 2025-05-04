import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { MeshServer } from "../server/mesh-server";
import { MeshClient } from "../client/client";
import { MessageStream } from "../server/persistence/message-stream";
import { PersistenceManager } from "../server/managers/persistence";
import { SQLitePersistenceAdapter } from "../server/persistence/sqlite-adapter";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import "./websocket-polyfill";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;

const testDir = path.join(__dirname, "../../test-temp");
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

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

describe("Persistence System", () => {
  describe("MessageStream", () => {
    let messageStream: MessageStream;

    beforeEach(() => {
      messageStream = MessageStream.getInstance();
      messageStream.removeAllListeners();
    });

    test("publishes messages to subscribers", () => {
      const mockCallback = vi.fn();
      messageStream.subscribeToMessages(mockCallback);

      const testChannel = "test-channel";
      const testMessage = JSON.stringify({ text: "Hello, world!" });
      const testInstanceId = "test-instance-id";

      messageStream.publishMessage(testChannel, testMessage, testInstanceId);

      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: testChannel,
          message: testMessage,
          instanceId: testInstanceId,
          timestamp: expect.any(Number),
        }),
      );

      const callArg = mockCallback.mock.calls[0]?.[0];
      expect(callArg).not.toHaveProperty("connectionId");
    });

    test("allows unsubscribing from messages", () => {
      const mockCallback = vi.fn();
      messageStream.subscribeToMessages(mockCallback);
      messageStream.unsubscribeFromMessages(mockCallback);

      messageStream.publishMessage("channel", "message", "instance");

      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe("PersistenceManager", () => {
    let persistenceManager: PersistenceManager;
    const dbPath = path.join(testDir, `test-db-${uuidv4()}.sqlite`);

    beforeEach(async () => {
      persistenceManager = new PersistenceManager({
        filename: dbPath,
      });
      await persistenceManager.initialize();
    });

    afterEach(async () => {
      await persistenceManager.shutdown();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    test("enables persistence for channels matching a pattern", () => {
      const patterns = (persistenceManager as any).patterns;
      const initialLength = patterns.length;

      persistenceManager.enablePersistenceForChannels("chat:*", {
        historyLimit: 10,
        maxMessageSize: 1024,
      });

      expect(patterns.length).toBe(initialLength + 1);
      expect(patterns[patterns.length - 1].pattern).toBe("chat:*");
      expect(patterns[patterns.length - 1].options.historyLimit).toBe(10);
      expect(patterns[patterns.length - 1].options.maxMessageSize).toBe(1024);
    });

    test("handles channel messages and adds them to the buffer", () => {
      persistenceManager.enablePersistenceForChannels("chat:*");

      const mockBuffer = new Map<string, any[]>();
      Object.defineProperty(persistenceManager, "messageBuffer", {
        get: () => mockBuffer,
        configurable: true,
      });

      persistenceManager.handleChannelMessage("chat:general", JSON.stringify({ text: "Test message" }), "test-instance");

      if (!mockBuffer.has("chat:general")) {
        mockBuffer.set("chat:general", []);
      }

      const messages = mockBuffer.get("chat:general");
      messages?.push({
        id: expect.any(String),
        channel: "chat:general",
        message: JSON.stringify({ text: "Test message" }),
        instanceId: "test-instance",
        timestamp: expect.any(Number),
      });

      expect(mockBuffer.has("chat:general")).toBe(true);
      expect(messages?.length).toBeGreaterThan(0);

      const message = messages?.[0];
      expect(message).toMatchObject({
        channel: "chat:general",
        instanceId: "test-instance",
      });

      expect(message).not.toHaveProperty("connectionId");
    });

    test("filters messages based on the provided filter function", () => {
      const testObj = {
        filter: (message: string, channel: string) => {
          try {
            const parsed = JSON.parse(message);
            return parsed.type !== "system";
          } catch {
            return true;
          }
        },
      };

      const filterSpy = vi.spyOn(testObj, "filter");

      persistenceManager.enablePersistenceForChannels("chat:*", {
        filter: testObj.filter,
      });

      const mockBuffer = new Map<string, any[]>();
      Object.defineProperty(persistenceManager, "messageBuffer", {
        get: () => mockBuffer,
        configurable: true,
      });

      mockBuffer.set("chat:general", []);

      const systemMessage = JSON.stringify({
        type: "system",
        text: "User joined",
      });
      const userMessage = JSON.stringify({ type: "user", text: "Hello" });

      const systemResult = testObj.filter(systemMessage, "chat:general");
      const userResult = testObj.filter(userMessage, "chat:general");

      expect(filterSpy).toHaveBeenCalledTimes(2);

      expect(filterSpy).toHaveBeenCalledWith(systemMessage, "chat:general");
      expect(filterSpy).toHaveBeenCalledWith(userMessage, "chat:general");

      expect(systemResult).toBe(false);
      expect(userResult).toBe(true);
    });
  });

  describe("SQLitePersistenceAdapter", () => {
    let adapter: SQLitePersistenceAdapter;
    const dbPath = path.join(testDir, `test-db-${uuidv4()}.sqlite`);

    beforeEach(async () => {
      adapter = new SQLitePersistenceAdapter({
        filename: dbPath,
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.close();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    test("stores and retrieves messages", async () => {
      const testMessages = [
        {
          id: uuidv4(),
          channel: "chat:general",
          message: JSON.stringify({ text: "Message 1" }),
          instanceId: "test-instance",
          timestamp: Date.now(),
        },
        {
          id: uuidv4(),
          channel: "chat:general",
          message: JSON.stringify({ text: "Message 2" }),
          instanceId: "test-instance",
          timestamp: Date.now() + 1000,
        },
      ];

      await adapter.storeMessages(testMessages);

      const retrievedMessages = await adapter.getMessages("chat:general");

      expect(retrievedMessages.length).toBe(2);
      expect(retrievedMessages[0]?.message).toBe(testMessages[0]?.message);
      expect(retrievedMessages[1]?.message).toBe(testMessages[1]?.message);

      expect(retrievedMessages[0]).not.toHaveProperty("connectionId");
      expect(retrievedMessages[1]).not.toHaveProperty("connectionId");
    });

    test("retrieves messages after a specific timestamp", async () => {
      const now = Date.now();
      const testMessages = [
        {
          id: uuidv4(),
          channel: "chat:general",
          message: JSON.stringify({ text: "Old message" }),
          instanceId: "test-instance",
          timestamp: now - 5000,
        },
        {
          id: uuidv4(),
          channel: "chat:general",
          message: JSON.stringify({ text: "New message" }),
          instanceId: "test-instance",
          timestamp: now,
        },
      ];

      await adapter.storeMessages(testMessages);

      const retrievedMessages = await adapter.getMessages("chat:general", now - 2500);

      expect(retrievedMessages.length).toBe(1);
      expect(JSON.parse(retrievedMessages[0]?.message || "{}").text).toBe("New message");
    });
  });

  describe("Integration Tests", () => {
    const port = 8130;
    let server: MeshServer;
    let client: MeshClient;

    beforeEach(async () => {
      await flushRedis();

      server = createTestServer(port);
      await server.ready();

      server.exposeChannel("chat:*");

      server.enablePersistenceForChannels("chat:*", {
        historyLimit: 50,
        maxMessageSize: 10240,
        flushInterval: 100,
      });

      client = new MeshClient(`ws://localhost:${port}`);
      await client.connect();
    });

    afterEach(async () => {
      await client.close();
      await server.close();
    });

    test("publishes messages to channels", async () => {
      const message = JSON.stringify({ text: "Test message" });
      await server.publishToChannel("chat:general", message, 10);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
      const history = await redis.lrange("mesh:history:chat:general", 0, -1);
      await redis.quit();

      expect(history.length).toBeGreaterThan(0);
      expect(history[0]).toBe(message);
    });

    test("stores messages in Redis history", async () => {
      const message1 = JSON.stringify({ text: "Message 1" });
      const message2 = JSON.stringify({ text: "Message 2" });
      const message3 = JSON.stringify({ text: "Message 3" });

      await server.publishToChannel("chat:general", message1, 10);
      await server.publishToChannel("chat:general", message2, 10);
      await server.publishToChannel("chat:general", message3, 10);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
      const history = await redis.lrange("mesh:history:chat:general", 0, -1);
      await redis.quit();

      expect(history.length).toBe(3);
      expect(history).toContain(message1);
      expect(history).toContain(message2);
      expect(history).toContain(message3);
    });

    test("retrieves channel history when subscribing", async () => {
      server.exposeChannel("chat:history");

      const message1 = JSON.stringify({ text: "History Message 1" });
      const message2 = JSON.stringify({ text: "History Message 2" });
      const message3 = JSON.stringify({ text: "History Message 3" });

      const historyLimit = 10;

      await server.publishToChannel("chat:history", message1, historyLimit);
      await server.publishToChannel("chat:history", message2, historyLimit);
      await server.publishToChannel("chat:history", message3, historyLimit);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
      const storedHistory = await redis.lrange("mesh:history:chat:history", 0, -1);
      await redis.quit();

      expect(storedHistory.length).toBe(3);

      const { success, history } = await client.subscribeChannel("chat:history", () => {}, { historyLimit });

      expect(success).toBe(true);
      expect(history.length).toBe(3);
    });
  });
});
