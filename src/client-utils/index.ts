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

  return async (update: PresenceUpdate) => {
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
}
