import { EventEmitter } from "eventemitter3";
import { CodeError } from "../common/codeerror";
import { type Command, parseCommand, stringifyCommand } from "../common/message";
import { Status } from "../common/status";
import { IdManager } from "./ids";
import { Queue } from "./queue";

export class Connection extends EventEmitter {
  socket: WebSocket | null = null;
  ids = new IdManager();
  queue = new Queue();
  callbacks: { [id: number]: (result: any, error?: Error) => void } = {};
  status: Status = Status.OFFLINE;

  constructor(socket: WebSocket | null) {
    super();
    this.socket = socket;
    if (socket) {
      this.applyListeners();
    }
  }

  get isDead(): boolean {
    return !this.socket || this.socket.readyState !== WebSocket.OPEN;
  }

  send(command: Command): boolean {
    try {
      if (!this.isDead) {
        this.socket?.send(stringifyCommand(command));
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  sendWithQueue(command: Command, expiresIn: number): boolean {
    const success = this.send(command);

    if (!success) {
      this.queue.add(command, expiresIn);
    }

    return success;
  }

  applyListeners(reconnection = false): void {
    if (!this.socket) return;

    const drainQueue = () => {
      while (!this.queue.isEmpty) {
        const item = this.queue.pop();
        if (item) {
          this.send(item.value);
        }
      }
    };

    if (reconnection) {
      drainQueue();
    }

    this.socket.onclose = () => {
      this.status = Status.OFFLINE;
      this.emit("close");
      this.emit("disconnect");
    };

    this.socket.onerror = (error) => {
      this.emit("error", error);
    };

    this.socket.onmessage = (event: any) => {
      try {
        const data = parseCommand(event.data as string);

        this.emit("message", data);

        if (data.command === "latency:request") {
          this.emit("latency:request", data.payload);
          this.command("latency:response", data.payload, null);
        } else if (data.command === "latency") {
          this.emit("latency", data.payload);
        } else if (data.command === "ping") {
          this.emit("ping");
          this.command("pong", {}, null);
        } else {
          this.emit(data.command, data.payload);
        }

        if (data.id !== undefined && this.callbacks[data.id]) {
          // @ts-ignore
          this.callbacks[data.id](data.payload);
        }
      } catch (error) {
        this.emit("error", error);
      }
    };
  }

  command(
    command: string,
    payload: any,
    expiresIn: number | null = 30_000,
    callback?: (result: any, error?: Error) => void
  ): Promise<any> {
    const id = this.ids.reserve();
    const cmd: Command = { id, command, payload: payload ?? {} };

    this.sendWithQueue(cmd, expiresIn || 30000);

    if (expiresIn === null) {
      this.ids.release(id);
      return Promise.resolve();
    }

    const responsePromise = new Promise<any>((resolve, reject) => {
      this.callbacks[id] = (result: any, error?: Error) => {
        this.ids.release(id);
        delete this.callbacks[id];

        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
    });

    const timeoutPromise = new Promise<any>((_, reject) => {
      setTimeout(() => {
        if (!this.callbacks[id]) return;

        this.ids.release(id);
        delete this.callbacks[id];
        reject(
          new CodeError(
            `Command timed out after ${expiresIn}ms.`,
            "ETIMEOUT",
            "TimeoutError"
          )
        );
      }, expiresIn);
    });

    if (typeof callback === "function") {
      Promise.race([responsePromise, timeoutPromise])
        .then((result) => callback(result))
        .catch((error) => callback(null, error));

      return responsePromise;
    }

    return Promise.race([responsePromise, timeoutPromise]);
  }

  close(): boolean {
    if (this.isDead) return false;

    try {
      this.socket?.close();
      return true;
    } catch (e) {
      return false;
    }
  }
}
