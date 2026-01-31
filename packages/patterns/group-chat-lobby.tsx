/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";
import GroupChatRoom, { Message, User } from "./group-chat-room.tsx";

/**
 * Group Chat Lobby Pattern
 *
 * Apple iOS-style lobby where unlimited users can join.
 * Shows all joined users and a form for new users.
 */

interface LobbyInput {
  chatName: Default<string, "Group Chat">;
  messages: Writable<Default<Message[], []>>;
  users: Writable<Default<User[], []>>;
  sessionId: Writable<Default<string, "">>;
}

interface LobbyOutput {
  chatName: Default<string, "Group Chat">;
  messages: Writable<Default<Message[], []>>;
  users: Writable<Default<User[], []>>;
  sessionId: Writable<Default<string, "">>;
}

// Random color selection from a pool of distinct colors
function getRandomColor(): string {
  const colors = [
    "#007AFF", // Apple blue
    "#34C759", // Apple green
    "#FF9500", // Apple orange
    "#AF52DE", // Apple purple
    "#FF3B30", // Apple red
    "#5856D6", // Apple indigo
    "#FF2D55", // Apple pink
    "#00C7BE", // Apple teal
  ];
  return colors[
    Math.floor(
      secureRandom() *
        colors.length,
    )
  ];
}

// Get initials from name
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

// Handler to reset the lobby (clear all state and generate new session)
const resetLobby = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    users: Writable<User[]>;
    sessionId: Writable<string>;
  }
>((_event, { messages, users, sessionId }) => {
  console.log("[resetLobby] Resetting all chat state...");
  // Generate new session ID to invalidate all existing chat room connections
  const newSessionId = `session-${randomUUID()}`;
  sessionId.set(newSessionId);
  messages.set([]);
  users.set([]);
  console.log(
    "[resetLobby] Chat state reset complete, new session:",
    newSessionId,
  );
});

// Handler for joining the chat
const joinChat = handler<
  unknown,
  {
    chatName: string;
    messages: Writable<Message[]>;
    users: Writable<User[]>;
    sessionId: Writable<string>;
    nameInput: Writable<string>;
  }
>((_event, { messages, users, sessionId, nameInput }) => {
  const name = nameInput.get().trim();
  if (!name) {
    console.log("[joinChat] No name entered, returning");
    return;
  }
  console.log("[joinChat] Name:", name);

  // Initialize session ID if not set (first user joining)
  let currentSessionId = sessionId.get();
  if (!currentSessionId) {
    currentSessionId = `session-${randomUUID()}`;
    sessionId.set(currentSessionId);
    console.log("[joinChat] Initialized new session:", currentSessionId);
  }

  // Get existing users
  const existingUsers = users.get() || [];

  // Check if user already exists
  const existingUser = existingUsers.find((u) => u.name === name);
  if (!existingUser) {
    // Create new user and add to list
    const newUser: User = {
      name,
      joinedAt: Temporal.Now.instant().epochMilliseconds,
      color: getRandomColor(),
    };
    users.set([...existingUsers, newUser]);
    console.log("[joinChat] User added:", name);

    // Add system message for join
    const existingMessages = messages.get() || [];
    messages.set([
      ...existingMessages,
      {
        id: `msg-${randomUUID()}`,
        author: "System",
        content: `${name} joined the chat`,
        timestamp: Temporal.Now.instant().epochMilliseconds,
        type: "system",
        reactions: [],
      },
    ]);
  }

  // Clear the name input
  nameInput.set("");

  // Create chat room instance and navigate
  // Pass both the session ID at join time (mySessionId) and the Cell reference to check against (currentSessionId)
  console.log(
    "[joinChat] Navigating to chat room with session:",
    currentSessionId,
  );
  const roomInstance = GroupChatRoom({
    messages,
    users,
    myName: name,
    mySessionId: currentSessionId,
    currentSessionId: sessionId,
  });

  return navigateTo(roomInstance);
});

export default pattern<LobbyInput, LobbyOutput>(
  ({ chatName, messages, users, sessionId }) => {
    // Name input for new users
    const nameInput = Writable.of("");

    // Note: Use direct property access to avoid transformer bug
    // with || [] fallback (see computed-var-then-map.issue.md)
    const userCount = computed(() => users.get().length);

    return {
      [NAME]: computed(() => `${chatName} - Lobby`),
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            backgroundColor: "#f2f2f7",
          }}
        >
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
            <h1
              style={{
                marginBottom: "0.5rem",
                color: "#1c1c1e",
                fontSize: "2.5rem",
                fontWeight: "700",
                letterSpacing: "-0.02em",
              }}
            >
              {chatName}
            </h1>
            <p
              style={{
                marginBottom: "2rem",
                color: "#8e8e93",
                fontSize: "1.1rem",
              }}
            >
              Enter your name to join the conversation
            </p>

            {/* Join Form Card */}
            <div
              style={{
                width: "320px",
                padding: "1.5rem",
                backgroundColor: "white",
                borderRadius: "16px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                marginBottom: "1.5rem",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "500",
                  color: "#8e8e93",
                  marginBottom: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Join as
              </div>
              <ct-input
                $value={nameInput}
                placeholder="Your name"
                style="width: 100%; margin-bottom: 1rem;"
                timingStrategy="immediate"
                onct-submit={joinChat({
                  chatName,
                  messages,
                  users,
                  sessionId,
                  nameInput,
                })}
              />
              <button
                type="button"
                style={{
                  width: "100%",
                  padding: "0.75rem 1.5rem",
                  fontSize: "1rem",
                  backgroundColor: "#007AFF",
                  color: "white",
                  fontWeight: "600",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                }}
                onClick={joinChat({
                  chatName,
                  messages,
                  users,
                  sessionId,
                  nameInput,
                })}
              >
                Join Chat
              </button>
            </div>

            {/* Active Users Section */}
            {ifElse(
              userCount,
              <div
                style={{
                  width: "320px",
                  padding: "1rem 1.5rem",
                  backgroundColor: "white",
                  borderRadius: "16px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: "500",
                    color: "#8e8e93",
                    marginBottom: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Now chatting
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  {users.map((user) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        padding: "0.5rem 0.75rem",
                        backgroundColor: "#f2f2f7",
                        borderRadius: "20px",
                      }}
                    >
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          backgroundColor: user.color,
                          color: "white",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: "600",
                          fontSize: "11px",
                        }}
                      >
                        {computed(() => user ? getInitials(user.name) : "?")}
                      </div>
                      <span
                        style={{
                          fontSize: "0.875rem",
                          fontWeight: "500",
                          color: "#1c1c1e",
                        }}
                      >
                        {user.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>,
              <></>,
            )}

            {/* Reset Button */}
            <button
              type="button"
              style={{
                marginTop: "1.5rem",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                background: "none",
                color: "#8e8e93",
                fontWeight: "400",
                border: "none",
                cursor: "pointer",
              }}
              onClick={resetLobby({ messages, users, sessionId })}
            >
              Reset
            </button>
          </div>
        </div>
      ),
      chatName,
      messages,
      users,
      sessionId,
    };
  },
);
