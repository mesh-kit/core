## Example: LLM Streaming Chat

This example demonstrates how to stream LLM completions to the client in real time using Mesh. It combines:

- A **record** to persist structured chat history (used for rehydration)
- A **channel** to stream token chunks live as the LLM responds (used to drive real-time UI)

---

### 🧠 Design Overview

- Clients send a prompt to the server using a `generate-reply` command.
- The server:
  - Streams chunks over a pub/sub channel (`stream:chat:conv:<id>`)
  - Appends both the user prompt and assistant reply to a record (`chat:conv:<id>`)
- Clients:
  - Subscribe to the **record** for initial state
  - Subscribe to the **channel** for streaming output

> **Note:** The record is only updated once the reply is finalized. Clients should use the record to rehydrate state (e.g. after reload), and the channel to render token-by-token streaming in real time.

---

### 🛠 Server Setup

#### Expose the record and channel:

```ts
server.exposeRecord(/^chat:conv:\w+$/, async (conn, recordId) => {
  const meta = await server.connectionManager.getMetadata(conn);
  return recordId === `chat:conv:${meta?.userId}`;
});

server.exposeChannel(/^stream:chat:conv:\w+$/, async (conn, channelId) => {
  const meta = await server.connectionManager.getMetadata(conn);
  return channelId === `stream:chat:conv:${meta?.userId}`;
});
```

#### Register the generation command:

```ts
server.registerCommand("generate-reply", async (ctx) => {
  const { prompt } = ctx.payload;
  const meta = await ctx.server.connectionManager.getMetadata(ctx.connection);
  const userId = meta?.userId;
  const recordId = `chat:conv:${userId}`;
  const channelId = `stream:chat:conv:${userId}`;
  const chunks: string[] = [];

  const generator = yourLLM.stream({ prompt });

  for await (const token of generator) {
    chunks.push(token);
    await ctx.server.publishToChannel(
      channelId,
      JSON.stringify({ type: "chunk", content: token })
    );
  }

  const record = await ctx.server.getRecord(recordId);
  const updated = {
    ...record,
    messages: [
      ...(record.messages || []),
      { role: "user", content: prompt },
      { role: "assistant", content: chunks.join("") },
    ],
  };

  await ctx.server.publishRecordUpdate(recordId, updated);
});
```

---

### 💻 Client Setup

#### Subscribe to the record for initial load:

```ts
await client.subscribeRecord("chat:conv:123", (update) => {
  if (update.full) {
    renderAll(update.full.messages); // rehydration
  }
});
```

#### Subscribe to the stream channel for real-time tokens:

```ts
await client.subscribe("stream:chat:conv:123", (msg) => {
  const { type, content } = JSON.parse(msg);
  if (type === "chunk") {
    renderChunk(content); // append to in-progress message
  }
});
```

#### Send a prompt to the server:

```ts
await client.command("generate-reply", {
  prompt: "How does gravity work?",
});
```

---

### 📌 Summary

| Component   | Purpose                                            |
| ----------- | -------------------------------------------------- |
| **Record**  | Stores finalized chat messages for rehydration     |
| **Channel** | Streams token chunks in real time for UI rendering |
| **Command** | Triggers LLM generation server-side                |

This pattern separates **persistence** from **streaming**, keeping the UX fast and the data model clean.
