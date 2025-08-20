/// <cts-enable />
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

// Data Types for Chat Application
interface ChatMessage {
  userId: string;
  message: string;
  timestamp: number;
}

type MainRecipeInput = {
  messages: Default<ChatMessage[], []>;
};

interface LocalUserState {
  username: Cell<string>;
}

type UserSessionInput = MainRecipeInput;

type UserSessionResult = {
  userId: string;
  username: string;
};

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
export const UserSession = recipe<
  UserSessionInput,
  UserSessionResult
>(
  "User Chat Session",
  ({ messages }) => {
    const userId = generateUserId();

    // (removed debug derives)

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

// Handler to create a new user session - defined outside to match pattern
const createUserSession = handler((_, state: { messages: any }) => {
  const sessionCharm = UserSession({
    messages: state.messages,
  });

  return navigateTo(sessionCharm);
}, { proxy: true });

// Main Chat Recipe - State container only, no chat display
// This recipe only stores the shared state and provides a button to create user sessions
export default recipe<MainRecipeInput>(
  "Main Chat State Container",
  ({ messages }) => {
    // (removed debug derives)
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
