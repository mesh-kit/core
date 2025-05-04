import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
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
    pingInterval: 1000,
    latencyInterval: 500,
    enablePresenceExpirationEvents: true,
  });

const flushRedis = async () => {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.flushdb();
  await redis.quit();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Presence State", () => {
  const port = 8150;
  let server: MeshServer;
  let client1: MeshClient;
  let client2: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    server.trackPresence(/^test:room:.*/);
    await server.ready();

    client1 = new MeshClient(`ws://localhost:${port}`);
    client2 = new MeshClient(`ws://localhost:${port}`);

    await client1.connect();
    await client2.connect();
  });

  afterEach(async () => {
    await client1.close();
    await client2.close();
    await server.close();
  });

  test("client can publish and receive presence states", async () => {
    const roomName = "test:room:states";

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    const { success, present, states } = await client1.subscribePresence(roomName, callback);
    expect(success).toBe(true);
    expect(states).toEqual({});

    await client2.joinRoom(roomName);
    await wait(100);

    const state = { status: "typing" };
    const publishSuccess = await client2.publishPresenceState(roomName, {
      state,
    });
    expect(publishSuccess).toBe(true);
    await wait(100);

    // check that client1 got the state update
    expect(callback).toHaveBeenCalledTimes(2); // join + state
    expect(updates[1].type).toBe("state");
    expect(typeof updates[1].connectionId).toBe("string");
    expect(updates[1].state).toEqual(state);

    const clearSuccess = await client2.clearPresenceState(roomName);
    expect(clearSuccess).toBe(true);
    await wait(100);

    // check that client1 got the state clear
    expect(callback).toHaveBeenCalledTimes(3);
    expect(updates[2].type).toBe("state");
    expect(updates[2].roomName).toBeDefined();
    expect(updates[2].timestamp).toBeDefined();
    expect(updates[2].state).toBeNull();
  });

  test("presence state expires after TTL", async () => {
    const roomName = "test:room:state-ttl";
    const shortTTL = 200; // 200ms

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    await client1.subscribePresence(roomName, callback);
    await client2.joinRoom(roomName);
    await wait(100);

    // publish with short ttl
    const state = { status: "typing" };
    await client2.publishPresenceState(roomName, {
      state,
      expireAfter: shortTTL,
    });
    await wait(100);

    // check that client1 got the update
    expect(callback).toHaveBeenCalledTimes(2); // join + state
    expect(updates[1].type).toBe("state");
    expect(updates[1].state).toEqual(state);

    // wait for ttl to expire
    await wait(shortTTL + 100);

    // check that client1 got the expiration
    // we expect 4 callbacks: join + state + two state=null updates
    // this happens because both the presence key and presence state key expire,
    // triggering separate events
    expect(callback).toHaveBeenCalledTimes(4);
    expect(updates[2].type).toBe("state");
    expect(updates[2].state).toBeNull();
    expect(updates[3].type).toBe("state");
    expect(updates[3].state).toBeNull();
  });

  test("initial presence subscription includes current states", async () => {
    const roomName = "test:room:initial-states";

    await client1.joinRoom(roomName);
    const state1 = { status: "online", activity: "coding" };
    await client1.publishPresenceState(roomName, { state: state1 });

    await client2.joinRoom(roomName);
    const state2 = { status: "away" };
    await client2.publishPresenceState(roomName, { state: state2 });

    await wait(100);

    const client3 = new MeshClient(`ws://localhost:${port}`);
    await client3.connect();

    const callback = vi.fn();
    const { success, present, states } = await client3.subscribePresence(roomName, callback);

    expect(success).toBe(true);
    expect(present.length).toBe(2);
    expect(Object.keys(states || {}).length).toBe(2);

    // make sure states include both clients
    const connections = server.connectionManager.getLocalConnections();
    const client1Id = connections[0]?.id!;
    const client2Id = connections[1]?.id!;

    expect(states?.[client1Id]).toEqual(state1);
    expect(states?.[client2Id]).toEqual(state2);

    await client3.close();
  });

  test("presence state is cleared when client leaves room", async () => {
    const roomName = "test:room:leave-clear";

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    await client1.subscribePresence(roomName, callback);
    await client2.joinRoom(roomName);
    await wait(100);

    // publish state
    const state = { status: "typing" };
    await client2.publishPresenceState(roomName, { state });
    await wait(100);

    await client2.leaveRoom(roomName);
    await wait(100);

    // check that client1 got the leave event
    expect(callback).toHaveBeenCalledTimes(3); // join + state + leave
    expect(updates[2].type).toBe("leave");

    // client2 rejoins but should have no state
    await client2.joinRoom(roomName);
    await wait(100);

    const { states } = await client1.subscribePresence(roomName, () => {});
    const connections = server.connectionManager.getLocalConnections();
    const client2Id = connections.find((c) => c.id !== connections[0]?.id)?.id!;
    expect(states?.[client2Id]).toBeUndefined();
  });

  test("presence state is cleared when client disconnects", async () => {
    const roomName = "test:room:disconnect-clear";

    const connections = server.connectionManager.getLocalConnections();
    const connection2 = connections[1]!;

    await server.addToRoom(roomName, connection2);

    const state = { status: "typing" };
    await client2.publishPresenceState(roomName, { state });
    await wait(100);

    // make sure state exists
    let statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    expect(statesMap.has(connection2.id)).toBe(true);
    expect(statesMap.get(connection2.id)).toEqual(state);

    await client2.close();
    await wait(200);

    // make sure state is gone
    statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    expect(statesMap.has(connection2.id)).toBe(false);
  }, 10000);

  test("double state overwrite (same connection)", async () => {
    const roomName = "test:room:overwrite";

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    // subscribe to presence
    await client1.subscribePresence(roomName, callback);
    await client2.joinRoom(roomName);
    await wait(100);

    const state1 = { status: "typing" };
    await client2.publishPresenceState(roomName, { state: state1 });
    await wait(100);

    // publish another state right away
    const state2 = { status: "idle" };
    await client2.publishPresenceState(roomName, { state: state2 });
    await wait(100);

    // check that client1 got both updates
    expect(callback).toHaveBeenCalledTimes(3); // join + state1 + state2
    expect(updates[1].type).toBe("state");
    expect(updates[1].state).toEqual(state1);
    expect(updates[2].type).toBe("state");
    expect(updates[2].state).toEqual(state2);

    // make sure only the latest state is kept
    const statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    const connections = server.connectionManager.getLocalConnections();
    const connection2 = connections[1]!;
    expect(statesMap.get(connection2.id)).toEqual(state2);
  });

  test("no state if state key is omitted", async () => {
    const roomName = "test:room:no-state";
    await client1.joinRoom(roomName);

    // @ts-ignore - intentionally passing invalid params to test behavior
    const result = await client1.publishPresenceState(roomName, {});
    expect(result).toBe(false);

    // make sure no state was stored
    const statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    const connections = server.connectionManager.getLocalConnections();
    const connection1 = connections[0]!;
    expect(statesMap.has(connection1.id)).toBe(false);
  });

  test("error on publishing state to non-tracked room", async () => {
    const roomName = "untracked:room";
    await client1.joinRoom(roomName);

    const state = { status: "typing" };
    const result = await client1.publishPresenceState(roomName, { state });

    // should fail - room isn't tracked
    expect(result).toBe(false);
  });

  test("multiple TTL states expire independently", async () => {
    const roomName = "test:room:multiple-ttl";

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    await client1.subscribePresence(roomName, callback);
    await client1.joinRoom(roomName);
    await client2.joinRoom(roomName);
    await wait(100);

    const shortTTL = 200; // 200ms
    const state1 = { status: "typing" };
    await client2.publishPresenceState(roomName, {
      state: state1,
      expireAfter: shortTTL,
    });

    const longTTL = 500; // 500ms
    const state2 = { status: "away" };
    await client1.publishPresenceState(roomName, {
      state: state2,
      expireAfter: longTTL,
    });

    await wait(100);

    // check both states are stored
    let statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    const connections = server.connectionManager.getLocalConnections();
    const connection1 = connections[0]!;
    const connection2 = connections[1]!;
    expect(statesMap.get(connection1.id)).toEqual(state2);
    expect(statesMap.get(connection2.id)).toEqual(state1);

    await wait(shortTTL + 50);

    // check only the short ttl state expired
    statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    expect(statesMap.has(connection2.id)).toBe(false);
    expect(statesMap.get(connection1.id)).toEqual(state2);

    await wait(longTTL - shortTTL);

    // check both states are now expired
    statesMap = await server.presenceManager.getAllPresenceStates(roomName);
    expect(statesMap.has(connection1.id)).toBe(false);
    expect(statesMap.has(connection2.id)).toBe(false);
  }, 10000);

  test("room-scoped state isolation", async () => {
    const room1 = "test:room:isolation-1";
    const room2 = "test:room:isolation-2";

    await client1.joinRoom(room1);
    await client1.joinRoom(room2);
    await wait(100);

    const state1 = { status: "typing", room: "room1" };
    const state2 = { status: "away", room: "room2" };

    await client1.publishPresenceState(room1, { state: state1 });
    await client1.publishPresenceState(room2, { state: state2 });
    await wait(100);

    // check states are tracked separately per room
    const statesMap1 = await server.presenceManager.getAllPresenceStates(room1);
    const statesMap2 = await server.presenceManager.getAllPresenceStates(room2);

    const connections = server.connectionManager.getLocalConnections();
    const connection1 = connections[0]!;

    // each room should have the right state
    expect(statesMap1.get(connection1.id)).toEqual(state1);
    expect(statesMap2.get(connection1.id)).toEqual(state2);

    // updating state in one room shouldn't affect the other
    const updatedState1 = { status: "idle", room: "room1-updated" };
    await client1.publishPresenceState(room1, { state: updatedState1 });
    await wait(100);

    const updatedStatesMap1 = await server.presenceManager.getAllPresenceStates(room1);
    const updatedStatesMap2 = await server.presenceManager.getAllPresenceStates(room2);

    expect(updatedStatesMap1.get(connection1.id)).toEqual(updatedState1);
    expect(updatedStatesMap2.get(connection1.id)).toEqual(state2); // Still has original state
  });
});
