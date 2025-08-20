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
  h,
  handler,
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
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Handler to send a new chat message.
// NOTE: We provide a tiny JSON Schema here so that `messages` is a Cell in the
// handler state (via `asCell: true`), enabling `.push(...)`. The UI reads a
// reactive list, but writes should be done in handlers against Cells.
const sendMessage = handler<
  { detail: { message: string } },
  { messages: Cell<ChatMessage[]>; userId: string }
>((event, { messages, userId }) => {
  const text = event.detail?.message?.trim();
  if (!text) return;
  messages.push({ userId, message: text, timestamp: Date.now() });
});

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<
  UserSessionInput,
  UserSessionResult
>(
  "User Chat Session",
  ({ messages }) => {
    const userId = generateUserId();

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
            <label>
              Username:
              <input
                type="text"
                placeholder="Enter your username"
              />
            </label>
          </div>
          <hr />
          <div>
            <h3>Chat Messages</h3>
            <ul>
              {messages.map((chatMsg, index) => (
                <li key={index}>{chatMsg.message}</li>
              ))}
            </ul>
          </div>
          <div>
            <ct-message-input
              button-text="Send"
              placeholder="Type your message..."
              appearance="rounded"
              onct-send={sendMessage({ messages, userId })}
            />
          </div>
        </div>
      ),
      userId: userId,
      username: "",
    };
  },
);

// Handler to create a new user session. We use `{ proxy: true }` so the handler
// receives the live reactive references (OpaqueRefs), not a readonly snapshot.
// That allows us to pass `state.messages` directly into the child recipe and
// keep all sessions linked to the same underlying state.
const createUserSession = handler((_, state: { messages: any }) => {
  const sessionCharm = UserSession({
    messages: state.messages,
  });

  return navigateTo(sessionCharm);
}, { proxy: true });

// Main chat recipe: a state container with a button to spawn per-user sessions.
// All sessions get the same `messages` reference so changes are shared.
export default recipe<MainRecipeInput>(
  "Main Chat State Container",
  ({ messages }) => {
    return {
      [NAME]: "Chat State Container",
      [UI]: (
        <div>
          <h2>Chat State Container</h2>
          <p>This charm stores the shared chat state.</p>
          <p>Messages: {messages.length}</p>
          <p>Click below to create your personal chat session:</p>
          <ct-button onClick={createUserSession({ messages })}>
            Generate User Session
          </ct-button>
        </div>
      ),
      messages,
    };
  },
);
