import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { MeshServer } from "../server/mesh-server";
import { MeshClient } from "../client/client";
import { PostgreSQLPersistenceAdapter } from "../server/persistence/postgres-adapter";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import Redis from "ioredis";
import "./websocket-polyfill";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
const POSTGRES_HOST = process.env.POSTGRES_HOST || "127.0.0.1";
const POSTGRES_PORT = process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5432;

const testDir = path.join(__dirname, "../../test-temp");
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

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

type AdapterType = "sqlite" | "postgres";

const adapterConfigs = {
  sqlite: {
    name: "SQLite",
    getOptions: () => ({ filename: path.join(testDir, `test-db-${uuidv4()}.sqlite`) }),
    cleanup: (options: any) => {
      if (fs.existsSync(options.filename)) {
        fs.unlinkSync(options.filename);
      }
    },
  },
  postgres: {
    name: "PostgreSQL",
    getOptions: () => ({
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
      database: "mesh_test",
      user: "mesh",
      password: "mesh_password",
    }),
    cleanup: async (options: any) => {
      const adapter = new PostgreSQLPersistenceAdapter(options);
      try {
        await adapter.initialize();
        await (adapter as any).pool?.query("DELETE FROM records");
        await (adapter as any).pool?.query("DELETE FROM channel_messages");
      } catch (err) {
        // Ignore cleanup errors
      } finally {
        await adapter.close();
      }
    },
  },
};

