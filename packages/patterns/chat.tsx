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

const askQuestion = handler<
  { detail: { message: string } },
  { chat: Cell<Array<ChatMessage>>; response: string | undefined }
>((event, { chat, response }) => {
  if (response) {
    chat.push({ role: "assistant", content: response });
  }
  chat.push({ role: "user", content: event.detail.message });
});

const prefix = lift((idx: number) => {
  return idx % 2 === 0 ? "User" : "Assistant";
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

    // derive(llmResponse.result, (result) => {
    //   console.log("[x]", result);
    // });

    // derive(llmResponse.partial, (result) => {
    //   console.log("[y]", result);
    // });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h2>{title}</h2>
          <ct-button
            onct-click={clearChat({ chat })}
          >
            Clear Chat
          </ct-button>

          <ul>
            {chat.map((msg, idx) => {
              return (
                <li key={msg}>
                  <strong>{msg.role}:</strong> {msg.content}
                </li>
              );
            })}
            {derive(llmResponse.pending, (pending) =>
              pending
                ? (
                  <li>
                    <strong>assistant:</strong> ...
                  </li>
                )
                : null)}
            {derive(llmResponse.partial, (result) =>
              result
                ? (
                  <li>
                    <strong>assistant:</strong> {result}
                  </li>
                )
                : null)}
          </ul>

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              onct-send={askQuestion({ chat, response: llmResponse.result })}
            />
          </div>
        </div>
      ),
      chat,
    };
  },
);
