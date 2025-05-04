import type { Connection } from "../connection";
import type { Command } from "../../common/message";
import type { ConnectionManager } from "./connection";
import type { RoomManager } from "./room";
import type Redis from "ioredis";

export class BroadcastManager {
  private connectionManager: ConnectionManager;
  private roomManager: RoomManager;
  private instanceId: string;
  private pubClient: Redis;
  private getPubSubChannel: (instanceId: string) => string;
  private emitError: (error: Error) => void;

  constructor(
    connectionManager: ConnectionManager,
    roomManager: RoomManager,
    instanceId: string,
    pubClient: any,
    getPubSubChannel: (instanceId: string) => string,
    emitError: (error: Error) => void,
  ) {
    this.connectionManager = connectionManager;
    this.roomManager = roomManager;
    this.instanceId = instanceId;
    this.pubClient = pubClient;
    this.getPubSubChannel = getPubSubChannel;
    this.emitError = emitError;
  }

  /**
   * Broadcasts a command and payload to a set of connections or all available connections.
   *
   * @param {string} command - The command to be broadcasted.
   * @param {any} payload - The data associated with the command.
   * @param {Connection[]=} connections - (Optional) A specific list of connections to broadcast to. If not provided, the command will be sent to all connections.
   *
   * @throws {Error} Emits an "error" event if broadcasting fails.
   */
  async broadcast(command: string, payload: any, connections?: Connection[]) {
    const cmd: Command = { command, payload };

    try {
      if (connections) {
        const allConnectionIds = connections.map(({ id }) => id);
        const connectionIds = await this.connectionManager.getAllConnectionIds();
        const filteredIds = allConnectionIds.filter((id) => connectionIds.includes(id));
        await this.publishOrSend(filteredIds, cmd);
      } else {
        const allConnectionIds = await this.connectionManager.getAllConnectionIds();
        await this.publishOrSend(allConnectionIds, cmd);
      }
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`));
    }
  }

  /**
   * Broadcasts a command and associated payload to all active connections within the specified room.
   *
   * @param {string} roomName - The name of the room whose connections will receive the broadcast.
   * @param {string} command - The command to be broadcasted to the connections.
   * @param {unknown} payload - The data payload associated with the command.
   * @returns {Promise<void>} A promise that resolves when the broadcast operation is complete.
   * @throws {Error} If the broadcast operation fails, an error is thrown and the promise is rejected.
   */
  async broadcastRoom(roomName: string, command: string, payload: any): Promise<void> {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName);

    try {
      await this.publishOrSend(connectionIds, { command, payload });
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`));
    }
  }

  /**
   * Broadcasts a command and payload to all active connections except for the specified one(s).
   * Excludes the provided connection(s) from receiving the broadcast.
   *
   * @param {string} command - The command to broadcast to connections.
   * @param {any} payload - The payload to send along with the command.
   * @param {Connection | Connection[]} exclude - A single connection or an array of connections to exclude from the broadcast.
   * @returns {Promise<void>} A promise that resolves when the broadcast is complete.
   * @emits {Error} Emits an "error" event if broadcasting the command fails.
   */
  async broadcastExclude(command: string, payload: any, exclude: Connection | Connection[]): Promise<void> {
    const excludedIds = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(({ id }) => id));

    try {
      const connectionIds = (await this.connectionManager.getAllConnectionIds()).filter((id: string) => !excludedIds.has(id));
      await this.publishOrSend(connectionIds, { command, payload });
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`));
    }
  }

  /**
   * Broadcasts a command with a payload to all connections in a specified room,
   * excluding one or more given connections. If the broadcast fails, emits an error event.
   *
   * @param {string} roomName - The name of the room to broadcast to.
   * @param {string} command - The command to broadcast.
   * @param {any} payload - The payload to send with the command.
   * @param {Connection | Connection[]} exclude - A connection or array of connections to exclude from the broadcast.
   * @returns {Promise<void>} A promise that resolves when the broadcast is complete.
   * @emits {Error} Emits an error event if broadcasting fails.
   */
  async broadcastRoomExclude(roomName: string, command: string, payload: any, exclude: Connection | Connection[]): Promise<void> {
    const excludedIds = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(({ id }) => id));

    try {
      const connectionIds = (await this.roomManager.getRoomConnectionIds(roomName)).filter((id: string) => !excludedIds.has(id));
      await this.publishOrSend(connectionIds, { command, payload });
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`));
    }
  }

  private async publishOrSend(connectionIds: string[], command: Command) {
    if (connectionIds.length === 0) {
      return;
    }

    // get instance mapping for the target connection IDs
    const connectionInstanceMapping = await this.connectionManager.getInstanceIdsForConnections(connectionIds);
    const instanceMap: { [instanceId: string]: string[] } = {};

    // group connection IDs by instance ID
    for (const connectionId of connectionIds) {
      const instanceId = connectionInstanceMapping[connectionId];

      if (instanceId) {
        if (!instanceMap[instanceId]) {
          instanceMap[instanceId] = [];
        }

        instanceMap[instanceId].push(connectionId);
      }
    }

    // publish command to each instance
    for (const [instanceId, targetConnectionIds] of Object.entries(instanceMap)) {
      if (targetConnectionIds.length === 0) continue;

      if (instanceId === this.instanceId) {
        // send locally
        targetConnectionIds.forEach((connectionId) => {
          const connection = this.connectionManager.getLocalConnection(connectionId);
          if (connection && !connection.isDead) {
            connection.send(command);
          }
        });
      } else {
        // publish to remote instance via pubsub
        const messagePayload = {
          targetConnectionIds,
          command,
        };
        const message = JSON.stringify(messagePayload);

        try {
          await this.pubClient.publish(this.getPubSubChannel(instanceId), message);
        } catch (err) {
          this.emitError(new Error(`Failed to publish command "${command.command}": ${err}`));
        }
      }
    }
  }
}
