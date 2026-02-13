/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  ID,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  str,
  UI,
} from "commontools";

// User object for better data modeling
interface User {
  name: string;
}

interface ChatMessage {
  [ID]: number;
  author: User;
  message: string;
  timestamp: number;
  x: number;
  y: number;
  hidden?: boolean;
}

type MainPatternInput = {
  messages: Default<ChatMessage[], []>;
};

type UserSessionInput = {
  messages: Default<ChatMessage[], []>;
  user: User;
};

type UserSessionResult = {
  messages: Default<ChatMessage[], []>;
  user: User;
};

type InputEventType = {
  detail: {
    message: string;
  };
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

const handleCanvasClick = handler<
  { detail: { x: number; y: number } },
  {
    messages: Cell<ChatMessage[]>;
    user: Cell<User>;
  }
>((event, { messages, user }) => {
  // Create a new message at the clicked position with empty text
  const currentMessages = messages.get();
  messages.push({
    [ID]: currentMessages.length,
    author: user.get(),
    message: "",
    timestamp: Date.now(),
    x: event.detail.x,
    y: event.detail.y,
  });
});

const updateMessage = handler<
  InputEventType,
  {
    messages: Cell<ChatMessage[]>;
    index: number;
  }
>((event, { messages, index }) => {
  const text = event.detail?.message ?? "";
  messages.key(index).key("message").set(text);
});

const updateMessagePosition = handler<
  { detail: { x: number; y: number } },
  {
    messages: Cell<ChatMessage[]>;
    index: number;
  }
>((event, { messages, index }) => {
  messages.key(index).key("x").set(event.detail.x);
  messages.key(index).key("y").set(event.detail.y);
});

const deleteMessage = handler<
  any,
  {
    messages: Cell<ChatMessage[]>;
    index: number;
  }
>((_, { messages, index }) => {
  // Set hidden flag instead of removing
  messages.key(index).key("hidden").set(true);
});

const setUsername = handler<
  InputEventType,
  {
    user: Cell<User>;
  }
>((event, { user }) => {
  const name = (event.detail?.message ?? "").trim();
  if (name) {
    user.key("name").set(name);
  }
});

// User Session Pattern - Individual instance with local state
export const UserSession = pattern<
  UserSessionInput,
  UserSessionResult
>(
  "Canvas",
  ({ messages, user }) => {
    return {
      [NAME]: str`Canvas v19-random` as any,
      [UI]: (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "10px",
            }}
          >
            <label style={{ whiteSpace: "nowrap" }}>Your username:</label>
            <ct-input
              name="Update"
              value={user.name}
              placeholder="Enter new name"
              onct-change={setUsername({
                user,
              })}
              style="flex: 1; max-width: 400px"
            />
          </div>
          <hr />
          <div>
            <ct-canvas
              width="800"
              height="600"
              onct-canvas-click={handleCanvasClick({ messages, user })}
            >
              {messages.map((m, index) => {
                return (
                  <ct-draggable
                    key={index}
                    x={derive(m, (msg) => msg.x)}
                    y={derive(m, (msg) => msg.y)}
                    hidden={ifElse(
                      derive(m, (msg) => msg.hidden === true),
                      "true" as const,
                      undefined,
                    )}
                    onpositionchange={updateMessagePosition({
                      messages,
                      index,
                    })}
                  >
                    <div style="position: relative;">
                      <ct-button
                        onClick={deleteMessage({ messages, index })}
                        style="position: absolute; right: -5px; top: -5px; background: #ff4444; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; min-width: 20px; min-height: 20px; padding: 0; font-size: 16px; line-height: 1;"
                        title="Delete note"
                      >
                        ×
                      </ct-button>
                      <div style="font-size: 12px; color: #666;">
                        <b>{m.author.name}</b>
                        <span>· {derive(m.timestamp, formatTime)}</span>
                      </div>
                      <ct-input
                        name="Save"
                        placeholder="Type message..."
                        value={m.message}
                        onct-change={updateMessage({ messages, index })}
                        style="margin-top: 5px;"
                      />
                    </div>
                  </ct-draggable>
                );
              })}
            </ct-canvas>
          </div>
        </div>
      ),
      messages,
      user,
    };
  },
);

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

export default pattern<MainPatternInput>(
  "Canvas",
  ({ messages }) => {
    return {
      [NAME]: "Canvas",
      [UI]: (
        <div>
          <h2>Canvas</h2>
          <p>Messages: {messages.length}</p>
          <p>Click below to create your personal session:</p>
          <ct-button onClick={createUserSession({ messages })}>
            Generate User Session
          </ct-button>
        </div>
      ),
      messages,
    };
  },
);
