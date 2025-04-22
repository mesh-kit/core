## Deduplicated Presence

Sometimes, a single user may have multiple connections (tabs, devices) in a room. By default, `subscribePresence(...)` emits events for each connection individually — so a single user might appear multiple times.

The `createDedupedPresenceHandler` utility helps you group those events into a single presence entry per logical entity — such as a user — using whatever logic you define.

This is useful for:

- Showing a clean “who’s online” list
- Displaying a single “typing...” indicator per user
- Tracking presence by user, session, device, or any custom identifier

### Usage

```ts
import { createDedupedPresenceHandler } from "@prsm/mesh/client-utils";
import { client } from "./client"; // your MeshClient instance

const handler = createDedupedPresenceHandler({
  getGroupId: async (connectionId) => {
    // Group by userId if available, otherwise fallback to connectionId
    const metadata = await client.getConnectionMetadata(connectionId);
    return metadata.userId ?? connectionId;
  },
  onUpdate: (groups) => {
    // `groups` is a Map<groupId, group>
    const users = Array.from(groups.entries()).map(([groupId, group]) => ({
      id: groupId,
      state: group.state,
      tabCount: group.members.size,
    }));

    // Defined below
    renderPresenceList(users);
  },
});

await client.subscribePresence("room:chat", handler);
```

**What does `groups` contain?**

Each `group` looks like this:

```ts
{
  representative: "conn123",               // Most recent connection to update state
  state: { status: "typing" },             // Most recent presence state (or null)
  timestamp: 1713748000000,                // Time of last state update
  members: new Set(["conn123", "conn456"]) // All connections in the group
}
```

You can group by basically anything in `getGroupId` — connection metadata, session cookies, localStorage — it’s up to you. In the example above, we’re grouping by `userId` if present, or falling back to `connectionId` so that all connections are still shown individually when needed.

### Rendering to the DOM

Here’s a simple example that displays deduplicated users in the UI:

```ts
function renderPresenceList(users) {
  const container = document.querySelector("#presence");
  container.innerHTML = users
    .map((user) => {
      const status = user.state?.status ?? "idle";
      return `
      <div>
        <strong>${user.id}</strong>: ${status} (tabs: ${user.tabCount})
      </div>`;
    })
    .join("");
}
```

Shows something like:

```ts
Alice: typing (tabs: 2)
conn-m9sdkxww000007079ff77: idle (tabs: 1)
```
