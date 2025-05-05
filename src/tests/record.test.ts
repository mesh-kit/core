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
  });

const flushRedis = async () => {
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.flushdb();
  await redis.quit();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Record Update and Remove Hooks", () => {
  const port = 8140;
  let server: MeshServer;
  let client: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    server.exposeRecord(/^test:record:.*/);
    server.exposeWritableRecord(/^writable:record:.*/);
    await server.ready();

    client = new MeshClient(`ws://localhost:${port}`);
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  test("onRecordUpdate callback is triggered when a record is updated", async () => {
    const recordId = "test:record:update";
    const initialData = { count: 0, name: "initial" };
    const updatedData = { count: 1, name: "updated" };

    const updateCallback = vi.fn();
    const unregister = server.onRecordUpdate(updateCallback);

    await server.publishRecordUpdate(recordId, initialData);
    await wait(50);

    expect(updateCallback).toHaveBeenCalledTimes(1);
    expect(updateCallback).toHaveBeenCalledWith({
      recordId,
      value: initialData,
    });

    await server.publishRecordUpdate(recordId, updatedData);
    await wait(50);

    expect(updateCallback).toHaveBeenCalledTimes(2);
    expect(updateCallback).toHaveBeenCalledWith({
      recordId,
      value: updatedData,
    });

    unregister();

    await server.publishRecordUpdate(recordId, { count: 2 });
    await wait(50);

    expect(updateCallback).toHaveBeenCalledTimes(2);
  });

  test("onRecordUpdate callback is triggered when a client updates a record", async () => {
    const recordId = "writable:record:client-update";
    const data = { message: "from client" };

    const updateCallback = vi.fn();
    server.onRecordUpdate(updateCallback);

    const success = await client.publishRecordUpdate(recordId, data);
    expect(success).toBe(true);

    await wait(100);

    expect(updateCallback).toHaveBeenCalledTimes(1);
    expect(updateCallback).toHaveBeenCalledWith({
      recordId,
      value: data,
    });
  });

  test("onRecordRemoved callback is triggered when a record is deleted", async () => {
    const recordId = "test:record:delete";
    const initialData = { count: 0, name: "to be deleted" };

    await server.publishRecordUpdate(recordId, initialData);
    await wait(50);

    const removeCallback = vi.fn();
    const unregister = server.onRecordRemoved(removeCallback);

    await server.recordManager.deleteRecord(recordId);
    await wait(50);

    expect(removeCallback).toHaveBeenCalledTimes(1);
    expect(removeCallback).toHaveBeenCalledWith({
      recordId,
      value: initialData,
    });

    unregister();

    const anotherRecordId = "test:record:another-delete";
    await server.publishRecordUpdate(anotherRecordId, { test: true });
    await wait(50);

    await server.recordManager.deleteRecord(anotherRecordId);
    await wait(50);

    expect(removeCallback).toHaveBeenCalledTimes(1);
  });

  test("multiple callbacks can be registered for record updates", async () => {
    const recordId = "test:record:multiple-callbacks";
    const data = { value: "test" };

    const callback1 = vi.fn();
    const callback2 = vi.fn();

    server.onRecordUpdate(callback1);
    server.onRecordUpdate(callback2);

    await server.publishRecordUpdate(recordId, data);
    await wait(50);

    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback1).toHaveBeenCalledWith({
      recordId,
      value: data,
    });

    expect(callback2).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledWith({
      recordId,
      value: data,
    });
  });

  test("multiple callbacks can be registered for record removals", async () => {
    const recordId = "test:record:multiple-remove-callbacks";
    const data = { value: "to be removed" };

    await server.publishRecordUpdate(recordId, data);
    await wait(50);

    const callback1 = vi.fn();
    const callback2 = vi.fn();

    server.onRecordRemoved(callback1);
    server.onRecordRemoved(callback2);

    await server.recordManager.deleteRecord(recordId);
    await wait(50);

    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback1).toHaveBeenCalledWith({
      recordId,
      value: data,
    });

    expect(callback2).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledWith({
      recordId,
      value: data,
    });
  });

  test("error in one callback doesn't prevent other callbacks from executing", async () => {
    const recordId = "test:record:error-handling";
    const data = { value: "test" };

    const originalConsoleError = console.error;
    console.error = vi.fn();

    const errorCallback = vi.fn().mockImplementation(() => {
      throw new Error("Callback error");
    });

    const successCallback = vi.fn();

    server.onRecordUpdate(errorCallback);
    server.onRecordUpdate(successCallback);

    await server.publishRecordUpdate(recordId, data);
    await wait(50);

    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(successCallback).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();

    console.error = originalConsoleError;
  });

  test("async callbacks are properly awaited", async () => {
    const recordId = "test:record:async";
    const data = { value: "async test" };

    let asyncOperationCompleted = false;

    const asyncCallback = vi.fn().mockImplementation(async () => {
      await wait(50);
      asyncOperationCompleted = true;
    });

    server.onRecordUpdate(asyncCallback);

    await server.publishRecordUpdate(recordId, data);

    expect(asyncOperationCompleted).toBe(false);

    await wait(100);

    expect(asyncOperationCompleted).toBe(true);
    expect(asyncCallback).toHaveBeenCalledTimes(1);
  });

  test("record is only fetched when callbacks are registered", async () => {
    const recordId = "test:record:optimization";
    const data = { value: "test data" };

    await server.publishRecordUpdate(recordId, data);
    await wait(50);

    const getRecordSpy = vi.spyOn(server.recordManager, "getRecord");

    await server.recordManager.deleteRecord(recordId);

    expect(getRecordSpy).not.toHaveBeenCalled();

    const anotherRecordId = "test:record:with-callback";
    await server.publishRecordUpdate(anotherRecordId, data);
    await wait(50);

    server.onRecordRemoved(vi.fn());

    getRecordSpy.mockClear();

    await server.recordManager.deleteRecord(anotherRecordId);

    expect(getRecordSpy).toHaveBeenCalledTimes(1);
    expect(getRecordSpy).toHaveBeenCalledWith(anotherRecordId);
  });
});
