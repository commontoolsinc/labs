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
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

const sendMessage = handler<
  { detail: { message: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((event, { addMessage }) => {
  addMessage.send({ role: "user", content: event.detail.message });
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
  ({ title, chat }) => {
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
          <h2 slot="header" style={{ margin: 0, padding: "1rem" }}>{title}</h2>

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

          <div
            slot="footer"
            style={{ borderTop: "1px solid #e0e0e0", padding: "1rem" }}
          >
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={pending}
              onct-send={sendMessage({ addMessage })}
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
