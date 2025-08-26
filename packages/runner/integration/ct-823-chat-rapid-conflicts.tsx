/// <cts-enable />
// CT-823: Test Recipe for Runtime Conflicts During Multi-Tab Chat
// Issue: https://linear.app/common-tools/issue/CT-823/runtime-conflicts-during-multi-tab-chat
//
// PURPOSE:
// This is a modified version of chat-user-sessions.tsx specifically designed to
// reproduce a critical bug where reactive Cell references stored in arrays cause
// the recipe to break after ConflictErrors occur during multi-tab synchronization.
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

// User object for better data modeling
interface User {
  name: string;
}

// Data types for the chat messages. CTS will derive the matching schema.
interface ChatMessage {
  author: User;
  message: string;
  timestamp: number;
}

// Recipe input (typed). The UI receives a reactive reference that supports
// mapping (`messages.map(...)`). Writes should be performed in handlers.
type MainRecipeInput = {
  messages: Default<ChatMessage[], []>;
};

type UserSessionInput = {
  messages: Default<ChatMessage[], []>;
  user: User;
};

// Session recipe result (typed): return User object alongside [NAME] and [UI].
// CTS will carry these in the recipe result schema.
type UserSessionResult = {
  messages: Default<ChatMessage[], []>;
  user: User;
};

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
const sendMessage = handler<
  InputEventType,
  {
    messages: Cell<ChatMessage[]>;
    user: Cell<User>;
  }
>((event, { messages, user }) => {
  const text = event.detail?.message?.trim();
  if (!text) return;

  console.log("[CT823-HANDLER] sendMessage handler called with text:", text);
  
  // TESTING CT-823: Send 20 messages rapidly to trigger conflicts
  for (let i = 1; i <= 20; i++) {
    const userValue = user.get();
    console.log(`[CT823-USER-VALUE] Iteration ${i}: user.get() =`, userValue);
    
    const messageData = {
      author: userValue,
      message: `${i}/${text}`, // Prefix with counter
      timestamp: Date.now(),
    };
    
    console.log(`[CT823-HANDLER] Pushing message ${i}:`, messageData);
    messages.push(messageData);
    console.log(`[CT823-HANDLER] Message ${i} pushed successfully`);
  }
  
  console.log("[CT823-HANDLER] sendMessage handler completed");
});

// Handler to set/update the username (local-only field)
const setUsername = handler<
  InputEventType,
  {
    user: Cell<User>;
  }
>((event, { user }) => {
  const name = (event.detail?.message ?? "").trim();
  // Update only the "name" field to avoid clearing other properties
  user.key("name").set(name);
});

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<
  UserSessionInput,
  UserSessionResult
>(
  "User Chat Session",
  ({ messages, user }) => {
    return {
      [NAME]: str`Chat Session` as any,
      [UI]: (
        <div>
          <h2>Your Chat Session</h2>
          <div>
            <label>
              Your username: {user.name}
            </label>
          </div>
          <div>
            <h4>Set your display name</h4>
            <common-send-message
              name="Set"
              placeholder="Choose a display name"
              appearance="rounded"
              onmessagesend={setUsername({
                user,
              })}
            />
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
                      {m.author.name}
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
                user,
              })}
            />
          </div>
        </div>
      ),
      messages,
      user,
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
  }
>((_, { messages }) => {
  const sessionCharm = UserSession({
    messages: messages as any,
    user: cell<User>({ name: "<anon>" }),
  });

  return navigateTo(sessionCharm);
});

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
