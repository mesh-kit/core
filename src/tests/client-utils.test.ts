import { describe, test, expect, vi } from "vitest";
import { createDedupedPresenceHandler } from "../client-utils";
import type { PresenceUpdate } from "../client/client";

describe("createDedupedPresenceHandler", () => {
  test("adds a new group when a connection joins and is resolved to a new groupId", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(
        async (connectionId) => `group:${connectionId.substring(0, 3)}`
      );

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    const update: PresenceUpdate = {
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    };

    await handler(update);

    expect(getGroupId).toHaveBeenCalledWith("conn123");
    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    expect(groupMap.size).toBe(1);
    expect(groupMap.has("group:con")).toBe(true);

    const group = groupMap.get("group:con");
    expect(group.representative).toBe("conn123");
    expect(group.members.size).toBe(1);
    expect(group.members.has("conn123")).toBe(true);
  });

  test("adds the connection to an existing group if another connection already resolved to the same groupId", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:same");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // first connection joins
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    onUpdate.mockClear();

    // second connection joins with same group ID
    await handler({
      type: "join",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1001,
    });

    expect(getGroupId).toHaveBeenCalledWith("conn456");
    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    expect(groupMap.size).toBe(1);

    const group = groupMap.get("group:same");
    // first connection remains the representative
    expect(group.representative).toBe("conn123");
    expect(group.members.size).toBe(2);
    expect(group.members.has("conn123")).toBe(true);
    expect(group.members.has("conn456")).toBe(true);
  });

  test("removes the group when the last connection in that group leaves", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:test");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // connection joins
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    onUpdate.mockClear();

    // connection leaves
    await handler({
      type: "leave",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1001,
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    // group should be removed
    expect(groupMap.size).toBe(0);
  });

  test("promotes a new representative when the current representative leaves", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:test");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // first connection joins (becomes representative)
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    // second connection joins
    await handler({
      type: "join",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1001,
    });

    onUpdate.mockClear();

    // representative leaves
    await handler({
      type: "leave",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1002,
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    expect(groupMap.size).toBe(1);

    const group = groupMap.get("group:test");
    // second connection should be promoted
    expect(group.representative).toBe("conn456");
    expect(group.members.size).toBe(1);
    expect(group.members.has("conn456")).toBe(true);
  });

  test("updates state when a state update is received", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:test");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // connection joins
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    onUpdate.mockClear();

    // connection updates state
    await handler({
      type: "state",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1001,
      state: { status: "typing" },
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    const group = groupMap.get("group:test");
    expect(group.state).toEqual({ status: "typing" });
    expect(group.timestamp).toBe(1001);
  });

  test("only updates state if timestamp is newer", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:test");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // two connections join the same group
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    await handler({
      type: "join",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1001,
    });

    // first connection sets state
    await handler({
      type: "state",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1002,
      state: { status: "typing" },
    });

    onUpdate.mockClear();

    // second connection tries to set state with older timestamp
    await handler({
      type: "state",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1001,
      state: { status: "idle" },
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    const group = groupMap.get("group:test");
    // should keep the first state
    expect(group.state).toEqual({ status: "typing" });
    expect(group.timestamp).toBe(1002);
    // representative should not change
    expect(group.representative).toBe("conn123");
  });

  test("changes representative when state is updated with newer timestamp", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(async (connectionId) => "group:test");

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    // two connections join the same group
    await handler({
      type: "join",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1000,
    });

    await handler({
      type: "join",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1001,
    });

    // first connection sets state
    await handler({
      type: "state",
      connectionId: "conn123",
      roomName: "test-room",
      timestamp: 1002,
      state: { status: "typing" },
    });

    onUpdate.mockClear();

    // second connection sets state with newer timestamp
    await handler({
      type: "state",
      connectionId: "conn456",
      roomName: "test-room",
      timestamp: 1003,
      state: { status: "idle" },
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(onUpdate).toHaveBeenCalled();
    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    const group = groupMap.get("group:test");
    // should update to new state
    expect(group.state).toEqual({ status: "idle" });
    expect(group.timestamp).toBe(1003);
    // representative should change
    expect(group.representative).toBe("conn456");
  });

  test("automatically processes initial presence list from subscribePresence result", async () => {
    const getGroupId = vi
      .fn()
      .mockImplementation(
        async (connectionId) => `group:${connectionId.substring(0, 3)}`
      );

    const onUpdate = vi.fn();

    const handler = createDedupedPresenceHandler({
      getGroupId,
      onUpdate,
    });

    const subscribeResult = {
      success: true,
      present: ["conn123", "conn456", "conn789"],
    };

    await handler(subscribeResult as any);

    expect(getGroupId).toHaveBeenCalledTimes(3);
    expect(getGroupId).toHaveBeenCalledWith("conn123");
    expect(getGroupId).toHaveBeenCalledWith("conn456");
    expect(getGroupId).toHaveBeenCalledWith("conn789");

    expect(onUpdate).toHaveBeenCalledTimes(1);

    const groupMap = onUpdate.mock.calls![0]![0] as Map<string, any>;
    expect(groupMap.size).toBe(1);
    expect(groupMap.has("group:con")).toBe(true);

    const group = groupMap.get("group:con");
    expect(group.members.size).toBe(3);
    expect(group.members.has("conn123")).toBe(true);
    expect(group.members.has("conn456")).toBe(true);
    expect(group.members.has("conn789")).toBe(true);
  });
});
