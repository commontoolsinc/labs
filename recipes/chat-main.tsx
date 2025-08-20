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

interface MainRecipeInputSchema {
  messages: Default<ChatMessage[], []>;
}

interface SharedState {
  messages: Cell<ChatMessage[]>;
}

interface LocalUserState {
  username: Cell<string>;
}

interface UserSessionInputSchema {
  messages: Default<ChatMessage[], []>;
}

// Helper function to generate a unique user ID
function generateUserId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// User Session Recipe - Individual instance with local state
export const UserSession = recipe(
  "User Chat Session",
  ({messages}: UserSessionInputSchema) => {
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
                <li>key={index}, msg={chatMsg.message}</li>
            ))} 
            </ul>
          </div>
          <div>
            <ct-message-input
              button-text="Send"
              placeholder="Type your message..."
              appearance="rounded"
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
const createUserSession = handler<
  unknown, 
  { messages: Cell<ChatMessage[]>; }
>((_, state: SharedState) => {
  const sessionCharm = UserSession({
    messages: state.messages,
  });

  return navigateTo(sessionCharm);
});

// Main Chat Recipe - State container only, no chat display
// This recipe only stores the shared state and provides a button to create user sessions
export default recipe(
  "Main Chat State Container",
  ({messages}: MainRecipeInputSchema) => {
    return {
      [NAME]: "Chat State Container",
      [UI]: (
        <div>
          <h2>Chat State Container</h2>
          <p>This charm stores the shared chat state.</p>
          <p>Messages: {messages.length}</p>
          <p>Click below to create your personal chat session:</p>
          <ct-button onClick={createUserSession({messages})}>
            Generate User Session
          </ct-button>
        </div>
      ),
      messages,
    };
  },
);
