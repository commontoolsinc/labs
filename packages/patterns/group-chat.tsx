/// <cts-enable />
import { cell, Cell, Default, derive, handler, ifElse, NAME, navigateTo, pattern, str, UI } from "commontools";

/**
 * Group Chat
 *
 * Combined lobby + room patterns in one file to avoid circular imports.
 * - Lobby: Entry point where users enter their name and join
 * - Room: Chat interface with pre-computed array-based message metadata
 *
 * Uses ifElse to render completely separate containers with STATIC styles
 * instead of reactive values in style objects. Reactive layout properties like
 * justifyContent don't work when derived - must use ifElse branching.
 */

// ============================================================================
// Shared Types
// ============================================================================

export interface Message {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  type: "chat" | "system";
}

export interface User {
  name: string;
  joinedAt: number;
  color: string;
}

interface MessageMeta {
  isMyMessage: boolean;
  isSystem: boolean;
  isFirstInBlock: boolean;
  shouldShowAvatar: boolean;
  marginBottom: string;
  color: string;
  initials: string;
  justifyContent: string;
  bubbleAlignItems: string;
  bubbleBgColor: string;
  bubbleTextColor: string;
  bubbleBottomRightRadius: string;
  bubbleBottomLeftRadius: string;
}

// ============================================================================
// Shared Utilities
// ============================================================================

