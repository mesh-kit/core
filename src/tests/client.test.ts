import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
import { MeshServer } from "../server";
import { MeshClient, Status } from "../client";

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

describe("MeshClient", () => {
  const port = 8127;
  let server: MeshServer;
  let client: MeshClient;

  beforeEach(async () => {
    await flushRedis();

    server = createTestServer(port);
    await server.ready();

    client = new MeshClient(`ws://localhost:${port}`);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  test("command times out when server doesn't respond", async () => {
    server.exposeCommand("never-responds", async () => new Promise(() => {}));

    await client.connect();

    await expect(
      client.command("never-responds", "Should time out", 100)
    ).rejects.toThrow(/timed out/);
  }, 2000);

  test("an unknown command should return an error object", async () => {
    await client.connect();

    const result = await client.command("unknown-command", "Should fail");
    expect(result).toEqual({
      code: "ENOTFOUND",
      error: 'Command "unknown-command" not found',
      name: "CommandError",
    });
  });

  test("thrown servers errors are serialized to the client", async () => {
    server.exposeCommand("throws-error", async () => {
      throw new Error("This is a test error");
    });

    await client.connect();

    const result = await client.command("throws-error", "Should fail");
    expect(result).toEqual({
      code: "ESERVER",
      error: "This is a test error",
      name: "Error",
    });
  });

  test("handles large payloads without issue", async () => {
    server.exposeCommand("echo", async (ctx) => ctx.payload);
    await client.connect();

    const largeData = {
      array: Array(1000)
        .fill(0)
        .map((_, i) => `item-${i}`),
      nested: {
        deep: {
          object: {
            with: "lots of data",
          },
        },
      },
    };

    const result = await client.command("echo", largeData, 200);
    expect(result).toEqual(largeData);
  });

  test("client emits 'connect' event on successful connection", async () =>
    new Promise<void>((resolve) => {
      client.on("connect", () => {
        expect(client.status).toBe(Status.ONLINE);
        resolve();
      });

      client.connect();
    }));

  test("client emits 'disconnect' and 'close' events on successful disconnection", async () =>
    new Promise<void>((resolve) => {
      let disconnectEmitted = false;
      let closeEmitted = false;

      const checkBothEvents = () => {
        if (disconnectEmitted && closeEmitted) {
          resolve();
        }
      };

      client.on("disconnect", () => {
        expect(client.status).toBe(Status.OFFLINE);
        disconnectEmitted = true;
        checkBothEvents();
      });

      client.on("close", () => {
        expect(client.status).toBe(Status.OFFLINE);
        closeEmitted = true;
        checkBothEvents();
      });

      client.connect().then(() => {
        client.close();
      });
    }));

  test("client emits 'message' event on receiving a message", async () =>
    new Promise<void>((resolve) => {
      client.on("message", (data) => {
        expect(data).toEqual({ command: "hello", payload: "world" });
        resolve();
      });

      client.connect().then(() => {
        server.broadcast("hello", "world");
      });
    }));

  test("client receives 'ping' messages", async () => {
    const server = new MeshServer({
      port: 8130,
      pingInterval: 10,
      maxMissedPongs: 10,
      redisOptions: { host: REDIS_HOST, port: REDIS_PORT },
    });

    await server.ready();
    const client = new MeshClient(`ws://localhost:8130`, {
      pingTimeout: 10,
      maxMissedPings: 10,
    });
    await client.connect();

    return new Promise<void>((resolve) => {
      client.on("ping", () => {
        expect(client.status).toBe(Status.ONLINE);
        resolve();
      });
      client.on("close", () => {
        expect(client.status).toBe(Status.OFFLINE);
      });
    });
  });

  test("client receives 'latency' messages", async () => {
    const server = new MeshServer({
      port: 8131,
      pingInterval: 10,
      latencyInterval: 10,
      maxMissedPongs: 10,
      redisOptions: { host: REDIS_HOST, port: REDIS_PORT },
    });

    await server.ready();
    const client = new MeshClient(`ws://localhost:8131`, {
      pingTimeout: 10,
      maxMissedPings: 10,
    });
    await client.connect();

    return new Promise<void>((resolve) => {
      client.on("latency", (data) => {
        expect(data).toBeDefined();
        resolve();
      });
      client.on("close", () => {
        expect(client.status).toBe(Status.OFFLINE);
      });
    });
  });

  test("client can get room metadata", async () => {
    const roomName = "test-room";
    const metadata = { key: "value", nested: { data: true } };

    await client.connect();
    await client.joinRoom(roomName);

    await server.roomManager.setMetadata(roomName, metadata);

    const retrievedMetadata = await client.getRoomMetadata(roomName);
    expect(retrievedMetadata).toEqual(metadata);
  });

  test("client can get connection metadata", async () => {
    await client.connect();
    const clientConnection = server.connectionManager.getLocalConnections()[0]!;

    const metadata = { user: "test-user", permissions: ["read", "write"] };
    await server.connectionManager.setMetadata(clientConnection, metadata);

    const retrievedMetadata = await client.getConnectionMetadata(
      clientConnection.id
    );
    expect(retrievedMetadata).toEqual(metadata);
  });

  test("client can get their own connection metadata", async () => {
    await client.connect();
    const clientConnection = server.connectionManager.getLocalConnections()[0]!;
    const metadata = { user: "test-user", permissions: ["read", "write"] };
    await server.connectionManager.setMetadata(clientConnection, metadata);
    const retrievedMetadata = await client.getConnectionMetadata();
    expect(retrievedMetadata).toEqual(metadata);
  });

  test("helper methods register event listeners correctly", async () => {
    const connectSpy = vi.fn();
    const disconnectSpy = vi.fn();
    const reconnectSpy = vi.fn();
    const reconnectFailedSpy = vi.fn();

    client
      .onConnect(connectSpy)
      .onDisconnect(disconnectSpy)
      .onReconnect(reconnectSpy)
      .onReconnectFailed(reconnectFailedSpy);

    await client.connect();
    expect(connectSpy).toHaveBeenCalled();

    client.emit("disconnect");
    expect(disconnectSpy).toHaveBeenCalled();

    client.emit("reconnect");
    expect(reconnectSpy).toHaveBeenCalled();

    client.emit("reconnectfailed");
    expect(reconnectFailedSpy).toHaveBeenCalled();
  });
});
