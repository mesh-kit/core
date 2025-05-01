export interface Group<TState> {
  members: Set<string>;
  state: TState | null;
}

/**
 * Creates a deduplicated presence handler that groups connections by a logical identifier
 * (e.g. user ID, session ID, device ID). Useful for collapsing multiple tabs or devices
 * into a single presence entry in your app's UI.
 *
 * @template TState The shape of your presence state.
 * @param {Object} options - Configuration options for the deduplicated presence handler.
 * @param {(state: TState) => string | undefined} options.getGroupIdFromState - A function that returns the group ID for a given state.
 * @param {(groups: Map<string, { state: TState, members: Set<string> }>) => void} options.onUpdate - Called whenever the deduplicated group list changes.
 * @returns {Object} A presence update handler with an `.init()` method to hydrate initial state.
 *
 * @example
 * const handler = createDedupedPresenceHandler({
 *   getGroupIdFromState: (state) => state?.userId,
 *   onUpdate: (groups) => {
 *     // Use groups Map<string, { state, members }>
 *   },
 * });
 *
 * await client.subscribePresence("room:chat", handler);
 * handler.init(present, states);
 */
export function createDedupedPresenceHandler<TState>(config: {
  getGroupIdFromState: (state: TState | null | undefined) => string | undefined;
  onUpdate: (groups: Map<string, Group<TState>>) => void;
}) {
  const groups = new Map<string, Group<TState>>();
  const memberToGroup = new Map<string, string>();

  const update = () => config.onUpdate(new Map(groups));

  function join(connectionId: string) {
    const groupId = `__pending__:${connectionId}`;
    const group = groups.get(groupId) ?? {
      members: new Set(),
      state: null,
    };
    group.members.add(connectionId);
    groups.set(groupId, group);
    memberToGroup.set(connectionId, groupId);
    update();
  }

  function leave(connectionId: string) {
    const groupId = memberToGroup.get(connectionId);
    if (!groupId) return;

    const group = groups.get(groupId);
    group?.members.delete(connectionId);
    memberToGroup.delete(connectionId);

    if (group && group.members.size === 0) {
      groups.delete(groupId);
    }

    update();
  }

  function updateState(connectionId: string, state: TState | null) {
    const newGroupId =
      config.getGroupIdFromState(state) ?? `__ungrouped__:${connectionId}`;
    const oldGroupId = memberToGroup.get(connectionId);

    if (oldGroupId === newGroupId) {
      const group = groups.get(newGroupId);
      if (group) {
        group.state = state;
        update();
      }
      return;
    }

    if (oldGroupId) {
      const oldGroup = groups.get(oldGroupId);
      oldGroup?.members.delete(connectionId);
      if (oldGroup && oldGroup.members.size === 0) {
        groups.delete(oldGroupId);
      }
    }

    const newGroup = groups.get(newGroupId) ?? {
      members: new Set(),
      state,
    };
    newGroup.members.add(connectionId);
    newGroup.state = state;
    groups.set(newGroupId, newGroup);
    memberToGroup.set(connectionId, newGroupId);

    update();
  }

  type Update =
    | { type: "join"; connectionId: string }
    | { type: "leave"; connectionId: string }
    | { type: "state"; connectionId: string; state?: TState | null };

  type Handler = ((update: Update) => void) & {
    init: (
      present: string[],
      states: Record<string, TState | null | undefined>
    ) => void;
  };

  const handler: Handler = ((update: Update) => {
    if (update.type === "join") join(update.connectionId);
    else if (update.type === "leave") leave(update.connectionId);
    else if (update.type === "state")
      updateState(update.connectionId, update.state ?? null);
  }) as Handler;

  handler.init = (present, states) => {
    for (const connectionId of present) {
      join(connectionId);
      const stateValue = states?.[connectionId] ?? null;
      updateState(connectionId, stateValue);
    }
  };

  return handler;
}

export { createPresence } from "./presence";
