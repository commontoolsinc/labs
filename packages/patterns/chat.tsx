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

const calculator = handler<{ expression: string }, {}>((args) => {
  try {
    // Simple calculator - only allow basic operations for security
    const sanitized = args.expression.replace(/[^0-9+\-*/().\s]/g, "");
    const result = Function(`"use strict"; return (${sanitized})`)();
    return `${args.expression} = ${result}`;
  } catch (error) {
    return `Error calculating ${args.expression}: ${
      (error as any)?.message || "<error>"
    }`;
  }
});

const sendMessage = handler<
  { detail: { message: string } },
  {
    chat: Cell<Array<BuiltInLLMMessage>>;
    lastLlmResponse: Partial<BuiltInLLMMessage>;
  }
>((event, { chat, lastLlmResponse: response }) => {
  if (response.content) {
    chat.push({ role: "assistant", content: response.content as any });
  }
  chat.push({ role: "user", content: event.detail.message });
});

const clearChat = handler(
  (_: never, { chat, llmResponse }: { chat: Cell<Array<BuiltInLLMMessage>>, llmResponse: { result: Cell<string | undefined> } }) => {
    chat.set([]);
    llmResponse.result.set(undefined);
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat }) => {
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
          handler: calculator,
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

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={llmResponse.pending}
              onct-send={sendMessage({
                chat,
                lastLlmResponse: {
                  role: "assistant",
                  content: llmResponse.result,
                },
              })}
            />

            <ct-button
              onClick={clearChat({ chat, llmResponse: { result: llmResponse.result } })}
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
