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
  lift,
  llm,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

const calculator = handler<{ expression: string }, { result: Cell<string> }>(
  (args, state) => {
    try {
      // Simple calculator - only allow basic operations for security
      const sanitized = args.expression.replace(/[^0-9+\-*/().\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      state.result.set(`${args.expression} = ${result}`);
    } catch (error) {
      state.result.set(
        `Error calculating ${args.expression}: ${
          (error as any)?.message || "<error>"
        }`,
      );
    }
  },
);

const sendMessage = handler<
  { detail: { message: string } },
  {
    chat: Cell<Array<BuiltInLLMMessage>>;
  }
>((event, { chat }) => {
  chat.push({ role: "user", content: event.detail.message });
});

const clearChat = handler(
  (
    _: never,
    { chat, llmResponse }: {
      chat: Cell<Array<BuiltInLLMMessage>>;
      llmResponse: { result: Cell<string | undefined> };
    },
  ) => {
    chat.set([]);
    llmResponse.result.set(undefined);
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat }) => {
    const calculatorResult = cell<string>("");

    const llmResponse = llm({
      system:
        "You are a helpful assistant with access to a calculator. Use the calculator tool when users ask math questions.",
      messages: chat,
      tools: {
        calculator: {
          description:
            "Calculate the result of a mathematical expression. Supports +, -, *, /, and parentheses.",
          inputSchema: {
            type: "object",
            properties: {
              expression: {
                type: "string",
                description:
                  "The mathematical expression to evaluate (e.g., '2 + 3 * 4')",
              },
            },
            required: ["expression"],
          },
          handler: calculator({ result: calculatorResult }),
        },
      },
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h2>{title}</h2>

          <ct-vscroll showScrollbar height="320px" fadeEdges snapToBottom>
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
              null
            )}
          </ct-vscroll>

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={llmResponse.pending}
              onct-send={sendMessage({
                chat,
              })}
            />

            <ct-button
              onClick={clearChat({
                chat,
                llmResponse: { result: llmResponse.result },
              })}
            >
              Clear Chat
            </ct-button>

            <pre>{calculatorResult}</pre>
          </div>
        </div>
      ),
      chat,
    };
  },
);
