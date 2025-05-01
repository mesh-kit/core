import type { MeshClient } from "../client";
import { createDedupedPresenceHandler } from "./index";
import type { Group } from "./index";

/**
 * Creates a unified presence helper that combines deduplication and localStorage sync.
 *
 * @template TState The shape of your presence state.
 * @param {Object} options Configuration options.
 * @param {MeshClient} options.client A MeshClient instance.
 * @param {string} options.room The name of the room to join and publish to.
 * @param {string} options.storageKey A unique key to use for storing presence state in localStorage.
 * @param {(state: TState | null | undefined, connectionId: string) => string | undefined | Promise<string | undefined>} options.stateIdentifier Function that returns a unique identifier from a state object. Receives the state and connection ID.
 * @param {(users: Array<{id: string, state: TState | null, tabCount: number}>) => void} options.onUpdate Called whenever the user list changes.
 * @returns {{
 *   publish(state: TState): Promise<void>,
 *   read(): TState | null,
 *   clear(): Promise<void>,
 *   dispose(): void
 * }} An object with methods to manage presence.
 */
export function createPresence<TState extends Record<string, any>>({
  client,
  room,
  storageKey,
  stateIdentifier,
  onUpdate,
}: {
  client: MeshClient;
  room: string;
  storageKey: string;
  stateIdentifier: (
    state: TState | null | undefined,
    connectionId: string
  ) => string | undefined | Promise<string | undefined>;
  onUpdate: (
    users: Array<{
      id: string;
      state: TState | null;
      tabCount: number;
    }>
  ) => void;
}) {
  const localStorageKey = `m:presence:${storageKey}`;
  let isInitialized = false;
  let reconnectHandler: (() => void) | undefined;
  let disconnectHandler: (() => void) | undefined;

  const stateCache = new Map<string, string | undefined>();
  const connectionStates = new Map<string, TState | null>();

  const getCacheKey = (
    connectionId: string,
    state: TState | null | undefined
  ) => {
    if (!state) return connectionId;
    return `${connectionId}:${JSON.stringify(state)}`;
  };

  const initialize = async () => {
    if (isInitialized) return;
    isInitialized = true;

    await client.joinRoom(room);

    reconnectHandler = async () => {
      if (!isInitialized) return;

      isInitialized = false;

      // wait a brief moment before publishing state
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 300));

      const currentState = read();
      if (currentState) {
        try {
          // publish will call initialize() internally
          await publish(currentState);
        } catch (err) {
          console.error(
            "[createPresence] Failed to publish state during reconnect:",
            err
          );
          // attempt to initialize anyway in case of error
          if (!isInitialized) {
            await initialize();
          }
        }
      } else {
        // if no state is found, we still need to initialize
        await initialize();
      }
    };

    client.onReconnect(reconnectHandler);

    disconnectHandler = () => {
      isInitialized = false;
    };

    client.onDisconnect(disconnectHandler);

    const handler = createDedupedPresenceHandler<TState>({
      getGroupIdFromState: (state) => {
        // find the connectionId for this state
        let targetConnectionId = "";
        for (const [connId, connState] of connectionStates.entries()) {
          if (connState === state) {
            targetConnectionId = connId;
            break;
          }
        }

        if (!targetConnectionId) {
          return state ? `unknown:${Object.values(state)[0]}` : undefined;
        }

        // check cache for resolved identifier
        const cacheKey = getCacheKey(targetConnectionId, state);
        if (stateCache.has(cacheKey)) {
          return stateCache.get(cacheKey);
        }

        const tempId =
          state?.id || state?.userId || `temp:${targetConnectionId}`;

        Promise.resolve().then(async () => {
          try {
            const result = stateIdentifier(state, targetConnectionId);
            const resolvedId =
              result instanceof Promise ? await result : result;

            // cache resolved identifier for future use
            stateCache.set(cacheKey, resolvedId);
          } catch (error) {
            console.error(
              "[createPresence] Error resolving stateIdentifier:",
              error
            );
          }
        });

        return tempId;
      },
      onUpdate: (groups) => {
        const users = Array.from(groups.entries()).map(([id, group]) => ({
          id,
          state: group.state,
          tabCount: group.members.size,
        }));

        handleLocalStorageSync(groups);
        onUpdate(users);
      },
    });

    const wrappedHandler = ((update: {
      type: "join" | "leave" | "state";
      connectionId: string;
      state?: TState | null;
    }) => {
      if (update.type === "state") {
        connectionStates.set(update.connectionId, update.state ?? null);
      } else if (update.type === "leave") {
        connectionStates.delete(update.connectionId);
      }

      handler(update);
    }) as any;

    wrappedHandler.init = (
      present: string[],
      states: Record<string, TState | null | undefined>
    ) => {
      for (const connectionId of present) {
        const state = states?.[connectionId] ?? null;
        connectionStates.set(connectionId, state);
      }

      handler.init(present, states);
    };

    const { present, states } = await client.subscribePresence(
      room,
      wrappedHandler
    );

    wrappedHandler.init(
      present,
      (states as Record<string, TState | null | undefined>) ?? {}
    );

    const initialState = read();
    if (initialState) {
      await publish(initialState);
    }
  };

  const handleLocalStorageSync = (groups: Map<string, Group<TState>>) => {
    const connId = client.connectionId;
    if (!connId) return;

    for (const group of groups.values()) {
      if (group.members.has(connId)) {
        localStorage.setItem(localStorageKey, JSON.stringify(group.state));
        break;
      }
    }
  };

  /**
   * Read the presence state from localStorage.
   *
   * @returns {TState | null} The presence state from localStorage, or null if not found.
   */
  const read = (): TState | null => {
    try {
      return JSON.parse(localStorage.getItem(localStorageKey) ?? "null");
    } catch {
      return null;
    }
  };

  /**
   * Publish the presence state to the server and store it in localStorage.
   *
   * @param state The state to publish.
   * @returns {Promise<void>} A promise that resolves when the state is published.
   */
  const publish = async (state: TState): Promise<void> => {
    if (!isInitialized) {
      await initialize();
    }

    localStorage.setItem(localStorageKey, JSON.stringify(state));
    await client.publishPresenceState(room, { state });
  };

  /**
   * Cleans up resources by removing the reconnect event listener if present and leaving the room.
   *
   * @returns {Promise<void>} A promise that resolves when cleanup is complete.
   * @throws {Error} If an error occurs while leaving the room, the promise will be rejected with the error.
   */
  const dispose = async (): Promise<void> => {
    if (reconnectHandler) {
      client.removeListener("reconnect", reconnectHandler);
      reconnectHandler = undefined;
    }

    if (disconnectHandler) {
      client.removeListener("disconnect", disconnectHandler);
      disconnectHandler = undefined;
    }

    isInitialized = false;
    await client.leaveRoom(room);
  };

  initialize().catch((err) => {
    console.error("[createPresence] Failed to initialize presence:", err);
  });

  return {
    publish,
    read,
    dispose,
  };
}