function getRandomColor(): string {
  const colors = [
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function getInitials(name: string): string {
  if (!name || typeof name !== "string") return "?";
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ============================================================================
// Lobby Pattern (defined first so Room can reference it)
// ============================================================================

interface LobbyInput {
  chatName: Default<string, "Group Chat">;
  messages: Cell<Default<Message[], []>>;
  users: Cell<Default<User[], []>>;
}

interface LobbyOutput {
  chatName: Default<string, "Group Chat">;
  messages: Cell<Default<Message[], []>>;
  users: Cell<Default<User[], []>>;
}

// Forward declaration - will be assigned after GroupChatRoom is defined
let createRoomAndNavigate: any = null;

// Handler defined at module level to avoid closure issues
const joinChat = handler<
  unknown,
  {
    chatName: string;
    nameInput: Cell<string>;
    messages: Cell<Message[]>;
    users: Cell<User[]>;
  }
>((_event, { chatName, nameInput, messages, users }) => {
  const name = nameInput.get().trim();
  if (!name) return;

  const existingUsers = users.get();
  const existingUser = existingUsers.find((u) => u.name === name);

  if (!existingUser) {
    users.push({
      name,
      joinedAt: Date.now(),
      color: getRandomColor(),
    });

    messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      author: "System",
      content: `${name} joined the chat`,
      timestamp: Date.now(),
      type: "system",
    });
  }

  nameInput.set("");

  // Use the forward-declared function
  if (createRoomAndNavigate) {
    return createRoomAndNavigate(chatName, messages, users, name);
  }
});

const GroupChatLobby = pattern<LobbyInput, LobbyOutput>(({ chatName, messages, users }) => {
  const nameInput = cell("");

  return {
    [NAME]: str`${chatName} - Lobby`,
    [UI]: (
      <div
        style={{
          display: "flex",
          height: "100%",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Main Lobby Area */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <h1 style={{ marginBottom: "0.5rem", color: "#1d1d1f", fontSize: "2rem" }}>
            {chatName}
          </h1>
          <p style={{ marginBottom: "2rem", color: "#6b7280" }}>
            Enter your name to join the conversation
          </p>

          {/* Join Form */}
          <div
            style={{
              width: "100%",
              maxWidth: "400px",
              padding: "1.5rem",
              backgroundColor: "#dbeafe",
              borderRadius: "12px",
              border: "2px solid #3b82f6",
            }}
          >
            <div
              style={{
                fontSize: "1rem",
                fontWeight: "600",
                marginBottom: "1rem",
                color: "#1e40af",
              }}
            >
              Your Name
            </div>
            <ct-input
              $value={nameInput}
              placeholder="Enter your name..."
              style="width: 100%; margin-bottom: 1rem;"
              timingStrategy="immediate"
              onct-submit={joinChat({ chatName, nameInput, messages, users })}
            />
            <ct-button
              style="width: 100%; background-color: #3b82f6; color: white; font-weight: 600; padding: 0.75rem; font-size: 1rem;"
              onClick={joinChat({ chatName, nameInput, messages, users })}
            >
              Join Chat
            </ct-button>
          </div>

          <p
            style={{
              marginTop: "1.5rem",
              fontSize: "0.875rem",
              color: "#78350f",
              backgroundColor: "#fef3c7",
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              maxWidth: "400px",
              textAlign: "center",
            }}
          >
            <strong>Note:</strong> Bookmark your chat URL after joining to return as the same user.
          </p>
        </div>

        {/* Users Sidebar */}
        <div
          style={{
            width: "80px",
            padding: "1rem",
            backgroundColor: "#f9fafb",
            borderLeft: "1px solid #e5e7eb",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: "600",
              color: "#6b7280",
              textAlign: "center",
              marginBottom: "0.5rem",
            }}
          >
            USERS
          </div>
          {users.map((user) => (
            <div
              title={user.name}
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                backgroundColor: user.color,
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "600",
                fontSize: "14px",
                margin: "0 auto",
                cursor: "default",
              }}
            >
              {getInitials(user.name)}
            </div>
          ))}
        </div>
      </div>
    ),
    chatName,
    messages,
    users,
  };
});

// ============================================================================
// Room Pattern
// ============================================================================

interface RoomInput {
  chatName: Default<string, "Group Chat">;
  messages: Cell<Default<Message[], []>>;
  users: Cell<Default<User[], []>>;
  myName: Default<string, "">;
}

interface RoomOutput {
  myName: Default<string, "">;
}

const sendMessage = handler<
  unknown,
  { messages: Cell<Message[]>; myName: string; contentInput: Cell<string> }
>((_event, { messages, myName, contentInput }) => {
  const content = contentInput.get().trim();
  if (!content || !myName) return;

  messages.push({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    author: myName,
    content,
    timestamp: Date.now(),
    type: "chat",
  });

  contentInput.set("");
});

const GroupChatRoom = pattern<RoomInput, RoomOutput>(({ chatName, messages, users, myName }) => {
  const contentInput = cell("");

  // PRE-COMPUTE: Build ALL message metadata in single derive as parallel array
  const messagesMeta = derive(
    { messages, myName, users },
    ({ messages: msgs, myName: name, users: userList }: { messages: Message[]; myName: string; users: User[] }) => {
      const msgArray = msgs || [];
      const usersArray = userList || [];

      const colorMap = new Map<string, string>();
      usersArray.forEach((user) => colorMap.set(user.name, user.color));

      return msgArray.map((msg, i): MessageMeta => {
        const prev = msgArray[i - 1];
        const next = msgArray[i + 1];
        const isMyMessage = msg.author === name;
        const isSystem = msg.type === "system";
        const isFirstInBlock = !prev || prev.author !== msg.author || prev.type === "system";

        return {
          isMyMessage,
          isSystem,
          isFirstInBlock,
          shouldShowAvatar: !isMyMessage && isFirstInBlock,
          marginBottom: !next || next.author !== msg.author || next.type === "system" ? "8px" : "2px",
          color: colorMap.get(msg.author) || "#6b7280",
          initials: getInitials(msg.author),
          justifyContent: isMyMessage ? "flex-end" : "flex-start",
          bubbleAlignItems: isMyMessage ? "flex-end" : "flex-start",
          bubbleBgColor: isMyMessage ? "#007AFF" : "#E5E5EA",
          bubbleTextColor: isMyMessage ? "white" : "#1d1d1f",
          bubbleBottomRightRadius: isMyMessage ? "4px" : "18px",
          bubbleBottomLeftRadius: isMyMessage ? "18px" : "4px",
        };
      });
    }
  );

  return {
    [NAME]: str`Chat: ${myName}`,
    [UI]: (
      <div
        style={{
          display: "flex",
          height: "100%",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Main Chat Area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "1rem" }}>
          <h2 style={{ marginBottom: "1rem", color: "#1d1d1f" }}>Group Chat</h2>

          {/* Messages Container */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              marginBottom: "1rem",
              padding: "0.5rem",
              backgroundColor: "#f5f5f7",
              borderRadius: "12px",
            }}
          >
            {messages.map((msg, index) => {
              // Derive the meta for this message from pre-computed array
              const meta = derive(messagesMeta, (metas: MessageMeta[]) => metas?.[index]);
              const isMyMessage = derive(meta, (m: MessageMeta | undefined) => m?.isMyMessage ?? false);
              const isSystem = derive(meta, (m: MessageMeta | undefined) => m?.isSystem ?? false);
              const shouldShowAvatar = derive(meta, (m: MessageMeta | undefined) => m?.shouldShowAvatar ?? false);
              const marginBottom = derive(meta, (m: MessageMeta | undefined) => m?.marginBottom ?? "8px");
              const color = derive(meta, (m: MessageMeta | undefined) => m?.color ?? "#6b7280");
              const initials = derive(meta, (m: MessageMeta | undefined) => m?.initials ?? "?");

              // v23: Use ifElse to render completely separate containers with STATIC styles
              // This avoids reactive values in style objects for layout properties
              return ifElse(
                isSystem,
                // SYSTEM MESSAGE - centered
                <div
                  style={{
                    width: "100%",
                    marginBottom: "8px",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px",
                      fontSize: "13px",
                      color: "#6b7280",
                      fontStyle: "italic",
                    }}
                  >
                    {msg.content}
                  </div>
                </div>,
                ifElse(
                  isMyMessage,
                  // MY MESSAGE - right aligned with STATIC justifyContent
                  <div
                    style={{
                      width: "100%",
                      marginBottom: "8px",
                      display: "flex",
                      justifyContent: "flex-end",
                      alignItems: "flex-end",
                      gap: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                      }}
                    >
                      <div
                        style={{
                          width: "fit-content",
                          maxWidth: "300px",
                          padding: "10px 14px",
                          borderRadius: "18px",
                          borderBottomRightRadius: "4px",
                          borderBottomLeftRadius: "18px",
                          backgroundColor: "#007AFF",
                          color: "white",
                          fontSize: "15px",
                          lineHeight: "1.4",
                        }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  </div>,
                  // OTHER'S MESSAGE - left aligned with STATIC justifyContent
                  <div
                    style={{
                      width: "100%",
                      marginBottom,
                      display: "flex",
                      justifyContent: "flex-start",
                      alignItems: "flex-end",
                      gap: "8px",
                    }}
                  >
                    {/* Avatar or placeholder */}
                    {ifElse(
                      shouldShowAvatar,
                      <div
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "50%",
                          backgroundColor: color,
                          color: "white",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: "600",
                          fontSize: "12px",
                          flexShrink: "0",
                        }}
                      >
                        {initials}
                      </div>,
                      <div style={{ width: "32px", flexShrink: "0" }} />
                    )}

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                      }}
                    >
                      {/* Author name - only first in block */}
                      {ifElse(
                        shouldShowAvatar,
                        <div
                          style={{
                            fontSize: "12px",
                            fontWeight: "600",
                            color: "#86868b",
                            marginBottom: "2px",
                            marginLeft: "4px",
                          }}
                        >
                          {msg.author}
                        </div>,
                        null
                      )}
                      <div
                        style={{
                          width: "fit-content",
                          maxWidth: "300px",
                          padding: "10px 14px",
                          borderRadius: "18px",
                          borderBottomRightRadius: "18px",
                          borderBottomLeftRadius: "4px",
                          backgroundColor: "#E5E5EA",
                          color: "#1d1d1f",
                          fontSize: "15px",
                          lineHeight: "1.4",
                        }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  </div>
                )
              );
            })}
          </div>

          {/* Input Area */}
          <div
            style={{
              padding: "0.75rem",
              backgroundColor: "#f0f9ff",
              borderRadius: "8px",
              border: "1px solid #bae6fd",
            }}
          >
            <div
              style={{
                fontSize: "0.875rem",
                fontWeight: "600",
                color: "#0369a1",
                marginBottom: "0.5rem",
              }}
            >
              Chatting as: <strong style={{ color: "#0c4a6e" }}>{myName}</strong>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <ct-input
                $value={contentInput}
                placeholder="Type your message..."
                style="flex: 1;"
                timingStrategy="immediate"
                onct-submit={sendMessage({ messages, myName, contentInput })}
              />
              <ct-button onClick={sendMessage({ messages, myName, contentInput })}>
                Send
              </ct-button>
            </div>
          </div>
        </div>

        {/* Users Sidebar */}
        <div
          style={{
            width: "80px",
            padding: "1rem",
            backgroundColor: "#f9fafb",
            borderLeft: "1px solid #e5e7eb",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: "600",
              color: "#6b7280",
              textAlign: "center",
              marginBottom: "0.5rem",
            }}
          >
            USERS
          </div>
          {users.map((user) => (
            <div
              title={user.name}
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                backgroundColor: user.color,
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "600",
                fontSize: "14px",
                margin: "0 auto",
                cursor: "default",
              }}
            >
              {derive(user, (u: User) => getInitials(u.name))}
            </div>
          ))}

        </div>
      </div>
    ),
    myName,
  };
});

// ============================================================================
// Wire up the forward declaration
// ============================================================================

createRoomAndNavigate = (
  chatName: string,
  messages: Cell<Message[]>,
  users: Cell<User[]>,
  myName: string
) => {
  const roomInstance = GroupChatRoom({ chatName, messages, users, myName });
  return navigateTo(roomInstance);
};

export default GroupChatLobby;
