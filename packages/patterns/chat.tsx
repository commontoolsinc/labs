/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  llm,
  NAME,
  lift,
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
  { chat: Cell<Array<ChatMessage>>; response: string | undefined }
>((event, { chat, response }) => {
  if (response) {
    chat.push(response);
  }
  chat.push(event.detail.message);
});

const prefix = lift((idx: number) => {
  return idx % 2 === 0 ? 'User' : 'Assistant';
});

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat }) => {
    const llmResponse = llm({
      system:
        "You are a helpful assistant. Answer questions clearly and concisely.",
      messages: chat,
    });

    // derive(llmResponse.result, (result) => {
    //   console.log('[x]', result)
    // });

    // derive(llmResponse.partial, (result) => {
    //   console.log('[y]', result)
    // });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h2>{title}</h2>
          <ul>
            {chat.map((msg, idx) => {
              return <li key={msg}><strong>{prefix(idx)}:</strong>{" "}{msg}</li>;
            })}
            {derive(llmResponse.partial, (result) =>
              result
                ? (<li><strong>{prefix(1)}:</strong>{" "}{result}</li>)
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
