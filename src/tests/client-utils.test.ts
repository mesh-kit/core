import { describe, test, expect, vi } from "vitest";
import { createDedupedPresenceHandler, type Group } from "../client-utils";

type State = { userId: string; status?: string };

describe("createDedupedPresenceHandler (state-based)", () => {
  test("adds a new group when a connection joins and state is resolved", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "conn123" });
    handler({
      type: "state",
      connectionId: "conn123",
      state: { userId: "user1" },
    });

    expect(onUpdate).toHaveBeenCalledTimes(2);

    const groupMap = onUpdate.mock.calls[1]![0] as Map<string, Group<State>>;
    expect(groupMap.size).toBe(1);
    expect(groupMap.has("user1")).toBe(true);

    const group = groupMap.get("user1")!;
    expect(group.members.has("conn123")).toBe(true);
    expect(group.state).toEqual({ userId: "user1" });
  });

  test("adds multiple members to the same group", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "conn123" });
    handler({
      type: "state",
      connectionId: "conn123",
      state: { userId: "user1" },
    });

    handler({ type: "join", connectionId: "conn456" });
    handler({
      type: "state",
      connectionId: "conn456",
      state: { userId: "user1" },
    });

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.get("user1")!.members.size).toBe(2);
  });

  test("removes the group when the last connection leaves", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "conn123" });
    handler({
      type: "state",
      connectionId: "conn123",
      state: { userId: "user1" },
    });
    handler({ type: "leave", connectionId: "conn123" });

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.size).toBe(0);
  });

  test("moves a connection to a different group if its state changes", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "conn123" });
    handler({
      type: "state",
      connectionId: "conn123",
      state: { userId: "user1" },
    });
    handler({
      type: "state",
      connectionId: "conn123",
      state: { userId: "user2" },
    });

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.has("user1")).toBe(false);
    expect(groupMap.has("user2")).toBe(true);
  });

  test("init loads present users and assigns state", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler.init(["conn123", "conn456"], {
      conn123: { userId: "user1" },
      conn456: { userId: "user1" },
    });

    expect(onUpdate).toHaveBeenCalledTimes(4);

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.size).toBe(1);
    expect(groupMap.get("user1")!.members.size).toBe(2);
  });

  test("handles null state gracefully", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "conn123" });
    handler({ type: "state", connectionId: "conn123", state: null });

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.size).toBe(1);

    const [groupId] = groupMap.keys();
    expect(groupId!.startsWith("__ungrouped__")).toBe(true);
  });

  test("handles multiple groups cleanly", () => {
    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler<State>({
      getGroupIdFromState: (state) => state?.userId,
      onUpdate,
    });

    handler({ type: "join", connectionId: "a" });
    handler({ type: "state", connectionId: "a", state: { userId: "user:a" } });

    handler({ type: "join", connectionId: "b" });
    handler({ type: "state", connectionId: "b", state: { userId: "user:b" } });

    const groupMap = onUpdate.mock.calls.at(-1)![0] as Map<
      string,
      Group<State>
    >;
    expect(groupMap.size).toBe(2);
    expect(groupMap.get("user:a")!.members.has("a")).toBe(true);
    expect(groupMap.get("user:b")!.members.has("b")).toBe(true);
  });
});
