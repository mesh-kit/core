import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
import "./websocket-polyfill";
import { MeshServer } from "../server";
import { MeshClient } from "../client";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;

const flushRedis = async () => {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.flushdb();
  await redis.quit();
};

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Collection Subscriptions", () => {
  const port = 9876;
  let server: MeshServer;
  let client: MeshClient;
  let redis: Redis;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    await server.ready();

    client = new MeshClient(`ws://localhost:${port}`);
    await client.connect();

    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await redis.quit();
  });

  test("should expose and subscribe to a collection", async () => {
    await server.publishRecordUpdate("task:1", { id: "task:1", title: "Task 1", completed: false });
    await server.publishRecordUpdate("task:2", { id: "task:2", title: "Task 2", completed: true });
    await server.publishRecordUpdate("task:3", { id: "task:3", title: "Task 3", completed: false });

    server.exposeRecord("task:*");
    server.exposeCollection("collection:all-tasks", async () => server.listRecordsMatching("task:*"));

    const diffs: Array<{ added: any[]; removed: any[]; changed: any[]; version: number }> = [];

    const result = await client.subscribeCollection("collection:all-tasks", {
      onDiff: (diff) => {
        diffs.push(diff);
      },
    });

    // initial subscription
    expect(result.success).toBe(true);
    expect(result.ids.length).toBe(3);
    expect(result.ids).toContain("task:1");
    expect(result.ids).toContain("task:2");
    expect(result.ids).toContain("task:3");
    expect(result.version).toBe(1);

    // add a new record to trigger a diff
    await server.publishRecordUpdate("task:4", { id: "task:4", title: "Task 4", completed: false });
    await wait(100);

    // verify diff received - we get initial + task:4 added + task:4 record created
    expect(diffs.length).toBe(3); // initial + added task:4 + changed task:4 (from record creation)
    expect(diffs[1]!.added).toEqual(expect.arrayContaining([expect.objectContaining({ id: "task:4", record: expect.any(Object) })]));
    expect(diffs[1]!.removed).toEqual([]);
    expect(diffs[1]!.changed).toEqual([]);
    expect(diffs[1]!.version).toBe(2);

    // update a record, triggering onDiff with changed
    await server.publishRecordUpdate("task:1", { id: "task:1", title: "Updated Task 1", completed: true });
    await wait(100);

    expect(diffs.length).toBe(4); // initial + added task:4 + changed task:4 + changed task:1
    expect(diffs[3]!.added).toEqual([]);
    expect(diffs[3]!.removed).toEqual([]);
    expect(diffs[3]!.changed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "task:1" })]));
    expect(diffs[3]!.version).toBeGreaterThanOrEqual(2);

    // remove a record to trigger another diff
    await server.deleteRecord("task:2");
    await wait(100);

    // verify diff was received
    expect(diffs.length).toBe(5); // initial + added task:4 + changed task:4 + changed task:1 + removed task:2
    // the second diff should (still) be the addition of task:4
    expect(diffs[1]!.added).toEqual(expect.arrayContaining([expect.objectContaining({ id: "task:4", record: expect.any(Object) })]));
    expect(diffs[1]!.removed).toEqual([]);
    expect(diffs[1]!.changed).toEqual([]);

    // the fifth diff should be the removal of task:2
    expect(diffs[4]!.added).toEqual([]);
    expect(diffs[4]!.removed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "task:2", record: expect.any(Object) })]));
    expect(diffs[4]!.changed).toEqual([]);

    const unsubResult = await client.unsubscribeCollection("collection:all-tasks");
    expect(unsubResult).toBe(true);
  });

  test("should return initial records in subscription result", async () => {
    const initialRecord1 = { id: "initial:task:1", title: "Initial Task 1", done: false };
    const initialRecord2 = { id: "initial:task:2", title: "Initial Task 2", done: true };

    await server.publishRecordUpdate(initialRecord1.id, initialRecord1);
    await server.publishRecordUpdate(initialRecord2.id, initialRecord2);

    server.exposeRecord("initial:task:*");
    server.exposeCollection("collection:initial-tasks", async () => server.listRecordsMatching("initial:task:*"));

    const mockOnDiff = vi.fn();

    const result = (await client.subscribeCollection("collection:initial-tasks", {
      onDiff: mockOnDiff,
    })) as { success: boolean; ids: string[]; records: Array<{ id: string; record: any }>; version: number }; // Updated records type

    expect(result.success).toBe(true);
    expect(result.version).toBe(1);
    expect(result.ids).toBeInstanceOf(Array);
    expect(result.ids.length).toBe(2);
    expect(result.ids).toEqual(expect.arrayContaining([initialRecord1.id, initialRecord2.id]));

    expect(result.records).toBeInstanceOf(Array);
    expect(result.records.length).toBe(2);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: initialRecord1.id,
          record: expect.objectContaining(initialRecord1),
        }),
        expect.objectContaining({
          id: initialRecord2.id,
          record: expect.objectContaining(initialRecord2),
        }),
      ]),
    );

    // onDiff was called once with the initial state
    expect(mockOnDiff).toHaveBeenCalledTimes(1);
    expect(mockOnDiff).toHaveBeenCalledWith({
      added: expect.arrayContaining([
        expect.objectContaining({ id: initialRecord1.id, record: expect.any(Object) }),
        expect.objectContaining({ id: initialRecord2.id, record: expect.any(Object) }),
      ]),
      removed: [],
      changed: [],
      version: 1,
    });

    // subsequent update calls onDiff with changed
    const updatedRecord1 = { ...initialRecord1, title: "Updated Task 1" };
    await server.publishRecordUpdate(initialRecord1.id, updatedRecord1);
    await wait(100);
    expect(mockOnDiff).toHaveBeenCalledTimes(2);
    expect(mockOnDiff).toHaveBeenLastCalledWith({
      added: [],
      removed: [],
      changed: expect.arrayContaining([expect.objectContaining({ id: initialRecord1.id, record: updatedRecord1 })]),
      version: expect.any(Number),
    });

    await client.unsubscribeCollection("collection:initial-tasks");
  });

  test("should clean up Redis collection key on disconnect", async () => {
    const collectionId = "collection:cleanup-test";
    const recordId = "cleanup:task:1";
    const recordData = { id: recordId, title: "Cleanup Test Task" };
    const { connectionId } = client;
    expect(connectionId).toBeDefined();
    const redisKeyPattern = `mesh:collection:${collectionId}:${connectionId}`;

    // expose record and collection
    await server.publishRecordUpdate(recordId, recordData);
    server.exposeRecord("cleanup:task:*");
    server.exposeCollection(collectionId, async () => server.listRecordsMatching("cleanup:task:*"));

    // subscribe to collection
    const subResult = await client.subscribeCollection(collectionId);
    expect(subResult.success).toBe(true);
    expect(subResult.ids).toContain(recordId);

    // verify redis key exists
    const keyExistsBefore = await redis.exists(redisKeyPattern);
    expect(keyExistsBefore).toBe(1);

    await client.close();
    await wait(200);

    // verify redis key is deleted
    const keyExistsAfter = await redis.exists(redisKeyPattern);
    expect(keyExistsAfter).toBe(0);
  });

  test("should support dynamic collections based on patterns", async () => {
    await server.publishRecordUpdate("user:1:task:1", { id: "user:1:task:1", title: "User 1 Task 1" });
    await server.publishRecordUpdate("user:1:task:2", { id: "user:1:task:2", title: "User 1 Task 2" });
    await server.publishRecordUpdate("user:2:task:1", { id: "user:2:task:1", title: "User 2 Task 1" });

    server.exposeRecord("user:*:task:*");

    server.exposeCollection(/^collection:user:\d+:tasks$/, async (connection, collectionId) => {
      const userId = collectionId.split(":")[2];
      return await server.listRecordsMatching(`user:${userId}:task:*`);
    });

    // subscribe to user 1's tasks
    const user1Result = await client.subscribeCollection("collection:user:1:tasks");
    expect(user1Result.success).toBe(true);
    expect(user1Result.ids.length).toBe(2);
    expect(user1Result.ids).toContain("user:1:task:1");
    expect(user1Result.ids).toContain("user:1:task:2");

    // subscribe to user 2's tasks
    const user2Result = await client.subscribeCollection("collection:user:2:tasks");
    expect(user2Result.success).toBe(true);
    expect(user2Result.ids.length).toBe(1);
    expect(user2Result.ids).toContain("user:2:task:1");

    await client.unsubscribeCollection("collection:user:1:tasks");
    await client.unsubscribeCollection("collection:user:2:tasks");
  });

  test("should support paginated collections using collection names", async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({
      id: `item:${i + 1}`,
      value: i + 1,
      created_at: new Date(Date.now() + i * 1000).toISOString(), // each record 1 second apart
    }));

    // publish all records
    for (const record of records) {
      await server.publishRecordUpdate(record.id, record);
    }

    server.exposeCollection(/^items:page:\d+$/, async (conn, collectionId) => {
      const pageNum = parseInt(String(collectionId.split(":")[2]));
      const pageSize = 10;

      return await server.listRecordsMatching("item:*", {
        map: (record) => ({
          id: record.id,
          value: record.value,
          created_at: record.created_at,
        }),
        sort: (a, b) => a.value - b.value,
        slice: { start: (pageNum - 1) * pageSize, count: pageSize },
      });
    });

    // page 1 (items 1-10)
    const page1Result = await client.subscribeCollection("items:page:1");
    expect(page1Result.success).toBe(true);
    expect(page1Result.ids.length).toBe(10);
    expect(page1Result.ids).toContain("item:1");
    expect(page1Result.ids).toContain("item:10");
    expect(page1Result.ids).not.toContain("item:11");

    await client.unsubscribeCollection("items:page:1");

    // page 2 (items 11-20)
    const page2Result = await client.subscribeCollection("items:page:2");
    expect(page2Result.success).toBe(true);
    expect(page2Result.ids.length).toBe(10);
    expect(page2Result.ids).toContain("item:11");
    expect(page2Result.ids).toContain("item:20");
    expect(page2Result.ids).not.toContain("item:10");
    expect(page2Result.ids).not.toContain("item:21");

    await client.unsubscribeCollection("items:page:2");

    // page 3 (items 21-25, partial page)
    const page3Result = await client.subscribeCollection("items:page:3");
    expect(page3Result.success).toBe(true);
    expect(page3Result.ids.length).toBe(5);
    expect(page3Result.ids).toContain("item:21");
    expect(page3Result.ids).toContain("item:25");
    expect(page3Result.ids).not.toContain("item:20");

    await client.unsubscribeCollection("items:page:3");

    // page 4 (empty)
    const page4Result = await client.subscribeCollection("items:page:4");
    expect(page4Result.success).toBe(true);
    expect(page4Result.ids.length).toBe(0);

    await client.unsubscribeCollection("items:page:4");
  });
});

