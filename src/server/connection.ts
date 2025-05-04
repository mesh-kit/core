import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { type Command, parseCommand, stringifyCommand } from "../common/message";
import { Status } from "../common/status";
import { Latency } from "./latency";
import { Ping } from "./ping";
import type { MeshServer, MeshServerOptions } from "./";
import { getCreateId } from "./utils/ids";
import { serverLogger } from "../common/logger";

const getId = getCreateId({ init: Date.now(), len: 4 });

export class Connection extends EventEmitter {
  id: string;
  socket: WebSocket;
  alive = true;
  missedPongs = 0;
  latency!: Latency;
  ping!: Ping;
  remoteAddress: string;
  connectionOptions: MeshServerOptions;
  status: Status = Status.ONLINE;
  server: MeshServer;

  constructor(socket: WebSocket, req: IncomingMessage, options: MeshServerOptions, server: MeshServer) {
    super();
    this.socket = socket;
    this.id = getId();
    this.remoteAddress = req.socket.remoteAddress!;
    this.connectionOptions = options;
    this.server = server;

    this.applyListeners();
    this.startIntervals();
  }

  get isDead(): boolean {
    return !this.socket || this.socket.readyState !== WebSocket.OPEN;
  }

  private startIntervals(): void {
    this.latency = new Latency();
    this.ping = new Ping();

    this.latency.interval = setInterval(() => {
      if (!this.alive) {
        return;
      }

      if (typeof this.latency.ms === "number") {
        this.send({ command: "latency", payload: this.latency.ms });
      }

      this.latency.onRequest();
      this.send({ command: "latency:request", payload: {} });
    }, this.connectionOptions.latencyInterval);

    this.ping.interval = setInterval(() => {
      if (!this.alive) {
        this.missedPongs++;
        const maxMissedPongs = this.connectionOptions.maxMissedPongs ?? 1;
        if (this.missedPongs > maxMissedPongs) {
          serverLogger.info(`Closing connection (${this.id}) due to missed pongs`);
          this.close();
          this.server.cleanupConnection(this);
          return;
        }
      } else {
        this.missedPongs = 0;
      }

      this.alive = false;
      this.send({ command: "ping", payload: {} });
    }, this.connectionOptions.pingInterval);
  }

  stopIntervals(): void {
    clearInterval(this.latency.interval);
    clearInterval(this.ping.interval);
  }

  private applyListeners(): void {
    this.socket.on("close", () => {
      serverLogger.info("Client's socket closed:", this.id);
      this.status = Status.OFFLINE;
      this.emit("close");
    });

    this.socket.on("error", (error) => {
      this.emit("error", error);
    });

    this.socket.on("message", (data: Buffer) => {
      try {
        const command = parseCommand(data.toString());

        if (command.command === "latency:response") {
          this.latency.onResponse();
          return;
        } else if (command.command === "pong") {
          this.alive = true;
          this.missedPongs = 0;

          // this refreshes presence TTL for all rooms this connection is in
          this.emit("pong", this.id);

          return;
        }

        this.emit("message", data);
      } catch (error) {
        this.emit("error", error);
      }
    });
  }

  send(cmd: Command): boolean {
    if (this.isDead) return false;

    try {
      this.socket.send(stringifyCommand(cmd));
      return true;
    } catch (error) {
      this.emit("error", error);
      return false;
    }
  }

  async close(): Promise<boolean> {
    if (this.isDead) return false;

    try {
      await new Promise<void>((resolve, reject) => {
        this.socket.once("close", resolve);
        this.socket.once("error", reject);
        this.socket.close();
      });
      return true;
    } catch (error) {
      this.emit("error", error);
      return false;
    }
  }
}