describe("Record Persistence System", () => {
  describe("PersistenceManager with Records", () => {
    let server: MeshServer;
    const port = 8140;
    const dbPath = path.join(testDir, `test-db-${uuidv4()}.sqlite`);

    beforeEach(async () => {
      await flushRedis();

      server = createTestServer(port);
      server.serverOptions.persistenceOptions = {
        filename: dbPath,
      };

      await server.ready();
    });

    afterEach(async () => {
      await server.close();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    test("enables persistence for records matching a pattern", () => {
      const { persistenceManager } = server as any;
      const initialLength = persistenceManager.recordPatterns.length;

      server.enableRecordPersistence("profile:user:*");

      expect(persistenceManager.recordPatterns.length).toBe(initialLength + 1);
      expect(persistenceManager.recordPatterns.at(-1).pattern).toBe("profile:user:*");
    });

    test("handles record updates and adds them to the buffer", async () => {
      server.enableRecordPersistence("profile:user:*");

      const { persistenceManager } = server as any;
      const handleRecordUpdateSpy = vi.spyOn(persistenceManager, "handleRecordUpdate");

      const recordId = "profile:user:123";
      const recordValue = { name: "Test User", status: "active" };
      await server.publishRecordUpdate(recordId, recordValue);

      expect(handleRecordUpdateSpy).toHaveBeenCalledWith(recordId, recordValue, expect.any(Number));
    });

    test("flushes records to storage when buffer limit is reached", async () => {
      server.enableRecordPersistence(/^profile:user:.*/, {
        maxBufferSize: 2,
      });

      const { persistenceManager } = server as any;
      const flushRecordsSpy = vi.spyOn(persistenceManager, "flushRecords");

      await server.publishRecordUpdate("profile:user:1", { name: "User 1" });
      expect(flushRecordsSpy).not.toHaveBeenCalled();
      await server.publishRecordUpdate("profile:user:2", { name: "User 2" });
      expect(flushRecordsSpy).toHaveBeenCalled();
    });
  });

  (["sqlite", "postgres"] as AdapterType[]).forEach((adapterType) => {
    const config = adapterConfigs[adapterType];

    describe(`${config.name} Persistence Adapter with Records`, () => {
      let server: MeshServer;
      const port = adapterType === "sqlite" ? 8141 : 8143;
      let adapterOptions: any;

      beforeEach(async () => {
        await flushRedis();
        adapterOptions = config.getOptions();

        server = createTestServer(port);
        server.serverOptions.persistenceOptions = adapterOptions;
        if (adapterType === "postgres") {
          server.serverOptions.persistenceAdapter = "postgres";
        }

        await server.ready();
        server.enableRecordPersistence(/^profile:user:.*/);
      });

      afterEach(async () => {
        await server.close();
        await config.cleanup(adapterOptions);
      });

      test("stores and retrieves records", async () => {
        const record1 = { name: "User 1", status: "active" };
        const record2 = { name: "User 2", status: "inactive" };

        await server.publishRecordUpdate("profile:user:1", record1);
        await server.publishRecordUpdate("profile:user:2", record2);

        const { persistenceManager } = server as any;
        const retrievedRecords = await persistenceManager.getPersistedRecords("profile:user:*");

        expect(retrievedRecords.length).toBe(2);

        const parsedRecords = retrievedRecords.map((r: any) => ({
          recordId: r.recordId,
          value: JSON.parse(r.value),
        }));

        expect(parsedRecords).toContainEqual({ recordId: "profile:user:1", value: record1 });
        expect(parsedRecords).toContainEqual({ recordId: "profile:user:2", value: record2 });
      });

      test("updates existing records with new versions", async () => {
        const initialRecord = { name: "User 1", status: "active" };
        await server.publishRecordUpdate("profile:user:1", initialRecord);

        const updatedRecord = { name: "User 1", status: "inactive" };
        await server.publishRecordUpdate("profile:user:1", updatedRecord);

        const { persistenceManager } = server as any;
        const retrievedRecords = await persistenceManager.getPersistedRecords("profile:user:1");

        expect(retrievedRecords.length).toBe(1);

        const parsedRecord = JSON.parse(retrievedRecords[0].value);
        expect(parsedRecord).toEqual(updatedRecord);

        expect(retrievedRecords[0].version).toBeGreaterThan(1);
      });
    });
  });

  (["sqlite", "postgres"] as AdapterType[]).forEach((adapterType) => {
    const config = adapterConfigs[adapterType];

    describe(`Integration Tests - ${config.name}`, () => {
      let server: MeshServer;
      let client: MeshClient;
      const port = adapterType === "sqlite" ? 8142 : 8144;
      let adapterOptions: any;

      beforeEach(async () => {
        await flushRedis();
        adapterOptions = config.getOptions();

        server = createTestServer(port);
        server.serverOptions.persistenceOptions = adapterOptions;
        if (adapterType === "postgres") {
          server.serverOptions.persistenceAdapter = "postgres";
        }

        await server.ready();

        server.exposeWritableRecord(/^profile:user:.*/);
        server.enableRecordPersistence(/^profile:user:.*/, { flushInterval: 100 });

        client = new MeshClient(`ws://localhost:${port}`);
        await client.connect();
      });

      afterEach(async () => {
        await client.close();
        await server.close();
        await config.cleanup(adapterOptions);
      });

      test("restores records from storage on server startup", async () => {
        const recordId = `profile:user:${uuidv4()}`;
        const recordValue = { name: "Restored User", status: "active", testId: recordId };

        const adapter = (server as any).persistenceManager.defaultAdapter;
        await adapter.storeRecords([
          {
            recordId,
            value: JSON.stringify(recordValue),
            version: 1,
            timestamp: Date.now(),
          },
        ]);

        const existingRecord = await server.getRecord(recordId);
        expect(existingRecord).toBeNull();

        await (server as any).persistenceManager.restorePersistedRecords();

        const restoredRecord = await server.getRecord(recordId);
        expect(restoredRecord).toEqual(recordValue);
      });

      test("client can subscribe to records that have persistence enabled", async () => {
        const recordId = "profile:user:456";
        const recordValue = { name: "Another User", status: "busy" };

        await server.publishRecordUpdate(recordId, recordValue);

        const { success, record } = await client.subscribeRecord(recordId);

        expect(success).toBe(true);
        expect(record).toEqual(recordValue);
      });
    });
  });
});
