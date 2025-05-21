import type { PersistenceAdapter, PersistedMessage, PersistenceAdapterOptions, PersistedRecord } from "./types";
import { serverLogger } from "../../common/logger";
import sqlite3 from "sqlite3";
import { convertToSqlPattern } from "../utils/pattern-conversion";

const { Database } = sqlite3;

type SQLiteDatabase = sqlite3.Database;

export class SQLitePersistenceAdapter implements PersistenceAdapter {
  private db: SQLiteDatabase | null = null;
  private options: PersistenceAdapterOptions;
  private initialized = false;

  constructor(options: PersistenceAdapterOptions = {}) {
    this.options = {
      filename: ":memory:",
      ...options,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise<void>((resolve, reject) => {
      try {
        this.db = new Database(this.options.filename as string, (err: Error | null) => {
          if (err) {
            serverLogger.error("Failed to open SQLite database:", err);
            reject(err);
            return;
          }

          this.createTables()
            .then(() => {
              this.initialized = true;
              resolve();
            })
            .catch(reject);
        });
      } catch (err) {
        serverLogger.error("Error initializing SQLite database:", err);
        reject(err);
      }
    });
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    return new Promise<void>((resolve, reject) => {
      this.db!.run(
        `CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        message TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      )`,
        (err: Error | null) => {
          if (err) {
            reject(err);
            return;
          }

          this.db!.run("CREATE INDEX IF NOT EXISTS idx_channel_timestamp ON channel_messages (channel, timestamp)", (err: Error | null) => {
            if (err) {
              reject(err);
              return;
            }

            this.db!.run(
              `CREATE TABLE IF NOT EXISTS records (
              record_id TEXT PRIMARY KEY,
              version INTEGER NOT NULL,
              value TEXT NOT NULL,
              timestamp INTEGER NOT NULL
            )`,
              (err: Error | null) => {
                if (err) {
                  reject(err);
                  return;
                }

                this.db!.run("CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records (timestamp)", (err: Error | null) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  resolve();
                });
              },
            );
          });
        },
      );
    });
  }

  async storeMessages(messages: PersistedMessage[]): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    if (messages.length === 0) return;

    return new Promise<void>((resolve, reject) => {
      const db = this.db!;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const stmt = db.prepare(
          `INSERT INTO channel_messages
           (id, channel, message, instance_id, timestamp, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        try {
          for (const msg of messages) {
            const metadata = msg.metadata ? JSON.stringify(msg.metadata) : null;
            stmt.run(msg.id, msg.channel, msg.message, msg.instanceId, msg.timestamp, metadata);
          }

          stmt.finalize();

          db.run("COMMIT", (err: Error | null) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } catch (err) {
          db.run("ROLLBACK");
          reject(err);
        }
      });
    });
  }

  async getMessages(channel: string, since?: string | number, limit: number = 50): Promise<PersistedMessage[]> {
    if (!this.db) throw new Error("Database not initialized");

    let query = "SELECT * FROM channel_messages WHERE channel = ?";
    const params: any[] = [channel];

    if (since !== undefined) {
      // if since is a number, assume it's a timestamp
      // if it's a string, assume it's a message ID
      if (typeof since === "number") {
        query += " AND timestamp > ?";
        params.push(since);
      } else {
        // get the timestamp of the message with the given ID
        const timestampQuery = await new Promise<number>((resolve, reject) => {
          this.db!.get("SELECT timestamp FROM channel_messages WHERE id = ?", [since], (err: Error | null, row: any) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(row ? row.timestamp : 0);
          });
        });

        query += " AND timestamp > ?";
        params.push(timestampQuery);
      }
    }

    query += " ORDER BY timestamp ASC LIMIT ?";
    params.push(limit);

    return new Promise<PersistedMessage[]>((resolve, reject) => {
      this.db!.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
          return;
        }

        const messages: PersistedMessage[] = rows.map((row) => ({
          id: row.id,
          channel: row.channel,
          message: row.message,
          instanceId: row.instance_id,
          timestamp: row.timestamp,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        }));

        resolve(messages);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.db) return;

    return new Promise<void>((resolve, reject) => {
      this.db!.close((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        this.db = null;
        this.initialized = false;
        resolve();
      });
    });
  }
  /**
   * Store records in the database
   * @param records Array of records to store
   */
  async storeRecords(records: PersistedRecord[]): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    if (records.length === 0) return;

    serverLogger.debug(`SQLite: Storing ${records.length} records`);

    return new Promise<void>((resolve, reject) => {
      const db = this.db!;

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const stmt = db.prepare(
          `INSERT OR REPLACE INTO records
           (record_id, version, value, timestamp)
           VALUES (?, ?, ?, ?)`,
        );

        try {
          for (const record of records) {
            stmt.run(record.recordId, record.version, record.value, record.timestamp, (err: Error | null) => {
              if (err) {
                serverLogger.error(`Error storing record ${record.recordId}:`, err);
              }
            });
          }

          stmt.finalize();

          db.run("COMMIT", (err: Error | null) => {
            if (err) {
              serverLogger.error("Error committing transaction:", err);
              db.run("ROLLBACK");
              reject(err);
            } else {
              resolve();
            }
          });
        } catch (err) {
          serverLogger.error("Error in storeRecords:", err);
          db.run("ROLLBACK");
          reject(err);
        }
      });
    });
  }

  /**
   * Get records matching a pattern
   * @param pattern Pattern to match record IDs against
   * @returns Array of matching records
   */
  async getRecords(pattern: string): Promise<PersistedRecord[]> {
    if (!this.db) throw new Error("Database not initialized");

    const sqlPattern = convertToSqlPattern(pattern);

    serverLogger.debug(`SQLite: Getting records matching pattern: ${pattern} (SQL: ${sqlPattern})`);

    return new Promise<PersistedRecord[]>((resolve, reject) => {
      this.db!.all(
        `SELECT record_id, version, value, timestamp
         FROM records
         WHERE record_id LIKE ?
         ORDER BY timestamp DESC`,
        [sqlPattern],
        (err: Error | null, rows: any[]) => {
          if (err) {
            serverLogger.error("Error getting records:", err);
            reject(err);
            return;
          }

          serverLogger.debug(`SQLite: Found ${rows.length} records matching pattern ${pattern}`);

          const records: PersistedRecord[] = rows.map((row) => ({
            recordId: row.record_id,
            version: row.version,
            value: row.value,
            timestamp: row.timestamp,
          }));

          resolve(records);
        },
      );
    });
  }
}
