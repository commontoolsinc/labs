/// <cts-enable />
// Teaching example: CTS (CommonTools TypeScript) generates JSON Schemas from the
// TypeScript types below. The recipes use typed inputs/outputs, while handlers
// add small JSON Schemas only where mutation is required (e.g. marking fields
// as cells). The key ideas demonstrated:
// - Typed recipe inputs let the UI map/read reactive values without extra JSON
//   schema boilerplate.
// - Mutations happen inside handlers. Their state schema uses `asCell` so the
//   state arrives as a real Cell<T>, enabling `.set()`/`.push()`.
// - `proxy: true` on a handler passes through live OpaqueRefs so we can forward
//   references (e.g., into `navigateTo`) without losing reactivity.
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
} from "commontools";

// Data types for the chat messages. CTS will derive the matching schema.
interface ChatMessage {
  userId: string;
  message: string;
  timestamp: number;
}

// Recipe input (typed). The UI receives a reactive reference that supports
// mapping (`messages.map(...)`). Writes should be performed in handlers.
type MainRecipeInput = {
  messages: Default<ChatMessage[], []>;
  // Shared directory of userId -> username (display names)
  users: Default<Record<string, string>, Record<PropertyKey, never>>;
};

// Example of local state.
interface LocalUserState {
  username: Cell<string>;
}

type UserSessionInput = MainRecipeInput;

// Session recipe result (typed): return extra fields (e.g., userId/username)
// alongside [NAME] and [UI]. CTS will carry these in the recipe result schema.
type UserSessionResult = {
  userId: string;
  username: string;
};

// Helper to generate a user id when first needed
function generateUserId(): string {
  const n = Math.floor(Math.random() * 10000);
  return `id${n.toString().padStart(4, "0")}`;
}

// Helper to get or initialize userId from a Cell
function getId(userId: Cell<string>): string {
  let id = typeof userId.get === "function" ? userId.get() : "";
  if (!id) {
    id = generateUserId();
    userId.set(id);
    console.log("[getId] initialized userId:", id);
  }
  return id;
}

// Event payload type for ct-message-input's ct-send event
type InputEventType = {
  detail: {
    message: string;
  };
};

// Simple messenger-style time format (e.g., 3:05 PM). No full date per message.
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Helper to resolve a user's display name from the shared map, falling back to userId
function resolveDisplayName(
  usersMap: Record<string, string> | undefined | null,
  userId: string,
): string {
  const fromMap = usersMap?.[userId];
  const name = typeof fromMap === "string" ? fromMap.trim() : "";
  return name || userId;
}

// Handler to send a new chat message.
const sendMessage = handler<
  InputEventType,
  {
    messages: Cell<ChatMessage[]>;
    userId: Cell<string>;
    username: Cell<string>;
    users?: Cell<Record<string, string>>;
  }
>((event, { messages, userId, username }) => {
  const text = event.detail?.message?.trim();
  if (!text) return;
  const id = getId(userId);
  console.log("[sendMessage] userId:", id);
  messages.push({
    userId: id,
    message: text,
    timestamp: Date.now(),
  });
});

// Handler to set/update the username (local-only field)
const setUsername = handler<
  InputEventType,
  {
    username: Cell<string>;
    users: Cell<Record<string, string>>;
    userId: Cell<string>;
  }
>((event, { username, users, userId }) => {
  const name = (event.detail?.message ?? "").trim();
  const id = getId(userId);
  username.set(name);
  users.update({ [id]: name } as any);
  console.log("[setUsername] userId:", id, "name:", name);
}, { proxy: true });

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<
  UserSessionInput,
  UserSessionResult
>(
  "User Chat Session",
  ({ messages, users }) => {
    const username = cell<string>("");
    const userId = cell<string>("");

    // UI reads: `messages.map(...)` renders the list reactively. No writes here;
    // those happen via the `sendMessage` handler above.
    return {
      [NAME]: str`Chat Session` as any,
      [UI]: (
        <div>
          <h2>Your Chat Session</h2>
          <div>
            <label>
              Your User ID: {derive(userId, (k) => k || "(pending)")}
            </label>
          </div>
          <div>
            <h4>Set your display name</h4>
            <common-send-message
              name="Set"
              placeholder="Choose a display name"
              appearance="rounded"
              onmessagesend={setUsername({ username, users, userId })}
            />
          </div>
          <div
            data-testid="current-username"
            style={{ marginTop: "6px", fontSize: "12px", color: "#444" }}
          >
            Your current username is: {derive(
              { u: username, id: userId },
              ({ u, id }) => (u?.trim() || id || "(pending)"),
            )}
          </div>
          <hr />
          <div>
            <h3>Chat Messages</h3>
            <div style={{ display: "grid", gap: "8px" }}>
              {messages.map((m) => (
                <div style={{ display: "grid", gap: "2px" }}>
                  <div
                    data-testid="message-header"
                    style={{ fontSize: "12px", color: "#666" }}
                  >
                    <b>
                      {derive(
                        { u: users, id: m.userId },
                        ({ u, id }) => resolveDisplayName(u as any, id as any),
                      )}
                    </b>
                    <span>· {derive(m.timestamp, formatTime)}</span>
                  </div>
                  <div style={{ fontSize: "14px" }}>{m.message}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <common-send-message
              name="Send"
              placeholder="Type your message..."
              appearance="rounded"
              onmessagesend={sendMessage({
                messages,
                userId,
                username,
                users,
              })}
            />
          </div>
        </div>
      ),
      userId: derive(userId, (k) => k || "") as any,
      username: username,
    };
  },
);

// Handler to create a new user session. Receives typed parameters so the handler
// can pass the reactive references directly into the child recipe and
// keep all sessions linked to the same underlying state.
const createUserSession = handler<
  never,
  {
    messages: Default<ChatMessage[], []>;
    users: Default<Record<string, string>, Record<PropertyKey, never>>;
  }
>((_, { messages, users }) => {
  const sessionCharm = UserSession({
    messages: messages as any,
    users: users as any,
  });

  return navigateTo(sessionCharm);
});

// Main chat recipe: a state container with a button to spawn per-user sessions.
// All sessions get the same `messages` reference so changes are shared.
export default recipe<MainRecipeInput>(
  "Main Chat State Container",
  ({ messages, users }) => {
    return {
      [NAME]: "Chat State Container",
      [UI]: (
        <div>
          <h2>Chat State Container</h2>
          <p>This charm stores the shared chat state.</p>
          <p>Messages: {messages.length}</p>
          <p>Click below to create your personal chat session:</p>
          <ct-button onClick={createUserSession({ messages, users })}>
            Generate User Session
          </ct-button>
        </div>
      ),
      messages,
      users,
    };
  },
);
