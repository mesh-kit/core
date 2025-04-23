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

describe.sequential("Multiple instances", () => {
  let serverA: MeshServer;
  let serverB: MeshServer;
  let clientA: MeshClient;
  let clientB: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    serverA = createTestServer(6677);
    serverB = createTestServer(6688);
    await serverA.ready();
    await serverB.ready();

    clientA = new MeshClient(`ws://localhost:${6677}`);
    clientB = new MeshClient(`ws://localhost:${6688}`);
  });

  afterEach(async () => {
    await clientA.close();
    await clientB.close();

    await serverA.close();
    await serverB.close();
  });

  test("broadcast should work across instances", async () => {
    serverA.exposeCommand("broadcast", async (ctx) => {
      await serverA.broadcast("hello", "Hello!");
    });

    await clientA.connect();
    await clientB.connect();

    let receivedA = false;
    let receivedB = false;

    clientA.on("hello", (data) => {
      if (data === "Hello!") receivedA = true;
    });

    clientB.on("hello", (data) => {
      if (data === "Hello!") receivedB = true;
    });

    await clientA.command("broadcast", {});

    // wait for both events, or timeout
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!(receivedA && receivedB)) return;
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }, 10);

      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 10000);
    });

    expect(receivedA).toBe(true);
    expect(receivedB).toBe(true);
  }, 10000);

  test("broadcastRoom should work across instances", async () => {
    [serverA, serverB].forEach((server) =>
      server.exposeCommand("join-room", async (ctx) => {
        await server.addToRoom(ctx.payload.room, ctx.connection);
        return { joined: true };
      })
    );

    serverA.exposeCommand("broadcast-room", async (ctx) => {
      await serverA.broadcastRoom(
        ctx.payload.room,
        "room-message",
        ctx.payload.message
      );
      return { sent: true };
    });

    await clientA.connect();
    await clientB.connect();

    let receivedA = false;
    let receivedB = false;

    clientA.on("room-message", (data) => {
      if (data === "hello") receivedA = true;
    });

    clientB.on("room-message", (data) => {
      if (data === "hello") receivedB = true;
    });

    await clientA.command("join-room", { room: "test-room" });
    await clientB.command("join-room", { room: "test-room" });

    await clientA.command("broadcast-room", {
      room: "test-room",
      message: "hello",
    });

    // wait for both events, or timeout
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!(receivedA && receivedB)) return;
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }, 10);

      const timeout = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 10000);
    });

    expect(receivedA).toBe(true);
    expect(receivedB).toBe(true);
  }, 10000);
});
