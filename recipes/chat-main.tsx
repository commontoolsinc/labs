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

interface SharedState {
  messages: Default<ChatMessage[], []>;
  users: Default<Map<string, string>, Map<string, string>>;
}

interface LocalUserState {
  userId: Default<string, "">;
  username: Default<string, "">;
}

// Schema definitions for recipe inputs/outputs
// Main chat recipe doesn't need any input - it creates and manages its own state
type MainChatInput = Record<string, never>;

interface MainChatOutput {
  [NAME]: string;
  [UI]: any;
  // Exposed state that child instances will use
  messages: ChatMessage[];
  users: Map<string, string>;
}

interface UserSessionInput extends SharedState {
  // User session receives the shared state as input
}

interface UserSessionOutput extends LocalUserState {
  [NAME]: string;
  [UI]: any;
  sharedState: SharedState; // Keep reference to shared state for updates
}

// Helper function to generate a unique user ID
function generateUserId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<UserSessionInput, UserSessionOutput>(
  "User Chat Session",
  (input) => {
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
              <input type="text" placeholder="Enter your username" />
            </label>
          </div>
          <hr />
          <div>
            <h3>Chat Messages</h3>
            {input.messages.length === 0
              ? <p>No messages yet. Be the first to send a message!</p>
              : (
                <ul>
                  {input.messages.map((msg, idx) => (
                    <li key={idx}>
                      <strong>{msg.userId}:</strong> {msg.message}
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <div>
            <input type="text" placeholder="Type your message..." />
            <ct-button>Send</ct-button>
          </div>
        </div>
      ),
      userId: userId,
      username: "",
      sharedState: input,
    };
  },
);

// Handler to create a new user session - defined outside to match pattern
const createUserSession = handler<unknown, { messages: ChatMessage[], users: Map<string, string> }>((_, state) => {
  const sessionCharm = UserSession({
    messages: (state.messages || []) as any,
    users: (state.users || new Map()) as any,
  });

  return navigateTo(sessionCharm);
});

// Main Chat Recipe - State container only, no chat display
// This recipe only stores the shared state and provides a button to create user sessions
export default recipe<MainChatInput, MainChatOutput>(
  "Main Chat State Container",
  (input) => {
    // Initialize state with messages and users
    const messages: ChatMessage[] = [];
    const users = new Map<string, string>();
    const state = {
      messages,
      users,
    };

    return {
      [NAME]: "Chat State Container",
      [UI]: (
        <div>
          <h2>Chat State Container</h2>
          <p>This charm stores the shared chat state.</p>
          <p>Messages: {messages.length}, Users: {users.size}</p>
          <p>Click below to create your personal chat session:</p>
          <ct-button onClick={createUserSession(state)}>
            Generate User Session
          </ct-button>
        </div>
      ),
      messages,
      users,
    };
  },
);
