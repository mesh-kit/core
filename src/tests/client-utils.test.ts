import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDedupedPresenceHandler,
  type Group,
  createPresence,
} from "../client-utils";

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

describe("createPresence (unified API)", () => {
  const localStorageMock = {
    store: {} as Record<string, string>,
    getItem: vi.fn((key: string) => localStorageMock.store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      localStorageMock.store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete localStorageMock.store[key];
    }),
    clear: vi.fn(() => {
      localStorageMock.store = {};
    }),
  };

  const mockClient = {
    connectionId: "conn123",
    joinRoom: vi.fn().mockResolvedValue({ success: true }),
    subscribePresence: vi.fn().mockResolvedValue({
      success: true,
      present: ["conn123"],
      states: {},
    }),
    publishPresenceState: vi.fn().mockResolvedValue(true),
    clearPresenceState: vi.fn().mockResolvedValue(true),
    onReconnect: vi.fn(),
    onDisconnect: vi.fn(),
    removeListener: vi.fn(),
    on: vi.fn(),
    leaveRoom: vi.fn().mockResolvedValue({ success: true }),
    joinedRooms: new Map([["test-room", true]]),
  };

  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = global.localStorage;
    global.localStorage = localStorageMock as unknown as Storage;
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  afterEach(() => {
    global.localStorage = originalLocalStorage;
  });

  test("initializes and returns expected API", async () => {
    const onUpdate = vi.fn();

    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: (state, connectionId) => state?.userId,
      onUpdate,
    });

    expect(presence).toHaveProperty("publish");
    expect(presence).toHaveProperty("read");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockClient.joinRoom).toHaveBeenCalledWith("test-room");
    expect(mockClient.subscribePresence).toHaveBeenCalled();
  });

  test("reads state from localStorage", async () => {
    const initialState = { userId: "user1", status: "online" };
    localStorageMock.setItem(
      "m:presence:test-key",
      JSON.stringify(initialState)
    );

    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: (state, connectionId) => state?.userId,
      onUpdate: vi.fn(),
    });

    const state = presence.read();
    expect(state).toEqual(initialState);
  });

  test("publishes state to server and localStorage", async () => {
    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: (state, connectionId) => state?.userId,
      onUpdate: vi.fn(),
    });

    const newState = { userId: "user1", status: "typing" };
    await presence.publish(newState);

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "m:presence:test-key",
      JSON.stringify(newState)
    );

    expect(mockClient.publishPresenceState).toHaveBeenCalledWith("test-room", {
      state: newState,
    });
  });

  test("calls onUpdate with formatted user list", async () => {
    const onUpdate = vi.fn();

    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: (state, connectionId) => state?.userId,
      onUpdate,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const groups = new Map<string, Group<State>>();
    groups.set("user1", {
      members: new Set(["conn123"]),
      state: { userId: "user1", status: "online" },
    });

    const expectedUsers = [
      {
        id: "user1",
        state: { userId: "user1", status: "online" },
        tabCount: 1,
      },
    ];

    onUpdate(expectedUsers);

    expect(onUpdate).toHaveBeenCalledWith(expectedUsers);
  });

  test("supports async stateIdentifier function", async () => {
    const onUpdate = vi.fn();

    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: async (state, connectionId) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return state?.userId;
      },
      onUpdate,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const newState = { userId: "user1", status: "typing" };
    await presence.publish(newState);

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "m:presence:test-key",
      JSON.stringify(newState)
    );

    expect(mockClient.publishPresenceState).toHaveBeenCalledWith("test-room", {
      state: newState,
    });
  });

  test("passes the correct connectionId to stateIdentifier", async () => {
    const stateIdentifierSpy = vi.fn().mockReturnValue("user1");

    const presence = createPresence<State>({
      client: mockClient as any,
      room: "test-room",
      storageKey: "test-key",
      stateIdentifier: stateIdentifierSpy,
      onUpdate: vi.fn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockClient.subscribePresence).toHaveBeenCalled();
    const handler = mockClient.subscribePresence.mock.calls[0]?.[1];

    expect(handler).toBeDefined();

    const testConnectionId = "test-connection-123";
    const testState = { userId: "user1", status: "online" };

    handler({
      type: "state",
      connectionId: testConnectionId,
      state: testState,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stateIdentifierSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user1" }),
      testConnectionId
    );
  });
});
