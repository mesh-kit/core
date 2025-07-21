import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import "./websocket-polyfill";
import { MeshServer } from "../server";
import { MeshClient, Status } from "../client";

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MeshServer", () => {
  const port = 8126;
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

  test("clients can connect to the server", async () => {
    await clientA.connect();
    expect(clientA.status).toBe(Status.ONLINE);

    await clientB.connect();
    expect(clientB.status).toBe(Status.ONLINE);
  });

  test("clients can disconnect from the server", async () => {
    await clientA.connect();
    expect(clientA.status).toBe(Status.ONLINE);

    await clientA.close();
    expect(clientA.status).toBe(Status.OFFLINE);
  });

  test("clients can send a command and receive a response", async () => {
    server.exposeCommand("echo", async (c) => `echo: ${c.payload}`);
    await clientA.connect();
    const response = await clientA.command("echo", "Hello, World!");
    expect(response).toBe("echo: Hello, World!");
    await clientA.close();
  });

  describe("metadata", () => {
    test("server can store metadata for a connection", async () => {
      await clientA.connect();
      await clientB.connect();
      const metadataA = { name: "Client A", id: 1 };
      const metadataB = { name: "Client B", id: 2 };
      const connectionA = server.connectionManager.getLocalConnections()[0]!;
      const connectionB = server.connectionManager.getLocalConnections()[1]!;
      await server.connectionManager.setMetadata(connectionA, metadataA);
      await server.connectionManager.setMetadata(connectionB, metadataB);
      const storedMetadataA = await server.connectionManager.getMetadata(connectionA);
      const storedMetadataB = await server.connectionManager.getMetadata(connectionB);
      expect(storedMetadataA).toEqual(metadataA);
      expect(storedMetadataB).toEqual(metadataB);

      const allMetadata = await server.connectionManager.getAllMetadata();
      expect(allMetadata).toEqual([
        { id: connectionA.id, metadata: metadataA },
        { id: connectionB.id, metadata: metadataB },
      ]);

      const allMetadataFromNonExistentRoom = await server.connectionManager.getAllMetadataForRoom("non-existent-room");
      expect(allMetadataFromNonExistentRoom).toEqual([]);
    });

    test("server can retrieve metadata for a room of connections", async () => {
      await clientA.connect();
      await clientB.connect();
      const metadataA = { name: "Client A", id: 1 };
      const metadataB = { name: "Client B", id: 2 };
      const connectionA = server.connectionManager.getLocalConnections()[0]!;
      const connectionB = server.connectionManager.getLocalConnections()[1]!;
      await server.connectionManager.setMetadata(connectionA, metadataA);
      await server.connectionManager.setMetadata(connectionB, metadataB);
      await server.addToRoom("room-a", connectionA);
      await server.addToRoom("room-b", connectionB);

      const roomAMetadata = await server.connectionManager.getAllMetadataForRoom("room-a");
      expect(roomAMetadata).toEqual([{ id: connectionA.id, metadata: metadataA }]);

      const roomBMetadata = await server.connectionManager.getAllMetadataForRoom("room-b");
      expect(roomBMetadata).toEqual([{ id: connectionB.id, metadata: metadataB }]);
    });

    test("onConnection callback is executed when a client connects", async () => {
      let connectionReceived: any = null;
      const connectionPromise = new Promise<void>((resolve) => {
        server.onConnection((connection) => {
          connectionReceived = connection;
          resolve();
        });
      });

      await clientA.connect();
      await connectionPromise;

      expect(connectionReceived).not.toBeNull();

      if (!connectionReceived) {
        return;
      }

      expect(connectionReceived.id).toBeDefined();
      expect(connectionReceived.isDead).toBe(false);

      const connections = server.connectionManager.getLocalConnections();
      expect(connections).toContain(connectionReceived);
    });

    test("onDisconnection callback is executed when a client disconnects", async () => {
      let disconnectedConnection: any = null;
      const disconnectionPromise = new Promise<void>((resolve) => {
        server.onDisconnection((connection) => {
          disconnectedConnection = connection;
          resolve();
        });
      });

      await clientA.connect();
      await wait(100);
      const connections = server.connectionManager.getLocalConnections();
      const connectionBeforeDisconnect = connections[0];

      expect(connectionBeforeDisconnect).toBeDefined();
      const connectionId = connectionBeforeDisconnect?.id;

      await clientA.close();
      await disconnectionPromise;

      expect(disconnectedConnection).not.toBeNull();

      if (disconnectedConnection && connectionId) {
        expect(disconnectedConnection.id).toBe(connectionId);
        expect(disconnectedConnection.isDead).toBe(true);
      }
    });
  });
});
