import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("Presence Subscription", () => {
  const port = 8140;
  let server: MeshServer;
  let client1: MeshClient;
  let client2: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    server.trackPresence(/^test:room:.*/);
    server.trackPresence("guarded:room");
    await server.ready();

    client1 = new MeshClient(`ws://localhost:${port}`);
    client2 = new MeshClient(`ws://localhost:${port}`);
  });

  afterEach(async () => {
    await client1.close();
    await client2.close();
    await server.close();
  });

  test("client can subscribe to presence for a tracked room", async () => {
    const roomName = "test:room:1";
    await client1.connect();

    const callback = vi.fn();
    const { success, present } = await client1.subscribePresence(
      roomName,
      callback
    );

    expect(success).toBe(true);
    expect(Array.isArray(present)).toBe(true);
    expect(present.length).toBe(0);
  });

  test("client cannot subscribe to presence for an untracked room", async () => {
    const roomName = "untracked:room";
    await client1.connect();

    const callback = vi.fn();
    const { success, present } = await client1.subscribePresence(
      roomName,
      callback
    );

    expect(success).toBe(false);
    expect(present.length).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });

  test("presence guard prevents unauthorized subscriptions", async () => {
    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();
    const connection1Id = connections[0]?.id;

    server.trackPresence(
      "guarded:room",
      (connection, roomName) => connection.id === connection1Id
    );

    const callback1 = vi.fn();
    const result1 = await client1.subscribePresence("guarded:room", callback1);

    const callback2 = vi.fn();
    const result2 = await client2.subscribePresence("guarded:room", callback2);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(false);
    expect(callback2).not.toHaveBeenCalled();
  });

  test("client receives presence updates when users join and leave", async () => {
    const roomName = "test:room:updates";
    await client1.connect();
    await client2.connect();

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    await client1.subscribePresence(roomName, callback);

    const connections = server.connectionManager.getLocalConnections();

    await server.addToRoom(roomName, connections[1]!);
    await wait(100);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(updates[0].type).toBe("join");
    expect(updates[0].roomName).toBe(roomName);
    expect(typeof updates[0].connectionId).toBe("string");
    expect(typeof updates[0].timestamp).toBe("number");

    await server.removeFromRoom(roomName, connections[1]!);
    await wait(100);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(updates[1].type).toBe("leave");
    expect(updates[1].roomName).toBe(roomName);
    expect(typeof updates[1].connectionId).toBe("string");
    expect(typeof updates[1].timestamp).toBe("number");
  });

  test("client stops receiving presence updates after unsubscribing", async () => {
    const roomName = "test:room:unsub";
    await client1.connect();
    await client2.connect();

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    await client1.subscribePresence(roomName, callback);

    const connections = server.connectionManager.getLocalConnections();

    await server.addToRoom(roomName, connections[1]!);
    await wait(100);

    expect(callback).toHaveBeenCalledTimes(1);

    const unsubSuccess = await client1.unsubscribePresence(roomName);
    expect(unsubSuccess).toBe(true);

    callback.mockReset();

    await server.removeFromRoom(roomName, connections[1]!);
    await wait(100);

    expect(callback).not.toHaveBeenCalled();
  });

  test("presence is maintained with custom TTL", async () => {
    const roomName = "test:room:ttl";
    const shortTTL = 200;

    server.trackPresence(roomName, { ttl: shortTTL });

    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();
    const connection2 = connections[1]!;

    await server.addToRoom(roomName, connection2);

    let present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connection2.id);

    // wait for less than TTL and verify still present
    await wait(shortTTL / 2);
    present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connection2.id);

    // simulate pong to refresh presence
    connection2.emit("pong", connection2.id);

    // wait for more than the original TTL
    await wait(shortTTL + 100);

    // should still be present because of the refresh
    present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connection2.id);
  });

  test("initial presence list is correct when subscribing", async () => {
    const roomName = "test:room:initial";
    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();

    await server.addToRoom(roomName, connections[0]!);
    await server.addToRoom(roomName, connections[1]!);
    await wait(100);

    const callback = vi.fn();
    const { success, present } = await client1.subscribePresence(
      roomName,
      callback
    );

    expect(success).toBe(true);
    expect(present.length).toBe(2);
    expect(present).toContain(connections[0]!.id);
    expect(present).toContain(connections[1]!.id);
  });

  test("presence is cleaned up when connection is closed", async () => {
    const roomName = "test:room:cleanup";
    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();
    const connection2 = connections[1]!;

    await server.addToRoom(roomName, connection2);

    let present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connection2.id);

    await client2.close();

    await wait(100);

    present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).not.toContain(connection2.id);
  });

  test("presence is automatically cleaned up when TTL expires", async () => {
    const roomName = "test:room:auto-cleanup";
    const shortTTL = 1000;

    const testServer = createTestServer(port + 100);
    await testServer.ready();

    testServer.trackPresence(roomName, { ttl: shortTTL });

    const testClient = new MeshClient(`ws://localhost:${port + 100}`);
    await testClient.connect();

    const connections = testServer.connectionManager.getLocalConnections();
    const connection = connections[0]!;

    await testServer.addToRoom(roomName, connection);

    let present = await testServer.presenceManager.getPresentConnections(
      roomName
    );
    expect(present).toContain(connection.id);

    // wait for more than the TTL to allow the key to expire and notification to be processed
    await wait(shortTTL * 3);

    // the connection should be automatically marked as offline when the key expires
    present = await testServer.presenceManager.getPresentConnections(roomName);
    expect(present).not.toContain(connection.id);

    await testClient.close();
    await testServer.close();
  }, 10000);
  
  test("client can manually refresh presence", async () => {
    const roomName = "test:room:refresh";
    const shortTTL = 500; // very short TTL for testing
    
    server.trackPresence(roomName, { ttl: shortTTL });
    
    await client1.connect();
    
    // join
    const joinResult = await client1.joinRoom(roomName);
    expect(joinResult.success).toBe(true);
    
    // get my id
    const connections = server.connectionManager.getLocalConnections();
    const connectionId = connections[0]?.id;
    expect(connectionId).toBeDefined();
    
    // verify presence
    let present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connectionId);
    
    // wait half the TTL
    await wait(shortTTL / 2);
    
    // refresh presence
    const refreshResult = await client1.refreshPresence(roomName);
    
    // verify refresh was successful
    expect(refreshResult).toBe(true);
    
    // wait for longer than the original TTL
    await wait(shortTTL + 100);
    
    // presence should still be active due to the refresh
    present = await server.presenceManager.getPresentConnections(roomName);
    expect(present).toContain(connectionId);
  }, 10000);
});

