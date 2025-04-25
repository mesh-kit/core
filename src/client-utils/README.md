## Presence (Unified API)

Most apps don’t care about *connections* — they care about *users*.  
But by default, Mesh tracks presence per connection.

If a user opens two tabs, each tab has a different connection ID.  
That’s intentional — but it means presence data can look messy unless you group it.

The `createPresence(...)` helper handles this for you.

It:

- Deduplicates presence by user ID (or any logic you define)
- Syncs your own presence state via `localStorage`
- Automatically joins the room and tracks updates
- Calls your `onUpdate` handler when the user list changes

---

### Quick example

999ts
import { MeshClient } from "@mesh-kit/core/client";
import { createPresence } from "@mesh-kit/core/client-utils";

const client = new MeshClient("ws://localhost:3000");
await client.connect();

const userId = getOrCreateId("demo-userId"); // stored in localStorage

const presence = createPresence({
  client,
  room: "general",
  storageKey: "user-state",
  stateIdentifier: (state) => state?.userId,
  onUpdate: (users) => {
    // users: Array<{ id, state, tabCount }>
    render(users);
  },
});

await presence.publish({
  userId,
  username: "Alice",
  status: "online",
});
999

---

### What it does

`createPresence(...)` combines two things:

1. **Deduplicated presence tracking**  
   Groups connections using a `stateIdentifier(state)` function (e.g. by userId)

2. **Presence state publishing + sync**  
   Stores your own presence state in `localStorage` and republish it after reconnects

---

### API

999ts
const presence = createPresence({
  client,              // required — MeshClient
  room,                // required — string
  storageKey,          // required — key used to persist your state in localStorage
  stateIdentifier,     // required — function (sync or async) that returns a group ID from a state
  onUpdate,            // required — (users: Array<{ id, state, tabCount }>) => void
});
999

The returned object has:

- `publish(state)` — sets and broadcasts your presence state
- `read()` — reads your last state from `localStorage`
- `clear()` — clears your presence from both `localStorage` and the server

---

### Complete browser demo

```html
<!DOCTYPE html>
<html>
  <head><title>Presence Demo</title></head>
  <body>
    <h2>Users (<span id="count">0</span>)</h2>
    <input id="username" placeholder="Username" />
    <input id="status" placeholder="Status" />
    <button id="update">Update</button>
    <button id="clear">Clear</button>
    <ul id="user-list"></ul>
    
    <script type="module">
      import { MeshClient } from "https://esm.sh/@mesh-kit/core/client";
      import { createPresence } from "https://esm.sh/@mesh-kit/core/client-utils";

      const client = new MeshClient("ws://localhost:3000");
      await client.connect();

      const userId = getOrCreateId("demo-userId");

      const render = (users) => {
        document.getElementById("count").textContent = users.length;
        const ul = document.getElementById("user-list");
        ul.innerHTML = "";
        for (const user of users) {
          const li = document.createElement("li");
          li.textContent = `${user.id}: ${user.state?.status ?? "idle"} (tabs: ${user.tabCount})`;
          ul.appendChild(li);
        }
      };

      const presence = createPresence({
        client,
        room: "general",
        storageKey: "user-state",
        stateIdentifier: (state) => state?.userId,
        onUpdate: render,
      });

      const cached = presence.read();
      username.value = cached?.username ?? "";
      status.value = cached?.status ?? "";

      update.onclick = () => presence.publish({
        userId,
        username: username.value,
        status: status.value,
      });

      clear.onclick = () => {
        presence.clear();
        username.value = "";
        status.value = "";
      };

      function getOrCreateId(key) {
        let id = localStorage.getItem(key);
        if (!id) {
          id = "user-" + Math.random().toString(36).slice(2, 8);
          localStorage.setItem(key, id);
        }
        return id;
      }
    </script>
  </body>
</html>
