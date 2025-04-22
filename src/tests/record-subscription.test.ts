import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
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
  });

const flushRedis = async () => {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.flushdb();
  await redis.quit();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Record Subscription", () => {
  const port = 8130;
  let server: MeshServer;
  let client1: MeshClient;
  let client2: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    server.exposeRecord(/^test:record:.*/);
    server.exposeRecord("guarded:record");
    server.exposeWritableRecord(/^writable:record:.*/);
    server.exposeWritableRecord("guarded:writable");
    await server.ready();

    client1 = new MeshClient(`ws://localhost:${port}`);
    client2 = new MeshClient(`ws://localhost:${port}`);
  });

  afterEach(async () => {
    await client1.close();
    await client2.close();
    await server.close();
  });

  test("client can subscribe to an exposed record and get initial state", async () => {
    const recordId = "test:record:1";
    const initialData = { count: 0, name: "initial" };
    await server.publishRecordUpdate(recordId, initialData);

    await client1.connect();

    const callback = vi.fn();
    const { success, record, version } = await client1.subscribeRecord(
      recordId,
      callback
    );

    expect(success).toBe(true);
    expect(version).toBe(1);
    expect(record).toEqual(initialData);

    // callback is called once initially with the full record
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      recordId,
      full: initialData,
      version: 1,
    });
  });

  test("client cannot subscribe to an unexposed record", async () => {
    await client1.connect();
    const callback = vi.fn();
    const { success, record, version } = await client1.subscribeRecord(
      "unexposed:record",
      callback
    );

    expect(success).toBe(false);
    expect(version).toBe(0);
    expect(record).toBeNull();
    expect(callback).not.toHaveBeenCalled();
  });

  test("record guard prevents unauthorized subscriptions", async () => {
    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();
    const connection1Id = connections[0]?.id;

    server.exposeRecord(
      "guarded:record",
      (connection, recId) => connection.id === connection1Id
    );

    const callback1 = vi.fn();
    const result1 = await client1.subscribeRecord("guarded:record", callback1);

    const callback2 = vi.fn();
    const result2 = await client2.subscribeRecord("guarded:record", callback2);

    expect(result1.success).toBe(true);
    expect(result1.version).toBe(0); // nothing published yet
    expect(result1.record).toBeNull();
    expect(callback1).toHaveBeenCalledTimes(1); // initial call with null
    expect(callback1).toHaveBeenCalledWith({
      recordId: "guarded:record",
      full: null,
      version: 0,
    });

    expect(result2.success).toBe(false);
    expect(result2.version).toBe(0);
    expect(result2.record).toBeNull();
    expect(callback2).not.toHaveBeenCalled();
  });

  test("client receives full updates by default", async () => {
    const recordId = "test:record:full";
    await client1.connect();

    const updates: any[] = [];
    const callback = (update: any) => {
      updates.push(update);
    };

    await client1.subscribeRecord(recordId, callback);

    const data1 = { count: 1 };
    await server.publishRecordUpdate(recordId, data1);
    await wait(50); // because pub/sub takes a bit

    const data2 = { count: 2, name: "hello" };
    await server.publishRecordUpdate(recordId, data2);
    await wait(50);

    expect(updates.length).toBe(3); // initial + 2 updates
    expect(updates[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates[1]).toEqual({ recordId, full: data1, version: 1 });
    expect(updates[2]).toEqual({ recordId, full: data2, version: 2 });
  });

  test("client receives patch updates when mode is 'patch'", async () => {
    const recordId = "test:record:patch";
    await client1.connect();

    const updates: any[] = [];
    const callback = (update: any) => {
      updates.push(update);
    };

    await client1.subscribeRecord(recordId, callback, { mode: "patch" });

    const data1 = { count: 1 };
    await server.publishRecordUpdate(recordId, data1);
    await wait(50);

    const data2 = { count: 1, name: "added" };
    await server.publishRecordUpdate(recordId, data2);
    await wait(50);

    const data3 = { name: "added" };
    await server.publishRecordUpdate(recordId, data3);
    await wait(50);

    expect(updates.length).toBe(4);
    expect(updates[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates[1]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/count", value: 1 }],
      version: 1,
    });
    expect(updates[2]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/name", value: "added" }],
      version: 2,
    });
    expect(updates[3]).toEqual({
      recordId,
      patch: [{ op: "remove", path: "/count" }],
      version: 3,
    });
  });

  test("multiple clients receive updates based on their mode", async () => {
    const recordId = "test:record:multi";
    await client1.connect();
    await client2.connect();

    const updates1: any[] = [];
    const callback1 = (update: any) => {
      updates1.push(update);
    };
    await client1.subscribeRecord(recordId, callback1);

    const updates2: any[] = [];
    const callback2 = (update: any) => {
      updates2.push(update);
    };
    await client2.subscribeRecord(recordId, callback2, { mode: "patch" });

    const data1 = { value: "a" };
    await server.publishRecordUpdate(recordId, data1);
    await wait(100);

    const data2 = { value: "b" };
    await server.publishRecordUpdate(recordId, data2);
    await wait(100);

    // client 1 wants full updates
    expect(updates1.length).toBe(3);
    expect(updates1[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates1[1]).toEqual({ recordId, full: data1, version: 1 });
    expect(updates1[2]).toEqual({ recordId, full: data2, version: 2 });

    // client 2 wants patches
    expect(updates2.length).toBe(3);
    expect(updates2[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates2[1]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/value", value: "a" }],
      version: 1,
    });
    expect(updates2[2]).toEqual({
      recordId,
      patch: [{ op: "replace", path: "/value", value: "b" }],
      version: 2,
    });
  });

  test("client stops receiving updates after unsubscribing", async () => {
    const recordId = "test:record:unsub";
    await client1.connect();

    const updates: any[] = [];
    const callback = (update: any) => {
      updates.push(update);
    };

    await client1.subscribeRecord(recordId, callback);

    await server.publishRecordUpdate(recordId, { count: 1 });
    await wait(50);

    const unsubSuccess = await client1.unsubscribeRecord(recordId);
    expect(unsubSuccess).toBe(true);

    await server.publishRecordUpdate(recordId, { count: 2 });
    await wait(50);

    expect(updates.length).toBe(2);
    expect(updates[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates[1]).toEqual({ recordId, full: { count: 1 }, version: 1 });
  });

  test("desync detection triggers resubscribe (patch mode)", async () => {
    const recordId = "test:record:desync";
    await client1.connect();

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    // spy on resub attempt
    const commandSpy = vi.spyOn(client1.connection, "command");

    await client1.subscribeRecord(recordId, callback, { mode: "patch" }); // v0, initial full

    // v1
    await server.publishRecordUpdate(recordId, { count: 1 });
    await wait(50); // client receives v1 patch

    // publish v2 and v3 without notifying client via pub/sub
    const v2Result = await server.recordManager.publishUpdate(recordId, {
      count: 2,
    });
    const v3Result = await server.recordManager.publishUpdate(recordId, {
      count: 3,
    });
    expect(v2Result?.version).toBe(2);
    expect(v3Result?.version).toBe(3);

    // publish v4 via the proper mechanism, while client expects v2
    const data4 = { count: 4 };
    await server.publishRecordUpdate(recordId, data4); // v4
    await wait(100); // allocate time for desync handling

    expect(callback).toHaveBeenCalledTimes(3); // v0, v1, v4
    expect(updates[0]).toEqual({ recordId, full: null, version: 0 });
    expect(updates[1]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/count", value: 1 }],
      version: 1,
    });
    // third call is the full record after resync
    expect(updates[2]).toEqual({ recordId, full: data4, version: 4 });

    // verify unsubscribe and subscribe were called for resync
    expect(commandSpy).toHaveBeenCalledWith(
      "mesh/unsubscribe-record",
      { recordId },
      30000
    );
    expect(commandSpy).toHaveBeenCalledWith(
      "mesh/subscribe-record",
      {
        recordId,
        mode: "patch",
      },
      30000
    );
  });

  test("client can write to an exposed writable record", async () => {
    const recordId = "writable:record:1";
    await client1.connect();
    await client2.connect();

    const updatesClient2: any[] = [];
    const callbackClient2 = vi.fn((update: any) => {
      updatesClient2.push(update);
    });

    // check subscription success and initial call
    const subResult = await client2.subscribeRecord(recordId, callbackClient2); // Subscribe before write
    expect(subResult.success).toBe(true);
    expect(subResult.record).toBeNull();
    expect(subResult.version).toBe(0);
    expect(callbackClient2).toHaveBeenCalledTimes(1);
    expect(callbackClient2).toHaveBeenCalledWith({
      recordId,
      full: null,
      version: 0,
    });

    const initialData = { value: "initial" };
    // client 1 writes
    const success = await client1.publishRecordUpdate(recordId, initialData);
    expect(success).toBe(true);

    await wait(150);

    // client 2 received the update (initial call + 1 update)
    expect(callbackClient2).toHaveBeenCalledTimes(2);
    expect(updatesClient2.length).toBe(2);

    expect(updatesClient2[1]).toEqual({
      recordId,
      full: initialData,
      version: 1,
    });

    // verify server state
    const { record, version } = await server.recordManager.getRecordAndVersion(
      recordId
    );
    expect(record).toEqual(initialData);
    expect(version).toBe(1);
  });

  test("client cannot write to a non-writable record (read-only exposed)", async () => {
    const recordId = "test:record:readonly"; // exposed via exposeRecord, not exposeWritableRecord
    await client1.connect();

    const initialData = { value: "attempt" };
    const success = await client1.publishRecordUpdate(recordId, initialData);
    expect(success).toBe(false);

    // verify server state hasn't changed
    const { record, version } = await server.recordManager.getRecordAndVersion(
      recordId
    );
    expect(record).toBeNull();
    expect(version).toBe(0);
  });

  test("client cannot write to a record not exposed at all", async () => {
    const recordId = "not:exposed:at:all";
    await client1.connect();

    const initialData = { value: "attempt" };
    const success = await client1.publishRecordUpdate(recordId, initialData);
    expect(success).toBe(false);

    const { record, version } = await server.recordManager.getRecordAndVersion(
      recordId
    );
    expect(record).toBeNull();
    expect(version).toBe(0);
  });

  test("writable record guard prevents unauthorized writes", async () => {
    const recordId = "guarded:writable";
    await client1.connect();
    await client2.connect();

    const connections = server.connectionManager.getLocalConnections();
    const connection1Id = connections[0]?.id;

    // only client1 can write this record
    server.exposeWritableRecord(
      recordId,
      (connection, recId) => connection.id === connection1Id
    );

    const data1 = { value: "from client 1" };
    const success1 = await client1.publishRecordUpdate(recordId, data1);
    expect(success1).toBe(true);

    await wait(50);
    let serverState = await server.recordManager.getRecordAndVersion(recordId);
    expect(serverState.record).toEqual(data1);
    expect(serverState.version).toBe(1);

    const data2 = { value: "from client 2" };
    const success2 = await client2.publishRecordUpdate(recordId, data2);
    expect(success2).toBe(false);

    await wait(50);
    serverState = await server.recordManager.getRecordAndVersion(recordId);
    expect(serverState.record).toEqual(data1); // unchanged
    expect(serverState.version).toBe(1); // unchanged
  });

  test("update from client write propagates to other subscribed clients", async () => {
    const recordId = "writable:record:propagate";
    await client1.connect(); // writer
    await client2.connect(); // subscriber

    const updatesClient2: any[] = [];
    const callbackClient2 = vi.fn((update: any) => {
      updatesClient2.push(update);
    });

    const subResult = await client2.subscribeRecord(recordId, callbackClient2, {
      mode: "patch",
    });
    expect(subResult.success).toBe(true);
    expect(subResult.record).toBeNull();
    expect(subResult.version).toBe(0);
    expect(callbackClient2).toHaveBeenCalledTimes(1);
    expect(callbackClient2).toHaveBeenCalledWith({
      recordId,
      full: null,
      version: 0,
    });

    // client 1 writes
    const data1 = { count: 1 };
    await client1.publishRecordUpdate(recordId, data1);
    await wait(100);

    const data2 = { count: 1, name: "added" };
    await client1.publishRecordUpdate(recordId, data2);
    await wait(150);

    // client 2 received the patches (initial call + 2 patches)
    expect(callbackClient2).toHaveBeenCalledTimes(3);
    expect(updatesClient2.length).toBe(3);
    expect(updatesClient2[1]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/count", value: 1 }],
      version: 1,
    });
    expect(updatesClient2[2]).toEqual({
      recordId,
      patch: [{ op: "add", path: "/name", value: "added" }],
      version: 2,
    });
  });

  test("client can subscribe to primitive values in full mode", async () => {
    const recordId = "test:record:primitive";
    const initialValue = "initial value";
    const updatedValue = "updated value";

    await client1.connect();

    await server.publishRecordUpdate(recordId, initialValue);
    await wait(50);

    const updates: any[] = [];
    const callback = vi.fn((update: any) => {
      updates.push(update);
    });

    const { success, record, version } = await client1.subscribeRecord(
      recordId,
      callback
    );

    expect(success).toBe(true);
    expect(version).toBe(1);
    expect(record).toEqual(initialValue);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      recordId,
      full: initialValue,
      version: 1,
    });

    await server.publishRecordUpdate(recordId, updatedValue);
    await wait(100);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(updates.length).toBe(2);
    expect(updates[1]).toEqual({
      recordId,
      full: updatedValue,
      version: 2,
    });

    const serverState = await server.recordManager.getRecordAndVersion(
      recordId
    );
    expect(serverState.record).toEqual(updatedValue);
    expect(serverState.version).toBe(2);
  });
});

