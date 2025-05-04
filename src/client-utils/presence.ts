import type { MeshClient } from "../client";
import { createDedupedPresenceHandler } from "./index";
import type { Group } from "./index";
import { clientLogger } from "../common/logger";

/**
 * Creates a unified presence helper that combines deduplication and localStorage sync.
 *
 * @template TState The shape of your presence state.
 * @param {Object} options Configuration options.
 * @param {MeshClient} options.client A MeshClient instance.
 * @param {string} options.room The name of the room to join and publish to.
 * @param {string} options.storageKey A unique key to use for storing presence state in localStorage.
 * @param {(state: TState | null | undefined, connectionId: string) => string | undefined | Promise<string | undefined>} options.stateIdentifier Function that returns a unique identifier from a state object. Receives the state and connection ID.
 * @param {(state: TState | null | undefined) => boolean} options.me Function that returns true if the state belongs to the current user.
 * @param {(users: Array<{id: string, state: TState | null, tabCount: number}>) => void} options.onUpdate Called whenever the user list changes.
 * @returns {{
 *   publish(state: TState): Promise<void>,
 *   read(): TState | null,
 *   clear(): Promise<void>,
 *   dispose(): void
 * }}
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
  stateIdentifier: (state: TState | null | undefined, connectionId: string) => string | undefined | Promise<string | undefined>;
  onUpdate: (
    users: Array<{
      id: string;
      state: TState | null;
      tabCount: number;
    }>,
  ) => void;
}) {
  const storage = createStorageManager<TState>(storageKey);
  const stateManager = createStateManager<TState>();
  const resolver = createStateResolver<TState>(stateIdentifier);

  let isInitialized = false;
  let reconnectHandler: (() => void) | undefined;
  let disconnectHandler: (() => void) | undefined;

  client.on("republish", async () => {
    const state = storage.read();
    if (!state) return;
    for (const room of client.joinedRooms.keys()) {
      await client.publishPresenceState(room, { state });
    }
  });

  const initialize = async (): Promise<void> => {
    if (isInitialized) return;
    isInitialized = true;

    await client.joinRoom(room);
    setupEventHandlers();
    await setupPresenceHandler();
  };

  const setupEventHandlers = (): void => {
    reconnectHandler = createReconnectHandler();
    disconnectHandler = () => {
      isInitialized = false;
      stateManager.clearAllConnectionStates();
      resolver.clearCache();
    };

    client.onReconnect(reconnectHandler);
    client.onDisconnect(disconnectHandler);
  };

  const createReconnectHandler = (): (() => Promise<void>) => async () => {
    if (!isInitialized) return;
    isInitialized = false;

    // clear state to prevent stale data
    stateManager.clearAllConnectionStates();
    resolver.clearCache();

    // jitter to prevent thundering herd
    await delay(Math.random() * 300);

    const currentState = storage.read();

    try {
      if (currentState) {
        await publish(currentState);
      } else {
        await initialize();
      }

      // force a presence update to get the latest state from the server
      try {
        await client.forcePresenceUpdate(room);
      } catch (updateErr) {
        clientLogger.error("Failed to force presence update during reconnect:", updateErr);
      }
    } catch (err) {
      clientLogger.error("Failed to publish state during reconnect:", err);
      if (!isInitialized) {
        await initialize();
      }
    }
  };

  const setupPresenceHandler = async (): Promise<void> => {
    const handler = createDedupedPresenceHandler<TState>({
      getGroupIdFromState: (state) => resolver.resolveId(state, stateManager),
      onUpdate: (groups, connectionId) => {
        // If we have a valid connectionId, and this update wasn't triggered by us
        // then one of our other connections has done something that we should sync up with.

        if (client.connectionId && connectionId !== client.connectionId) {
          // find which group the current connection belongs to
          let myGroupId: string | undefined;
          for (const [groupId, group] of groups.entries()) {
            if (group.members.has(client.connectionId)) {
              myGroupId = groupId;
              break;
            }
          }

          // find which group the triggering connection belongs to
          let triggerGroupId: string | undefined;
          for (const [groupId, group] of groups.entries()) {
            if (group.members.has(connectionId)) {
              triggerGroupId = groupId;
              break;
            }
          }

          // only sync if both connections belong to the same group (same user)
          if (myGroupId && triggerGroupId && myGroupId === triggerGroupId) {
            const myGroup = groups.get(myGroupId);
            if (myGroup?.state) {
              // prevent thundering herd
              delay(Math.random() * 300).then(() => {
                client.publishPresenceState(room, {
                  state: myGroup.state!,
                  silent: true,
                });
                storage.write(myGroup.state!);
              });
            }
          }
        }

        const users = formatUsers(groups);
        onUpdate(users);
      },
    });

    const wrappedHandler = createWrappedHandler(handler);

    const { present, states } = await client.subscribePresence(room, wrappedHandler);

    wrappedHandler.init(present, (states as Record<string, TState | null | undefined>) ?? {});

    const initialState = storage.read();
    if (initialState) {
      await publish(initialState);
    }
  };

  // wrapped handler that tracks connection states
  const createWrappedHandler = (handler: any) => {
    const wrappedHandler = ((update: { type: "join" | "leave" | "state"; connectionId: string; state?: TState | null }) => {
      if (update.type === "state") {
        stateManager.setConnectionState(update.connectionId, update.state ?? null);
      } else if (update.type === "leave") {
        stateManager.removeConnectionState(update.connectionId);
      }

      handler(update);
    }) as any;

    wrappedHandler.init = (present: string[], states: Record<string, TState | null | undefined>) => {
      for (const connectionId of present) {
        const state = states?.[connectionId] ?? null;
        stateManager.setConnectionState(connectionId, state);
      }

      handler.init(present, states);
    };

    return wrappedHandler;
  };

  // format users from groups for the onUpdate callback
  const formatUsers = (groups: Map<string, Group<TState>>) =>
    Array.from(groups.entries())
      .filter(([id]) => !id.startsWith("__ungrouped__") && !id.startsWith("__pending__") && !id.startsWith("__temp__"))
      .map(([id, group]) => ({
        id,
        state: group.state,
        tabCount: group.members.size,
      }));

  // publish state to server and localStorage
  const publish = async (state: TState): Promise<void> => {
    if (!isInitialized) {
      await initialize();
    }

    clientLogger.info("publish > ", state);
    storage.write(state);
    await client.publishPresenceState(room, { state });
  };

  // clean up resources
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
    clientLogger.error("Failed to initialize presence:", err);
  });

  // clear all connection states, resolver cache, and trigger onUpdate
  const clearConnectionStates = (): void => {
    stateManager.clearAllConnectionStates();
    resolver.clearCache();
    onUpdate([]);
  };

  return {
    publish,
    read: storage.read,
    clearConnectionStates,
    dispose,
  };
}

function createStorageManager<TState>(storageKey: string) {
  const localStorageKey = `m:presence:${storageKey}`;

  return {
    read: (): TState | null => {
      try {
        return JSON.parse(localStorage.getItem(localStorageKey) ?? "null");
      } catch {
        return null;
      }
    },

    write: (state: TState | null): void => {
      if (state === null) {
        localStorage.removeItem(localStorageKey);
      } else {
        localStorage.setItem(localStorageKey, JSON.stringify(state));
      }
    },
  };
}

function createStateManager<TState>() {
  const connectionStates = new Map<string, TState | null>();

  return {
    getConnectionStates: () => new Map(connectionStates),

    setConnectionState: (connectionId: string, state: TState | null) => {
      connectionStates.set(connectionId, state);
    },

    removeConnectionState: (connectionId: string) => {
      connectionStates.delete(connectionId);
    },

    clearAllConnectionStates: () => {
      connectionStates.clear();
    },

    findConnectionIdForState: (state: TState | null | undefined): string => {
      if (!state) return "";

      for (const [connId, connState] of connectionStates.entries()) {
        if (connState === state) {
          return connId;
        }
      }

      return "";
    },
  };
}

function createStateResolver<TState>(
  stateIdentifier: (state: TState | null | undefined, connectionId: string) => string | undefined | Promise<string | undefined>,
) {
  const stateCache = new Map<string, string | undefined>();

  const getCacheKey = (connectionId: string, state: TState | null | undefined): string => {
    if (!state) return connectionId;
    return `${connectionId}:${JSON.stringify(state)}`;
  };

  const resolveAsync = async (state: TState | null | undefined, connectionId: string): Promise<void> => {
    try {
      const result = stateIdentifier(state, connectionId);
      const resolvedId = result instanceof Promise ? await result : result;

      const cacheKey = getCacheKey(connectionId, state);
      stateCache.set(cacheKey, resolvedId);
    } catch (error) {
      clientLogger.error("Error resolving stateIdentifier:", error);
    }
  };

  return {
    resolveId: (state: TState | null | undefined, stateManager: ReturnType<typeof createStateManager<TState>>): string | undefined => {
      // if state is null or undefined, we can't group it except by connection ID
      if (!state) {
        return undefined; // result is __ungrouped__:connectionId
      }

      const connectionId = stateManager.findConnectionIdForState(state);
      if (!connectionId) {
        // if we can't find a connection ID, use a value from the state
        return `unknown:${Object.values(state)[0]}`;
      }

      // do we have a cached identifier for this state
      const cacheKey = getCacheKey(connectionId, state);
      if (stateCache.has(cacheKey)) {
        const cachedId = stateCache.get(cacheKey);
        if (cachedId) {
          return cachedId;
        }
      }

      // always try to resolve using the stateIdentifier function first
      Promise.resolve().then(() => resolveAsync(state, connectionId));

      // as a fallback, use common properties if available
      const id = (state as any)?.id;
      const userId = (state as any)?.userId;

      if (typeof id === "string" && id) {
        return id;
      }

      if (typeof userId === "string" && userId) {
        return userId;
      }

      // if we can't determine a group ID from the state, use the connection ID
      return `__temp__:${connectionId}`;
    },

    clearCache: () => {
      stateCache.clear();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
