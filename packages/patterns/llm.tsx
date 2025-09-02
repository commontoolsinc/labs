/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
};

type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
};

const sendMessage = handler<
  { detail: { message: string } },
  { messages: Cell<Array<BuiltInLLMMessage>> }
>((event, { messages }) => {
  messages.push({ role: "user", content: event.detail.message });
});

const clearMessages = handler<
  never,
  {
    messages: Cell<Array<BuiltInLLMMessage>>;
    llmResponse: {
      result: Cell<string | undefined>;
      partial: Cell<string | undefined>;
    };
  }
>((_event, { messages, llmResponse }) => {
  messages.set([]);
  llmResponse.result.set(undefined);
  llmResponse.partial.set(undefined);
});

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, messages }) => {
    const llmResponse = llm({
      system:
        "You are a helpful assistant. Answer questions clearly and concisely.",
      messages,
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h2>{title}</h2>

          <ct-vscroll showScrollbar height="320px" fadeEdges snapToBottom>
            {messages.map((msg) => (
              <ct-chat-message role={msg.role} content={msg.content} />
            ))}

            {derive(llmResponse.pending, (pending) =>
              pending
                ? (
                  <ct-chat-message
                    role="assistant"
                    content={derive(llmResponse.partial, (p) => p || "...")}
                  />
                )
                : null)}
          </ct-vscroll>

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              onct-send={sendMessage({ messages })}
            />

            <ct-button
              onClick={clearMessages({
                messages,
                llmResponse: {
                  result: llmResponse.result,
                  partial: llmResponse.partial,
                },
              })}
            >
              Clear Chat
            </ct-button>
          </div>
        </div>
      ),
      messages,
    };
  },
);
