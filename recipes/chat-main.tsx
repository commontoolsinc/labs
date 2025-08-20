/// <cts-enable />
import {
  Cell,
  Default,
  h,
  handler,
  JSONSchema,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
} from "commontools";

// Data Types for Chat Application
interface ChatMessage {
  userId: string;
  message: string;
  timestamp: number;
}

const ChatMessageSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    message: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["userId", "message", "timestamp"],
} as const satisfies JSONSchema;

interface MainRecipeInputSchema {
  messages: Default<ChatMessage[], []>;
}

// No explicit SharedState type; rely on handler inference for readonly props

interface LocalUserState {
  username: Cell<string>;
}

interface UserSessionInputSchema {
  messages: Default<ChatMessage[], []>;
}

// Use JSON Schemas with asCell so both main and sessions share the same Cell
const MainChatInputSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: ChatMessageSchema,
      default: [],
      asCell: true,
    },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

const UserSessionResultSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    username: { type: "string" },
  },
  required: ["userId", "username"],
} as const satisfies JSONSchema;

// Helper function to generate a unique user ID
function generateUserId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Handler to send a new chat message
const sendMessage = handler<
  { detail: { message: string } },
  { messages: Cell<ChatMessage[]>; userId: string }
>((event, { messages, userId }) => {
  const text = event.detail?.message?.trim();
  if (!text) return;
  messages.push({ userId, message: text, timestamp: Date.now() });
});

// User Session Recipe - Individual instance with local state
export const UserSession = recipe(
  MainChatInputSchema,
  UserSessionResultSchema,
  ({ messages }) => {
    const userId = generateUserId();

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
              {messages.map((chatMsg: ChatMessage, index: number) => (
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

// Handler to create a new user session - defined outside to match pattern
const createUserSession = handler((_, state: { messages: any }) => {
  const sessionCharm = UserSession({
    messages: state.messages,
  });

  return navigateTo(sessionCharm);
}, { proxy: true });

// Main Chat Recipe - State container only, no chat display
// This recipe only stores the shared state and provides a button to create user sessions
const MainChatResultSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: ChatMessageSchema,
      default: [],
      asCell: true,
    },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

export default recipe(
  MainChatInputSchema,
  MainChatResultSchema,
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