describe.sequential("Collection Subscriptions - Multi-Instance", () => {
  const portA = 9877;
  const portB = 9878;
  let serverA: MeshServer;
  let serverB: MeshServer;
  let clientA: MeshClient;
  let clientB: MeshClient;
  let redis: Redis;

  beforeEach(async () => {
    await flushRedis();

    serverA = createTestServer(portA);
    serverB = createTestServer(portB);
    await serverA.ready();
    await serverB.ready();

    clientA = new MeshClient(`ws://localhost:${portA}`);
    clientB = new MeshClient(`ws://localhost:${portB}`);
    await clientA.connect();
    await clientB.connect();

    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  });

  afterEach(async () => {
    await clientA.close();
    await clientB.close();
    await serverA.close();
    await serverB.close();
    await redis.quit();
  });

  test("should propagate collection diffs across instances", async () => {
    [serverA, serverB].forEach((server) => {
      server.exposeRecord("task:multi:*");
      server.exposeCollection("collection:multi-tasks", async () => server.listRecordsMatching("task:multi:*"));
    });

    const onDiffA = vi.fn();
    const onDiffB = vi.fn();

    // client A -> srv A
    const subA = await clientA.subscribeCollection("collection:multi-tasks", { onDiff: onDiffA });
    expect(subA.success).toBe(true);
    expect(subA.ids).toEqual([]);
    expect(subA.version).toBe(1);

    // client B -> srv B
    const subB = await clientB.subscribeCollection("collection:multi-tasks", { onDiff: onDiffB });
    expect(subB.success).toBe(true);
    expect(subB.ids).toEqual([]);
    expect(subB.version).toBe(1);

    onDiffA.mockClear();
    onDiffB.mockClear();

    // add a record via srv A
    await serverA.publishRecordUpdate("task:multi:1", { id: "task:multi:1", title: "Multi Task 1" });

    await wait(100);

    // verify both clients received the diff (expecting 2 calls: membership change + record update)
    expect(onDiffA).toHaveBeenCalledTimes(2);
    expect(onDiffA).toHaveBeenCalledWith({
      added: expect.arrayContaining([expect.objectContaining({ id: "task:multi:1", record: expect.any(Object) })]),
      removed: [],
      changed: [],
      version: 2,
    });

    expect(onDiffB).toHaveBeenCalledTimes(2);
    expect(onDiffB).toHaveBeenCalledWith({
      added: expect.arrayContaining([expect.objectContaining({ id: "task:multi:1", record: expect.any(Object) })]),
      removed: [],
      changed: [],
      version: 2,
    });

    onDiffA.mockClear();
    onDiffB.mockClear();

    // remove the record via srv B
    await serverB.deleteRecord("task:multi:1");

    await wait(100);

    // verify both clients received the removal diff (expecting exactly 1 call since last clear)
    expect(onDiffA).toHaveBeenCalledTimes(1);
    expect(onDiffA).toHaveBeenCalledWith({
      added: [],
      removed: expect.arrayContaining([expect.objectContaining({ id: "task:multi:1", record: expect.any(Object) })]),
      changed: [],
      version: 3,
    });

    expect(onDiffB).toHaveBeenCalledTimes(1);
    expect(onDiffB).toHaveBeenCalledWith({
      added: [],
      removed: expect.arrayContaining([expect.objectContaining({ id: "task:multi:1", record: expect.any(Object) })]),
      changed: [],
      version: 3,
    });

    await clientA.unsubscribeCollection("collection:multi-tasks");
    await clientB.unsubscribeCollection("collection:multi-tasks");
  }, 10000);
});
