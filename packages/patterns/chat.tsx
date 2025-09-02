/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  lift,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type ChatMessage = { role: string; content: string };

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<ChatMessage>, []>;
};

type LLMTestResult = {
  chat: Default<Array<ChatMessage>, []>;
};

const sendMessage = handler<
  { detail: { message: string } },
  { chat: Cell<Array<ChatMessage>>; lastLlmResponse: string | undefined }
>((event, { chat, lastLlmResponse: response }) => {
  if (response) {
    chat.push({ role: "assistant", content: response });
  }
  chat.push({ role: "user", content: event.detail.message });
});

const clearChat = handler(
  (_: never, { chat }: { chat: Cell<Array<ChatMessage>> }) => {
    chat.set([]);
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat }) => {
    const llmResponse = llm({
      system:
        "You are a helpful assistant. Answer questions clearly and concisely.",
      messages: chat.map((c) => c.content),
    });

    return {
      [NAME]: title,
      [UI]: (
        <div style="display: flex; flex-direction: column; height: 100%;">
          <h2 style="margin: 0 0 1rem 0; padding: 0 1rem;">{title}</h2>

          <ct-vscroll
            showScrollbar
            fadeEdges
            snapToBottom
            style="flex: 1; min-height: 0;"
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
              llmResponse.pending,
              <ct-chat-message
                role="assistant"
                content={ifElse(
                  llmResponse.partial,
                  llmResponse.partial,
                  "...",
                )}
              />,
              derive(llmResponse.result, (result) =>
                result
                  ? (
                    <ct-chat-message
                      role="assistant"
                      content={result}
                    />
                  )
                  : null),
            )}
          </ct-vscroll>

          <div style="padding: 1rem; border-top: 1px solid #e0e0e0;">
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={llmResponse.pending}
              onct-send={sendMessage({
                chat,
                lastLlmResponse: llmResponse.result,
              })}
            />

            <ct-button
              onClick={clearChat({ chat })}
            >
              Clear Chat
            </ct-button>
          </div>
        </div>
      ),
      chat,
    };
  },
);
