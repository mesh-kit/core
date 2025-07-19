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

describe("MeshServer", () => {
  const port = 8128;
  let server: MeshServer;
  let clientA: MeshClient;
  let clientB: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    await server.ready();

    clientA = new MeshClient(`ws://localhost:${port}`);
    clientB = new MeshClient(`ws://localhost:${port}`);
  });

  afterEach(async () => {
    await clientA.close();
    await clientB.close();

    await server.close();
  });

  test("isInRoom", async () => {
    await clientA.connect();
    await clientB.connect();

    await clientA.joinRoom("room1");
    await clientB.joinRoom("room1");
    await clientA.joinRoom("room2");

    const connectionA = server.connectionManager.getLocalConnections()[0]!;
    const connectionB = server.connectionManager.getLocalConnections()[1]!;

    expect(await server.isInRoom("room1", connectionA)).toBe(true);
    expect(await server.isInRoom("room1", connectionB)).toBe(true);
    expect(await server.isInRoom("room2", connectionA)).toBe(true);
    expect(await server.isInRoom("room2", connectionB)).toBe(false);
    expect(await server.isInRoom("room3", connectionA)).toBe(false);
  });

  test("room metadata", async () => {
    const room1 = "meta-room-1";
    const room2 = "meta-room-2";

    const initialMeta1 = { topic: "General", owner: "userA" };
    await server.roomManager.setMetadata(room1, initialMeta1);

    let meta1 = await server.roomManager.getMetadata(room1);
    expect(meta1).toEqual(initialMeta1);

    const updateMeta1 = { topic: "Updated Topic", settings: { max: 10 } };
    await server.roomManager.setMetadata(room1, updateMeta1, { strategy: "merge" });

    meta1 = await server.roomManager.getMetadata(room1);
    expect(meta1).toEqual({ ...initialMeta1, ...updateMeta1 });

    const initialMeta2 = { topic: "Gaming", private: true };
    await server.roomManager.setMetadata(room2, initialMeta2);

    expect(await server.roomManager.getMetadata(room2)).toEqual(initialMeta2);

    expect(await server.roomManager.getMetadata("non-existent-room")).toBeNull();

    const allMeta = await server.roomManager.getAllMetadata();
    expect(allMeta).toEqual({
      [room1]: { ...initialMeta1, ...updateMeta1 },
      [room2]: initialMeta2,
    });

    // clearRoom preserves metadata
    await server.roomManager.clearRoom(room1);
    expect(await server.roomManager.getMetadata(room1)).toEqual({ ...initialMeta1, ...updateMeta1 });

    // deleteRoom removes metadata
    await server.roomManager.deleteRoom(room1);
    expect(await server.roomManager.getMetadata(room1)).toBeNull();
  });

  test("room metadata filtering", async () => {
    const room1 = "filter-room-1";
    const room2 = "filter-room-2";
    const room3 = "filter-room-3";

    await server.roomManager.setMetadata(room1, { type: "public", maxUsers: 10 });
    await server.roomManager.setMetadata(room2, { type: "private", maxUsers: 5 });
    await server.roomManager.setMetadata(room3, { type: "public", maxUsers: 20 });

    // filter by type
    const publicRooms = await server.roomManager.getAllMetadata((roomName, metadata) => metadata.type === "public");

    expect(Object.keys(publicRooms).length).toBe(2);
    expect(publicRooms).toHaveProperty(room1);
    expect(publicRooms).toHaveProperty(room3);
    expect(publicRooms).not.toHaveProperty(room2);

    // filter by maxUsers
    const largeRooms = await server.roomManager.getAllMetadata((roomName, metadata) => metadata.maxUsers > 10);

    expect(Object.keys(largeRooms).length).toBe(1);
    expect(largeRooms).toHaveProperty(room3);
    expect(largeRooms).not.toHaveProperty(room1);
    expect(largeRooms).not.toHaveProperty(room2);
  });

  test("getAllRooms", async () => {
    await clientA.connect();
    await clientB.connect();

    await clientA.joinRoom("room1");
    await clientB.joinRoom("room1");
    await clientA.joinRoom("room2");

    const rooms = await server.getAllRooms();
    expect(rooms).toEqual(expect.arrayContaining(["room1", "room2"]));

    await clientA.leaveRoom("room1");
    const updatedRooms = await server.getAllRooms();
    expect(updatedRooms).toEqual(expect.arrayContaining(["room1", "room2"]));

    await clientB.leaveRoom("room1");
    const finalRooms = await server.getAllRooms();
    expect(finalRooms.length).toBe(1);
    expect(finalRooms).toEqual(expect.arrayContaining(["room2"]));
  });
});