describe("Presence Subscription (Multiple Instances)", () => {
  let serverA: MeshServer;
  let serverB: MeshServer;
  let clientA: MeshClient;
  let clientB: MeshClient;
  let clientC: MeshClient;

  const portA = 8141;
  const portB = 8142;
  const roomName = "test:room:multi-instance";

  beforeEach(async () => {
    await flushRedis();

    serverA = createTestServer(portA);
    serverB = createTestServer(portB);

    // track presence on both servers
    [serverA, serverB].forEach((server) => {
      server.trackPresence(roomName);
    });

    await serverA.ready();
    await serverB.ready();

    // server a client:
    clientA = new MeshClient(`ws://localhost:${portA}`);

    // server b clients:
    clientB = new MeshClient(`ws://localhost:${portB}`);
    clientC = new MeshClient(`ws://localhost:${portB}`);
  });

  afterEach(async () => {
    await clientA.close();
    await clientB.close();
    await clientC.close();
    await serverA.close();
    await serverB.close();
  });

  test("join event propagates across instances", async () => {
    await clientA.connect(); // srv a
    await clientB.connect(); // srv b

    const connectionsB_Server = serverB.connectionManager.getLocalConnections();
    const clientBId = connectionsB_Server[0]?.id;
    expect(clientBId).toBeDefined();

    const callbackA = vi.fn();
    const { present: initialPresentA } = await clientA.subscribePresence(
      roomName,
      callbackA
    );
    expect(initialPresentA).toEqual([]); // empty room

    const joinResultB = await clientB.joinRoom(roomName);
    expect(joinResultB.success).toBe(true);

    await wait(150);

    // client a (srv a) receives join event from client b (srv b)
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "join",
        roomName: roomName,
        connectionId: clientBId,
      })
    );
  }, 10000);

  test("leave event propagates across instances", async () => {
    await clientA.connect();
    await clientB.connect();

    const connectionsB_Server = serverB.connectionManager.getLocalConnections();
    const clientBId = connectionsB_Server[0]?.id;
    expect(clientBId).toBeDefined();

    const callbackA = vi.fn();
    const { present: initialPresentA } = await clientA.subscribePresence(
      roomName,
      callbackA
    );
    expect(initialPresentA).toEqual([]);

    await clientB.joinRoom(roomName);
    await wait(150);

    // client a receives join event from client b
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith(
      expect.objectContaining({ type: "join", connectionId: clientBId })
    );

    // client B leaves the room via srv b
    const leaveResultB = await clientB.leaveRoom(roomName);
    expect(leaveResultB.success).toBe(true);

    await wait(150);

    // client a (srv a) receives leave event from client b (srv b)
    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackA).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "leave",
        roomName: roomName,
        connectionId: clientBId,
      })
    );
  }, 10000);

  test("disconnect event propagates as leave across instances", async () => {
    await clientA.connect();
    await clientB.connect();

    const connectionsB_Server = serverB.connectionManager.getLocalConnections();
    const clientBId = connectionsB_Server[0]?.id;
    expect(clientBId).toBeDefined();

    const callbackA = vi.fn();
    const { present: initialPresentA } = await clientA.subscribePresence(
      roomName,
      callbackA
    );
    expect(initialPresentA).toEqual([]);

    await clientB.joinRoom(roomName);
    await wait(150);

    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith(
      expect.objectContaining({ type: "join", connectionId: clientBId })
    );

    // client b disconnects from server b
    await clientB.close();

    await wait(150);

    // client a receives leave event from client b's disconnection
    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackA).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "leave",
        roomName: roomName,
        connectionId: clientBId,
      })
    );
  }, 10000);

  test("initial presence list includes users from other instances", async () => {
    await clientA.connect();
    await clientB.connect();
    await clientC.connect();

    const connectionsB_Server = serverB.connectionManager.getLocalConnections();
    const clientBId = connectionsB_Server[0]?.id;
    const clientCId = connectionsB_Server[1]?.id;
    expect(clientBId).toBeDefined();
    expect(clientCId).toBeDefined();

    // client b -> srv b
    await clientB.joinRoom(roomName);
    // client c -> srv b
    await clientC.joinRoom(roomName);

    await wait(150);

    // client a subscribes to presence from srv a
    const callbackA = vi.fn();
    const { success, present } = await clientA.subscribePresence(
      roomName,
      callbackA
    );

    expect(success).toBe(true);
    // initial list contains client b and c
    expect(present.length).toBe(2);
    expect(present).toContain(clientBId);
    expect(present).toContain(clientCId);

    expect(callbackA).toHaveBeenCalledTimes(1);
  }, 10000);
});
