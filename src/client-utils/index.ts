import type { PresenceUpdate } from "../client/client";

type DedupedPresenceGroup = {
  representative: string;
  state: any | null;
  timestamp: number | null;
  members: Set<string>;
};

export interface CreateDedupedPresenceHandlerOptions {
  getGroupId: (connectionId: string) => Promise<string | null>;
  onUpdate: (groups: Map<string, DedupedPresenceGroup>) => void;
}

export function createDedupedPresenceHandler(
  options: CreateDedupedPresenceHandlerOptions
) {
  const { getGroupId, onUpdate } = options;

  const groupMap = new Map<string, DedupedPresenceGroup>();
  const connectionToGroup = new Map<string, string>();

  const processConnection = async (connectionId: string) => {
    let groupId = connectionToGroup.get(connectionId);
    if (!groupId) {
      groupId = (await getGroupId(connectionId)) ?? `conn:${connectionId}`;
      connectionToGroup.set(connectionId, groupId);
    }

    let group = groupMap.get(groupId);
    if (!group) {
      group = {
        representative: connectionId,
        state: null,
        timestamp: null,
        members: new Set(),
      };
      groupMap.set(groupId, group);
    }
    group.members.add(connectionId);

    return { groupId, group };
  };

  const handler = async (update: PresenceUpdate) => {
    const { connectionId, type, timestamp = Date.now() } = update;

    let groupId = connectionToGroup.get(connectionId);
    if (!groupId) {
      groupId = (await getGroupId(connectionId)) ?? `conn:${connectionId}`;
      connectionToGroup.set(connectionId, groupId);
    }

    let group = groupMap.get(groupId);

    if (type === "join") {
      if (!group) {
        group = {
          representative: connectionId,
          state: null,
          timestamp: null,
          members: new Set(),
        };
        groupMap.set(groupId, group);
      }
      group.members.add(connectionId);
    }

    if (type === "leave" && group) {
      group.members.delete(connectionId);
      connectionToGroup.delete(connectionId);

      if (group.members.size === 0) {
        groupMap.delete(groupId);
      } else if (group.representative === connectionId) {
        group.representative = group.members.values().next().value!;
      }
    }

    if (type === "state" && group) {
      const { state } = update;
      if (!group.timestamp || timestamp >= group.timestamp) {
        group.state = state;
        group.timestamp = timestamp;
        group.representative = connectionId;
      }
    }

    onUpdate(groupMap);
  };

  return async (update: any) => {
    if (
      update.type === "join" ||
      update.type === "leave" ||
      update.type === "state"
    ) {
      return handler(update);
    }

    // if we get here, check if it's the result of a subscribePresence call
    // which contains the initial list of present connections
    if (update.success === true && Array.isArray(update.present)) {
      // which connections are still present?
      const stillPresent = new Set(update.present);

      // remove any that are no longer present
      for (const connectionId of connectionToGroup.keys()) {
        if (!stillPresent.has(connectionId)) {
          const groupId = connectionToGroup.get(connectionId);
          if (groupId) {
            const group = groupMap.get(groupId);
            if (group) {
              group.members.delete(connectionId);

              // last member? remove group
              if (group.members.size === 0) {
                groupMap.delete(groupId);
              } else if (group.representative === connectionId) {
                // if this was the representative, assign a new one
                group.representative = group.members.values().next().value!;
              }
            }
          }
          connectionToGroup.delete(connectionId);
        }
      }

      // new connections
      const newConnections = update.present.filter(
        (connectionId: string) => !connectionToGroup.has(connectionId)
      );

      for (const connectionId of newConnections) {
        await processConnection(connectionId);
      }

      onUpdate(groupMap);
    }

    // return the original update so it can be used by the caller
    return update;
  };
}
