import { CodeError } from "../../client";
import { MeshContext } from "../mesh-context";
import type { Connection } from "../connection";
import type { SocketMiddleware } from "../types";

export class CommandManager {
  private commands: {
    [command: string]: (context: MeshContext<any>) => Promise<any> | any;
  } = {};
  private globalMiddlewares: SocketMiddleware[] = [];
  private middlewares: { [key: string]: SocketMiddleware[] } = {};
  private emitError: (error: Error) => void;

  constructor(emitError: (error: Error) => void) {
    this.emitError = emitError;
  }

  /**
   * Registers a command with an associated callback and optional middleware.
   *
   * @template T The type for `MeshContext.payload`. Defaults to `any`.
   * @template U The command's return value type. Defaults to `any`.
   * @param {string} command - The unique identifier for the command to register.
   * @param {(context: MeshContext<T>) => Promise<U> | U} callback - The function to execute when the command is invoked. It receives a `MeshContext` of type `T` and may return a value of type `U` or a `Promise` resolving to `U`.
   * @param {SocketMiddleware[]} [middlewares=[]] - An optional array of middleware functions to apply to the command. Defaults to an empty array.
   * @throws {Error} May throw an error if the command registration or middleware addition fails.
   */
  exposeCommand<T = any, U = any>(command: string, callback: (context: MeshContext<T>) => Promise<U> | U, middlewares: SocketMiddleware[] = []) {
    this.commands[command] = callback;

    if (middlewares.length > 0) {
      this.useMiddlewareWithCommand(command, middlewares);
    }
  }

  /**
   * Adds one or more middleware functions to the global middleware stack.
   *
   * @param {SocketMiddleware[]} middlewares - An array of middleware functions to be added. Each middleware
   *                                           is expected to conform to the `SocketMiddleware` type.
   * @returns {void}
   * @throws {Error} If the provided middlewares are not valid or fail validation (if applicable).
   */
  useMiddleware(...middlewares: SocketMiddleware[]): void {
    this.globalMiddlewares.push(...middlewares);
  }

  /**
   * Adds an array of middleware functions to a specific command.
   *
   * @param {string} command - The name of the command to associate the middleware with.
   * @param {SocketMiddleware[]} middlewares - An array of middleware functions to be added to the command.
   * @returns {void}
   */
  useMiddlewareWithCommand(command: string, middlewares: SocketMiddleware[]): void {
    if (middlewares.length) {
      this.middlewares[command] = this.middlewares[command] || [];
      this.middlewares[command] = middlewares.concat(this.middlewares[command]);
    }
  }

  /**
   * Runs a command with the given parameters
   *
   * @param id - The command ID
   * @param commandName - The name of the command to run
   * @param payload - The payload for the command
   * @param connection - The connection that initiated the command
   * @param server - The server instance
   */
  async runCommand(id: number, commandName: string, payload: any, connection: Connection, server: any) {
    const context = new MeshContext(server, commandName, connection, payload);

    try {
      if (!this.commands[commandName]) {
        throw new CodeError(`Command "${commandName}" not found`, "ENOTFOUND", "CommandError");
      }

      if (this.globalMiddlewares.length) {
        for (const middleware of this.globalMiddlewares) {
          await middleware(context);
        }
      }

      if (this.middlewares[commandName]) {
        for (const middleware of this.middlewares[commandName]) {
          await middleware(context);
        }
      }

      const result = await this.commands[commandName](context);
      connection.send({ id, command: commandName, payload: result });
    } catch (err) {
      const errorPayload =
        err instanceof Error
          ? {
              error: err.message,
              code: (err as CodeError).code || "ESERVER",
              name: err.name || "Error",
            }
          : { error: String(err), code: "EUNKNOWN", name: "UnknownError" };

      connection.send({ id, command: commandName, payload: errorPayload });
    }
  }

  /**
   * Gets all registered commands
   *
   * @returns An object mapping command names to their handler functions
   */
  getCommands(): {
    [command: string]: (context: MeshContext<any>) => Promise<any> | any;
  } {
    return this.commands;
  }

  /**
   * Checks if a command is registered
   *
   * @param commandName - The name of the command to check
   * @returns true if the command is registered, false otherwise
   */
  hasCommand(commandName: string): boolean {
    return !!this.commands[commandName];
  }
}
