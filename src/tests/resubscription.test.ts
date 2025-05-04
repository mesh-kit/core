import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import "./websocket-polyfill";
import { MeshServer } from "../server";
import { MeshClient } from "../client";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;

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

describe("Resubscription after reconnect", () => {
  const port = 8132;
  let server: MeshServer;
  let client: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);

    // Expose channels and records for testing
    server.exposeChannel("test:channel");
    server.exposeRecord("test:record");
    server.exposeWritableRecord("test:record");

    await server.ready();

    client = new MeshClient(`ws://localhost:${port}`);
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  test("client resubscribes to all subscriptions after reconnect", async () => {
    const channelMessages: string[] = [];
    const recordUpdates: any[] = [];
    const presenceUpdates: any[] = [];

    await client.subscribeChannel("test:channel", (message) => {
      channelMessages.push(message);
    });

    await client.subscribeRecord("test:record", (update) => {
      recordUpdates.push(update);
    });

    await client.joinRoom("test:room", (update) => {
      presenceUpdates.push(update);
    });

    const forceReconnect = (client as any).forceReconnect.bind(client);
    forceReconnect();

    await new Promise<void>((resolve) => {
      client.once("reconnect", () => {
        // wait for resubscriptions to complete
        setTimeout(resolve, 100);
      });
    });

    // verify channel subscription is restored by sending a message
    await server.publishToChannel("test:channel", "Test message after reconnect");

    // verify record subscription is restored by updating the record
    await server.publishRecordUpdate("test:record", { value: "updated" });

    // verify room subscription is restored by checking if client is in the room
    const roomMembers = await server.getRoomMembers("test:room");
    const clientInRoom = roomMembers.includes(client.connectionId!);

    // wait for messages to be processed
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(clientInRoom).toBe(true);
    expect(channelMessages).toContain("Test message after reconnect");
    expect(recordUpdates.length).toBeGreaterThan(0);

    // ensure latest record update exists
    const latestRecordUpdate = recordUpdates[recordUpdates.length - 1];
    expect(latestRecordUpdate.full || latestRecordUpdate.recordId).toBeDefined();
  });
});
