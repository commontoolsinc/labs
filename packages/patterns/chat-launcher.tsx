/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";
import Chat from "./chat.tsx";

type ChatSessionMessages = BuiltInLLMMessage[];
type ChatSessions = ChatSessionMessages[];

type MainRecipeInput = {
  title: Default<string, "">;
  chat: Default<ChatSessionMessages, []>;
  chatSessions: Default<ChatSessions, []>;
};

const createChat = handler<
  unknown,
  {
    title: Default<string, "">;
    chat: Default<ChatSessionMessages, []>;
    chatSessions: Cell<ChatSessions>;
  }
>((_, { title, chat, chatSessions }) => {
  console.log(
    "[ChatLauncher] New chat button clicked, title=",
    JSON.stringify(title),
    " chat=",
    JSON.stringify(chat),
  );

  // Create the chat instance with a fresh cell
  const newChatInstance = Chat({
    title: title as any,
    chat: cell([]) as any,
    chatSessions: chatSessions as any,
  });

  console.log(
    "[ChatLauncher] newChatInstance",
    JSON.stringify(newChatInstance),
  );
  // Navigate to the new chat
  return navigateTo(newChatInstance);
});

export default recipe<MainRecipeInput>(
  "Chat Launcher",
  ({ title, chat, chatSessions }) => {
    derive(title, (t) => console.log("title=", t));

    return {
      [NAME]: { title },
      [UI]: (
        <div>
          <h2>title is {title}</h2>
          <div>
            chatSessions length:{" "}
            {derive(chatSessions, (sessions) => sessions.length)}
          </div>
          <div>
            <ct-button onClick={createChat({ title, chat, chatSessions })}>
              New Chat
            </ct-button>
          </div>
          <div>
            <h3>Chat Sessions:</h3>
            {derive(chatSessions, (sessions) =>
              sessions.map((session, index) => (
                <div
                  key={index}
                  style={{
                    margin: "8px 0",
                    padding: "8px",
                    border: "1px solid #ccc",
                  }}
                >
                  <div>Session {index + 1}</div>
                  <div>Messages: {session.length}</div>
                  <div style={{ marginTop: "8px" }}>
                    {session.map((message, msgIndex) => (
                      <div
                        key={msgIndex}
                        style={{
                          margin: "4px 0",
                          padding: "4px",
                          backgroundColor: message.role === "user"
                            ? "#e3f2fd"
                            : "#f5f5f5",
                          borderRadius: "4px",
                          fontSize: "12px",
                        }}
                      >
                        <strong>{message.role}:</strong>{" "}
                        {typeof message.content === "string"
                          ? message.content.length > 80
                            ? message.content.substring(0, 80) + "..."
                            : message.content
                          : JSON.stringify(message.content).length > 80
                          ? JSON.stringify(message.content).substring(0, 80) +
                            "..."
                          : JSON.stringify(message.content)}
                      </div>
                    ))}
                  </div>
                </div>
              )))}
          </div>
        </div>
      ),
      title,
      chat,
      chatSessions,
    };
  },
);
