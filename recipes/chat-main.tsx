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
  author?: string;
  message: string;
  timestamp: number;
}

// Recipe input (typed). The UI receives a reactive reference that supports
// mapping (`messages.map(...)`). Writes should be performed in handlers.
type MainRecipeInput = {
  messages: Default<ChatMessage[], []>;
  users: Default<Record<string, string>, {}>;
};

// Example of per-session local state. Currently unused; left here to show how
// a Cell-backed local field could be added to a session recipe.
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

// Helper function to generate a unique user ID
function generateUserId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `user_${rand}`;
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

// Handler to send a new chat message.
// NOTE: CTS will infer a schema from the types. Because `messages` is typed as
// Cell<ChatMessage[]>, the generated schema marks it `asCell: true`, so we can
// call `.push(...)` here. UI reads remain reactive via mapping.
const sendMessage = handler<
  InputEventType,
  { messages: Cell<ChatMessage[]>; userId: string; username: string }
>((event, { messages, userId, username }) => {
  const text = event.detail?.message?.trim();
  if (!text) return;
  const display = (username && username.trim()) || userId;
  messages.push({
    userId,
    author: display,
    message: text,
    timestamp: Date.now(),
  });
});

// Handler to set/update the username for this session (local-only field)
const setUsername = handler<
  InputEventType,
  {
    username: Cell<string>;
    users?: Cell<Record<string, string>>;
    userId?: string;
  }
>((event, { username, users, userId }) => {
  username.set((event.detail?.message ?? "").trim());
  // If a shared users map is provided, update it too so all sessions reactively
  // re-render names by userId.
  if (users && userId) {
    const current = users.get();
    const next = { ...(current || {}) } as Record<string, string>;
    next[userId] = (event.detail?.message ?? "").trim();
    users.set(next as any);
  }
});

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<
  UserSessionInput,
  UserSessionResult
>(
  "User Chat Session",
  ({ messages, users }) => {
    const userId = generateUserId();

    // Local-only username for this session
    const username = "" as Default<string, "">;

    // UI reads: `messages.map(...)` renders the list reactively. No writes here;
    // those happen via the `sendMessage` handler above.
    return {
      [NAME]: str`Chat Session - User ${userId.slice(0, 8)}`,
      [UI]: (
        <div>
          <h2>Your Chat Session</h2>
          <div>
            <label>Your User ID: {userId}</label>
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
          <hr />
          <div>
            <h3>Chat Messages</h3>
            <div style="display: grid; gap: 8px;">
              {messages.map((m) => (
                <div style="display: grid; gap: 2px;">
                  <div style="font-size: 12px; color: #666;">
                    <b>
                      {derive({ a: m.author, id: m.userId }, ({ a, id }) => {
                        const name = typeof a === "string" ? a.trim() : "";
                        return name || id;
                      })}
                    </b>
                    <span>· {derive(m.timestamp, formatTime)}</span>
                  </div>
                  <div style="font-size: 14px;">{m.message}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <common-send-message
              name="Send"
              placeholder="Type your message..."
              appearance="rounded"
              onmessagesend={sendMessage({ messages, userId, username })}
            />
          </div>
        </div>
      ),
      userId: userId,
      username: username,
    };
  },
);

// Handler to create a new user session. We use `{ proxy: true }` so the handler
// receives the live reactive references (OpaqueRefs), not a readonly snapshot.
// That allows us to pass `state.messages` directly into the child recipe and
// keep all sessions linked to the same underlying state.
const createUserSession = handler((_, state: { messages: any; users: any }) => {
  const sessionCharm = UserSession({
    messages: state.messages,
    users: state.users,
  });

  return navigateTo(sessionCharm);
}, { proxy: true });

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
