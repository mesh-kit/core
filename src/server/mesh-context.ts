import type { Connection } from "./connection";
import type { MeshServer } from "./mesh-server";

export class MeshContext<T = any> {
  server: MeshServer;
  command: string;
  connection: Connection;
  payload: T;

  constructor(server: MeshServer, command: string, connection: Connection, payload: T) {
    this.server = server;
    this.command = command;
    this.connection = connection;
    this.payload = payload;
  }
}
