/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  ifElse,
  handler,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type ChatMessage = string;

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<ChatMessage>, []>;
};

type LLMTestResult = {
  chat: Default<Array<ChatMessage>, []>;
};

const askQuestion = handler<
  { detail: { message: string } },
  { chat: Cell<Array<ChatMessage>>, response: string | undefined }
>((event, { chat, response }) => {
  if (response) {
    chat.push(response);
  }
  chat.push(event.detail.message);
});

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat }) => {
    const llmResponse = llm({
      system:
        "You are a helpful assistant. Answer questions clearly and concisely.",
      messages: chat,
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h2>{title}</h2>

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              onct-send={askQuestion({ chat, response: llmResponse.result })}
            />
          </div>

          <ul>
          {chat.map(msg => {
            return <li>{msg}</li>;
          })}
          <li>{ifElse(llmResponse.pending, '...', llmResponse.result)}</li>
          </ul>
        </div>
      ),
      chat
    };
  },
);
