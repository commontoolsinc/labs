/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  JSONSchema,
  Default,
  derive,
  h,
  handler,
  ifElse,
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
  list: Default<Array<ListItem>, []>;
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

const calculator = handler<
  { expression: string; result: Cell<string> },
  { result: Cell<string> }
>(
  (args, state) => {
    try {
      // Simple calculator - only allow basic operations for security
      const sanitized = args.expression.replace(/[^0-9+\-*/().\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      args.result.set(`${args.expression} = ${result}`);
      state.result.set(`${args.expression} = ${result}`);
    } catch (error) {
      args.result.set(
        `Error calculating ${args.expression}: ${
          (error as any)?.message || "<error>"
        }`,
      );
      state.result.set(
        `Error calculating ${args.expression}: ${
          (error as any)?.message || "<error>"
        }`,
      );
    }
  },
);

const addListItem = handler<
  { item: string; result: Cell<string> },
  { list: Cell<ListItem[]> }
>(
  (args, state) => {
    try {
      state.list.push({ title: args.item });
      args.result.set(`${state.list.get().length} items`);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

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
  ({ title, chat, list }) => {
    const calculatorResult = cell<string>("");

    const tools = {
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
        } as JSONSchema,
        handler: calculator({ result: calculatorResult }),
      },
      addListItem: {
        description: "Add an item to the list.",
        inputSchema: {
          type: "object",
          properties: {
            item: {
              type: "string",
              description: "The item to add to the list.",
            },
          },
          required: ["item"],
        } as JSONSchema,
        handler: addListItem({ list }),
      },
    };

    const { addMessage, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages: chat,
      tools: tools,
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
        <div>
          <h2>{title}</h2>

          <ct-vscroll showScrollbar height="320px" fadeEdges snapToBottom>
            {chat.map((msg) => {
              return (
                <ct-chat-message
                  role={msg.role}
                  content={msg.content}
                  tools={tools}
                  toolCalls={msg.toolCalls}
                  toolResults={msg.toolResults}
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

          <div>
            <ct-message-input
              name="Ask"
              placeholder="Ask the LLM a question..."
              appearance="rounded"
              disabled={pending}
              onct-send={sendMessage({ addMessage })}
            />

            <ct-button
              onClick={clearChat({
                chat,
                llmResponse: { pending },
              })}
            >
              Clear Chat
            </ct-button>

            <pre>{calculatorResult}</pre>

            <ct-list $value={list} />
          </div>
        </div>
      ),
      chat,
    };
  },
);