describe("Record Subscription (Multiple Instances)", () => {
  let serverA: MeshServer;
  let serverB: MeshServer;
  let clientA: MeshClient;
  let clientB: MeshClient;

  const portA = 8131;
  const portB = 8132;
  const recordId = "test:record:multi-instance";
  const writableRecordId = "writable:record:multi-instance";

  beforeEach(async () => {
    await flushRedis();

    serverA = createTestServer(portA);
    serverB = createTestServer(portB);

    [serverA, serverB].forEach((server) => {
      server.exposeRecord(/^test:record:.*/);
      server.exposeWritableRecord(/^writable:record:.*/);
    });

    await serverA.ready();
    await serverB.ready();

    clientA = new MeshClient(`ws://localhost:${portA}`);
    clientB = new MeshClient(`ws://localhost:${portB}`);
  });

  afterEach(async () => {
    await clientA.close();
    await clientB.close();
    await serverA.close();
    await serverB.close();
  });

  test("server-published update propagates across instances (full mode)", async () => {
    await clientA.connect();
    await clientB.connect();

    const callbackA = vi.fn();
    const callbackB = vi.fn();

    await clientA.subscribeRecord(recordId, callbackA);
    await clientB.subscribeRecord(recordId, callbackB);

    await wait(50);
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith({
      recordId,
      full: null,
      version: 0,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId,
      full: null,
      version: 0,
    });

    const data1 = { value: "update1" };
    // server A publishes, should reach both clients
    await serverA.publishRecordUpdate(recordId, data1);

    await wait(150);

    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackB).toHaveBeenCalledTimes(2);
    expect(callbackA).toHaveBeenCalledWith({
      recordId,
      full: data1,
      version: 1,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId,
      full: data1,
      version: 1,
    });
  }, 10000);

  test("client-published update propagates across instances (full mode)", async () => {
    await clientA.connect();
    await clientB.connect();

    const callbackA = vi.fn();
    const callbackB = vi.fn();

    await clientA.subscribeRecord(writableRecordId, callbackA);
    await clientB.subscribeRecord(writableRecordId, callbackB);

    await wait(50);
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);

    const data1 = { message: "hello from client A" };
    // client A writes, should propagate to client B via server B
    const writeSuccess = await clientA.publishRecordUpdate(
      writableRecordId,
      data1
    );
    expect(writeSuccess).toBe(true);

    await wait(150);

    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackB).toHaveBeenCalledTimes(2);
    expect(callbackA).toHaveBeenCalledWith({
      recordId: writableRecordId,
      full: data1,
      version: 1,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId: writableRecordId,
      full: data1,
      version: 1,
    });
  }, 10000);

  test("client-published update propagates across instances (patch mode)", async () => {
    await clientA.connect();
    await clientB.connect();

    const callbackA = vi.fn();
    const callbackB = vi.fn();

    await clientA.subscribeRecord(writableRecordId, callbackA, {
      mode: "patch",
    });
    await clientB.subscribeRecord(writableRecordId, callbackB, {
      mode: "patch",
    });

    await wait(50);
    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith({
      recordId: writableRecordId,
      full: null,
      version: 0,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId: writableRecordId,
      full: null,
      version: 0,
    });

    const data1 = { count: 1 };
    // client A writes first update
    let writeSuccess = await clientA.publishRecordUpdate(
      writableRecordId,
      data1
    );
    expect(writeSuccess).toBe(true);

    await wait(150);
    expect(callbackA).toHaveBeenCalledTimes(2);
    expect(callbackB).toHaveBeenCalledTimes(2);

    const patch1 = [{ op: "add", path: "/count", value: 1 }];
    expect(callbackA).toHaveBeenCalledWith({
      recordId: writableRecordId,
      patch: patch1,
      version: 1,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId: writableRecordId,
      patch: patch1,
      version: 1,
    });

    const data2 = { count: 1, name: "added" };
    // client A writes second update
    writeSuccess = await clientA.publishRecordUpdate(writableRecordId, data2);
    expect(writeSuccess).toBe(true);

    await wait(150);
    expect(callbackA).toHaveBeenCalledTimes(3);
    expect(callbackB).toHaveBeenCalledTimes(3);

    const patch2 = [{ op: "add", path: "/name", value: "added" }];
    expect(callbackA).toHaveBeenCalledWith({
      recordId: writableRecordId,
      patch: patch2,
      version: 2,
    });
    expect(callbackB).toHaveBeenCalledWith({
      recordId: writableRecordId,
      patch: patch2,
      version: 2,
    });
  }, 10000);
});
