/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  recipe,
  str,
  Stream,
  UI,
} from "commontools";

type ListItem = {
  title: string;
};

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<BuiltInLLMMessage>, []>;
  chatSessions: Default<Array<Array<BuiltInLLMMessage>>, []>;
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

const sendMessage = handler<
  { detail: { message: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    chatSessions: Cell<Array<Array<BuiltInLLMMessage>>>;
    chat: Cell<Array<BuiltInLLMMessage>>;
  }
>((event, { addMessage, chatSessions, chat }) => {
  console.log("[sendMessage] Message sent:", event.detail.message);

  addMessage.send({ role: "user", content: event.detail.message });

  // Ensure the current chat is in sessions (by reference) and bump list ref for reactivity
  const sessions = chatSessions.get();
  const currentChat = chat.get();
  const alreadyPresent = sessions.some((session) => session === currentChat);
  if (!alreadyPresent) {
    console.log("[sendMessage] adding chat to sessions (by ref)");
    chatSessions.set([...sessions, currentChat as any]);
  } else {
    chatSessions.set([...sessions]);
    console.log(
      "[sendMessage] chat already present in sessions (by ref), bumped list ref",
    );
  }
});

const clearChat = handler(
  (
    _: never,
    { chat, llmResponse }: {
      chat: Cell<Array<BuiltInLLMMessage>>;
      llmResponse: {
        pending: Cell<boolean>;
      };
    },
  ) => {
    chat.set([]);
    llmResponse.pending.set(false);
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat, chatSessions }) => {
    // Remove the recipe body code that tries to read chat.get()
    // Just use the derive block

    // Use derive to add this chat to the chatSessions list when chat changes
    // derive(chat, (chatMessages) => {
    //   console.log(
    //     "[CHAT derive] chatMessages changed, length:",
    //     chatMessages.length,
    //   );
    //   // Only add once per chat (by reference)
    //   if (chatMessages.length > 0) {
    //     console.log("[CHAT derive] nonzero length chatMessages");
    //     const sessions = chatSessions.get();
    //     const alreadyPresent = sessions.some((session) =>
    //       session === chatMessages
    //     );
    //     if (!alreadyPresent) {
    //       console.log("[CHAT derive] adding chat to sessions (by ref)");
    //       chatSessions.set([...sessions, chatMessages as any]);
    //     } else {
    //       // Bump reference so launcher re-derives and re-renders message lists
    //       chatSessions.set([...sessions]);
    //       console.log(
    //         "[CHAT derive] chat already present in sessions (by ref), bumped list ref",
    //       );
    //     }
    //   }
    // });

    const calculatorResult = cell<string>("");

    const { addMessage, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages: chat,
    });

    // Debug logging
    // derive(chat, (c) => {
    //   console.log("[CHAT] Messages:", c.length);
    //   if (c.length > 0) {
    //     const last = c[c.length - 1];
    //     console.log(
    //       "[CHAT] Last message:",
    //       last.role,
    //       typeof last.content === "string"
    //         ? last.content.substring(0, 50) + "..."
    //         : last.content,
    //     );
    //   }
    // });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <h2 slot="header">{title}</h2>

          <ct-vscroll
            showScrollbar
            fadeEdges
            snapToBottom
            flex
          >
            {chat.map((msg) => {
              return (
                <ct-chat-message
                  role={msg.role}
                  content={msg.content}
                />
              );
            })}
            {ifElse(
              pending,
              <ct-chat-message
                role="assistant"
                content="..."
              />,
              null,
            )}
          </ct-vscroll>

          <div slot="footer">
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={pending}
              onct-send={sendMessage({ addMessage, chatSessions, chat })}
            />

            <ct-button
              id="clear-chat-button"
              onClick={clearChat({
                chat,
                llmResponse: { pending },
              })}
            >
              Clear Chat
            </ct-button>
          </div>
        </ct-screen>
      ),
      chat,
    };
  },
);
