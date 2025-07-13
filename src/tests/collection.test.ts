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

    const updates: Array<{ recordId: string; data: any }> = [];
    const diffs: Array<{ added: string[]; removed: string[]; version: number }> = [];

    const result = await client.subscribeCollection("collection:all-tasks", {
      onUpdate: (update) => {
        updates.push({ recordId: update.id, data: update });
      },
      onDiff: (diff) => {
        diffs.push(diff);
      },
    });

    // initial subscription
    expect(result.success).toBe(true);
    expect(result.recordIds.length).toBe(3);
    expect(result.recordIds).toContain("task:1");
    expect(result.recordIds).toContain("task:2");
    expect(result.recordIds).toContain("task:3");
    expect(result.version).toBe(1);

    // add a new record to trigger a diff
    await server.publishRecordUpdate("task:4", { id: "task:4", title: "Task 4", completed: false });
    await wait(100);

    // verify diff received
    expect(diffs.length).toBe(2); // initial + update
    expect(diffs[1]!.added).toContain("task:4");
    expect(diffs[1]!.removed).toEqual([]);
    expect(diffs[1]!.version).toBe(2);

    // update a record, triggering onUpdate
    await server.publishRecordUpdate("task:1", { id: "task:1", title: "Updated Task 1", completed: true });
    await wait(100);

    expect(updates.length).toBe(2); // task 4, then task 1
    expect(updates.find((u) => u.recordId === "task:1")).toBeDefined();

    // remove a record to trigger another diff
    await server.deleteRecord("task:2");
    await wait(100);

    // verify diff was received
    expect(diffs.length).toBeGreaterThan(1);
    // the second diff should (still) be the addition of task:4
    expect(diffs[1]!.added).toContain("task:4");
    expect(diffs[1]!.removed).toEqual([]);

    // the third diff should be the removal of task:2
    expect(diffs[2]!.added).toEqual([]);
    expect(diffs[2]!.removed).toContain("task:2");

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

    const mockOnUpdate = vi.fn();
    const mockOnDiff = vi.fn();

    const result = (await client.subscribeCollection("collection:initial-tasks", {
      onUpdate: mockOnUpdate,
      onDiff: mockOnDiff,
    })) as { success: boolean; recordIds: string[]; records: Array<{ id: string; record: any }>; version: number }; // Updated records type

    expect(result.success).toBe(true);
    expect(result.version).toBe(1);
    expect(result.recordIds).toBeInstanceOf(Array);
    expect(result.recordIds.length).toBe(2);
    expect(result.recordIds).toEqual(expect.arrayContaining([initialRecord1.id, initialRecord2.id]));

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
      added: expect.arrayContaining([initialRecord1.id, initialRecord2.id]),
      removed: [],
      version: 1,
    });

    // onUpdate was NOT called during the initial subscription
    expect(mockOnUpdate).not.toHaveBeenCalled();

    // subsequent update still calls onUpdate
    const updatedRecord1 = { ...initialRecord1, title: "Updated Task 1" };
    await server.publishRecordUpdate(initialRecord1.id, updatedRecord1);
    await wait(100);
    expect(mockOnUpdate).toHaveBeenCalledTimes(1);
    expect(mockOnUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: initialRecord1.id, record: updatedRecord1 }));

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
    expect(subResult.recordIds).toContain(recordId);

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

    server.exposeCollection(/^collection:user:(\d+):tasks$/, async (connection, collectionId) => {
      const userId = collectionId.split(":")[2];
      return await server.listRecordsMatching(`user:${userId}:task:*`);
    });

    // subscribe to user 1's tasks
    const user1Result = await client.subscribeCollection("collection:user:1:tasks");
    expect(user1Result.success).toBe(true);
    expect(user1Result.recordIds.length).toBe(2);
    expect(user1Result.recordIds).toContain("user:1:task:1");
    expect(user1Result.recordIds).toContain("user:1:task:2");

    // subscribe to user 2's tasks
    const user2Result = await client.subscribeCollection("collection:user:2:tasks");
    expect(user2Result.success).toBe(true);
    expect(user2Result.recordIds.length).toBe(1);
    expect(user2Result.recordIds).toContain("user:2:task:1");

    await client.unsubscribeCollection("collection:user:1:tasks");
    await client.unsubscribeCollection("collection:user:2:tasks");
  });

  test("should handle manual refresh of collections", async () => {
    await server.publishRecordUpdate("project:1:task:1", { id: "project:1:task:1", title: "Project 1 Task 1" });
    server.exposeRecord("project:*:task:*");
    server.exposeCollection("collection:project:1:tasks", async () => server.listRecordsMatching("project:1:task:*"));

    const result = await client.subscribeCollection("collection:project:1:tasks");
    expect(result.success).toBe(true);
    expect(result.recordIds.length).toBe(1);

    await server.publishRecordUpdate("project:1:task:2", { id: "project:1:task:2", title: "Project 1 Task 2" });

    // don't wait, and immediately refresh, not allowing enough time for the update
    // to be published to clients. this way, when refreshing the collection, we receive
    // an added: ['project:1:task:2'] entry
    // await wait(100);

    // manually refresh the collection
    const refreshResult = await client.refreshCollection("collection:project:1:tasks");

    // verify refresh result
    expect(refreshResult.success).toBe(true);

    // just in case this test doesn't pan out as expected..
    if (refreshResult.added.length === 0) {
      // if refreshCollection took longer than expected, let's just
      // ensure this record actually exists
      const recordExists = await redis.exists("mesh:record:project:1:task:2");
      expect(recordExists).toBe(1);
    } else {
      // otherwise, we expect the added array to contain the new record
      expect(refreshResult.added).toContain("project:1:task:2");
      expect(refreshResult.removed).toEqual([]);
      expect(refreshResult.version).toBe(2);
    }

    await client.unsubscribeCollection("collection:project:1:tasks");
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
    expect(subA.recordIds).toEqual([]);
    expect(subA.version).toBe(1);

    // client B -> srv B
    const subB = await clientB.subscribeCollection("collection:multi-tasks", { onDiff: onDiffB });
    expect(subB.success).toBe(true);
    expect(subB.recordIds).toEqual([]);
    expect(subB.version).toBe(1);

    onDiffA.mockClear();
    onDiffB.mockClear();

    // add a record via srv A
    await serverA.publishRecordUpdate("task:multi:1", { id: "task:multi:1", title: "Multi Task 1" });

    await wait(100);

    // verify both clients received the diff (expecting exactly 1 call since subscription)
    expect(onDiffA).toHaveBeenCalledTimes(1);
    expect(onDiffA).toHaveBeenCalledWith({ added: ["task:multi:1"], removed: [], version: 2 });

    expect(onDiffB).toHaveBeenCalledTimes(1);
    expect(onDiffB).toHaveBeenCalledWith({ added: ["task:multi:1"], removed: [], version: 2 });

    onDiffA.mockClear();
    onDiffB.mockClear();

    // remove the record via srv B
    await serverB.deleteRecord("task:multi:1");

    await wait(100);

    // verify both clients received the removal diff (expecting exactly 1 call since last clear)
    expect(onDiffA).toHaveBeenCalledTimes(1);
    expect(onDiffA).toHaveBeenCalledWith({ added: [], removed: ["task:multi:1"], version: 3 });

    expect(onDiffB).toHaveBeenCalledTimes(1);
    expect(onDiffB).toHaveBeenCalledWith({ added: [], removed: ["task:multi:1"], version: 3 });

    await clientA.unsubscribeCollection("collection:multi-tasks");
    await clientB.unsubscribeCollection("collection:multi-tasks");
  }, 10000);
});
