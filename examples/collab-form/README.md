## Example: Multiplayer Form

This example demonstrates a collaborative form where multiple users can edit inputs in real time and see each other's presence. It uses:

- **Records** for storing the live value of each input
- **Connection metadata** to store a random color per user
- **Room metadata** to track current input focus ownership across a distributed cluster
- **Channels** to broadcast ephemeral "focus" and "blur" events (i.e. which input is active and by whom)
- **A `get-active-members` command** to let new clients request current room membership and colors

---

### 🧠 Design Overview

- On connect, each client is assigned a random color (stored in metadata)
- Input values are stored as **individual records**
- Focus ownership is tracked in **room metadata** for distributed safety
- When a user focuses or blurs an input, a presence event is sent via **channel**
- Clients use channel events to render focus indicators, and record subscriptions to keep input values in sync
- Clients can request current room membership with a simple command on join

> This example demonstrates both persistent state (input values) and ephemeral presence indicators across users.

---

### 🛠 Server Setup

#### Expose input records for syncing:

```ts
server.exposeWritableRecord(/^form:input:\d+$/);
```

#### Expose channel for presence indicators:

```ts
server.exposeChannel("form:presence");
```

#### Assign random color on connect:

```ts
server.onConnection(async (conn) => {
  const color = getRandomColor(); // e.g. "#e91e63"
  await server.connectionManager.setMetadata(conn, {
    color,
  });

  await server.addToRoom("form:live", conn);
});
```

#### Track and enforce focus ownership using room metadata:

```ts
server.registerCommand("input-focus", async (ctx) => {
  const { inputId } = ctx.payload;
  const current = await server.roomManager.getMetadata("form:live");
  const focused = current?.focused || {};

  const alreadyTaken = focused[inputId];
  if (alreadyTaken && alreadyTaken !== ctx.connection.id) {
    throw new Error("Input is already focused by another user.");
  }

  focused[inputId] = ctx.connection.id;
  await server.roomManager.updateMetadata("form:live", { focused });

  const meta = await server.connectionManager.getMetadata(ctx.connection);
  await server.publishToChannel(
    "form:presence",
    JSON.stringify({
      type: "focus",
      inputId,
      connectionId: ctx.connection.id,
      color: meta?.color,
    })
  );
});

server.registerCommand("input-blur", async (ctx) => {
  const { inputId } = ctx.payload;
  const current = await server.roomManager.getMetadata("form:live");
  const focused = current?.focused || {};

  if (focused[inputId] === ctx.connection.id) {
    delete focused[inputId];
    await server.roomManager.updateMetadata("form:live", { focused });
  }

  await server.publishToChannel(
    "form:presence",
    JSON.stringify({
      type: "blur",
      inputId,
      connectionId: ctx.connection.id,
    })
  );
});

server.onDisconnect(async (conn) => {
  const current = await server.roomManager.getMetadata("form:live");
  const focused = current?.focused || {};
  let updated = false;

  for (const [inputId, owner] of Object.entries(focused)) {
    if (owner === conn.id) {
      delete focused[inputId];
      updated = true;

      await server.publishToChannel(
        "form:presence",
        JSON.stringify({
          type: "blur",
          inputId,
          connectionId: conn.id,
        })
      );
    }
  }

  if (updated) {
    await server.roomManager.updateMetadata("form:live", { focused });
  }
});
```

#### Let clients query who is currently connected:

```ts
server.registerCommand("get-active-members", async (ctx) => {
  const metadataList = await server.connectionManager.getAllMetadataForRoom(
    "form:live"
  );
  return metadataList; // e.g., [ { connId1: { color } }, { connId2: { color } }, ... ]
});
```

---

### 💻 Client Setup

#### Subscribe to each input record (e.g. two inputs):

```ts
for (const id of ["form:input:1", "form:input:2"]) {
  await client.subscribeRecord(id, (update) => {
    if (update.full) updateInputValue(id, update.full.value);
  });
}
```

#### Publish value updates when user types:

```ts
client.publishRecordUpdate("form:input:1", { value: "new value" });
```

#### Subscribe to presence channel:

```ts
await client.subscribe("form:presence", (msg) => {
  const data = JSON.parse(msg);

  if (data.type === "focus") {
    showFocusIndicator(data.inputId, data.connectionId, data.color);
  } else if (data.type === "blur") {
    removeFocusIndicator(data.inputId, data.connectionId);
  }
});
```

#### Send focus and blur commands:

```ts
inputElement.addEventListener("focus", () => {
  client.command("input-focus", { inputId: "form:input:1" });
});

inputElement.addEventListener("blur", () => {
  client.command("input-blur", { inputId: "form:input:1" });
});
```

#### Request active connections on join:

```ts
const activeMembers = await client.command("get-active-members", {});
activeMembers.forEach((entry) => {
  const [connectionId, meta] = Object.entries(entry)[0];
  showInitialPresence(connectionId, meta.color);
});
```

---

### 📌 Summary

| Feature                 | Mesh Construct                      |
| ----------------------- | ----------------------------------- |
| Live input value        | Writable Record                     |
| Focus ownership         | Room Metadata (distributed-safe)    |
| Focus & blur presence   | Pub/Sub Channel                     |
| Connection color        | Connection Metadata                 |
| Rehydration             | Record subscription                 |
| Initial member presence | `getAllMetadataForRoom` via command |
| Real-time UI updates    | Channel + Record combo              |

This example shows how to combine persistent sync with live collaborative presence, and how to support distributed setups with room metadata and commands.
