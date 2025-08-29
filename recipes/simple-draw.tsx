/// <cts-enable />
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

interface ChatMessage {
  author: User;
  message: string;
  timestamp: number;
  x: number;
  y: number;
}

type MainRecipeInput = {
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

  messages.push({
    author: user.get(),
    message: text,
    timestamp: Date.now(),
    x: Math.random() * 600,
    y: Math.random() * 400,
  });
});

const handleCanvasClick = handler<
  { detail: { x: number; y: number } },
  {
    messages: Cell<ChatMessage[]>;
    user: Cell<User>;
  }
>((event, { messages, user }) => {
  console.log(
    `Canvas clicked at position: x=${event.detail.x}, y=${event.detail.y}`,
  );

  // Create a new message at the clicked position with empty text
  messages.push({
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

// User Session Recipe - Individual instance with local state
export const UserSession = recipe<
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
            <common-send-message
              inline="true"
              name="Update"
              value={user.name}
              placeholder="Enter new name"
              appearance="rounded"
              onmessagesend={setUsername({
                user,
              })}
              style="flex: 1; max-width: 400px"
            />
          </div>
          <hr />
          <div>
            <h3>Chat Messages</h3>
            <ct-canvas
              width="800"
              height="600"
              onct-canvas-click={handleCanvasClick({ messages, user })}
            >
              {messages.map((m, index) => {
                // Use stored coordinates or generate random ones as fallback
                const x = m.x ?? Math.random() * 600;
                const y = m.y ?? Math.random() * 400;

                return (
                  <div
                    key={index}
                    style={`position: absolute; left: ${x}px; top: ${y}px; padding: 10px; background-color: #ffffcc; border: 1px solid #ddd; border-radius: 4px; max-width: 200px;`}
                  >
                    <div style="font-size: 12px; color: #666;">
                      <b>{m.author.name}</b>
                      <span>· {derive(m.timestamp, formatTime)}</span>
                    </div>
                    <common-send-message
                      name="Save"
                      placeholder="Type message..."
                      value={m.message}
                      appearance="rounded"
                      onmessagesend={updateMessage({ messages, index })}
                      style="margin-top: 5px;"
                    />
                  </div>
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

export default recipe<MainRecipeInput>(
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
