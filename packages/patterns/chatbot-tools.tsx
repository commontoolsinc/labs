/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
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
  list: Default<Array<ListItem>, []>;
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
  addMessage.send({
    role: "user",
    content: [{ type: "text", text: event.detail.message }],
  });
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

/*** Tools ***/

const calculator = recipe<
  { expression: string; result: Cell<string> },
  { result: Cell<string> }
>("Calculator", ({ expression }) => {
  return derive(expression, (expr) => {
    const sanitized = expr.replace(/[^0-9+\-*/().\s]/g, "");
    let result;
    try {
      result = Function(`"use strict"; return (${sanitized})`)();
    } catch (error) {
      result = { error: (error as any)?.message || "<error>" };
    }
    return result;
  });
});

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

type SearchWebResult = {
  results: {
    title: string;
    url: string;
    description: string;
  }[];
};

const searchWeb = recipe<
  { query: string },
  SearchWebResult | { error: string }
>("Search Web", ({ query }) => {
  const { result, error } = fetchData<SearchWebResult>({
    url: "/api/agent-tools/web-search",
    mode: "json",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: 5,
      }),
    },
  });

  // TODO(seefeld): Should we instead return { result, error }? Or allocate a
  // special [ERROR] for errors? Ideally this isn't specific to using recipes as
  // tools but a general pattern.
  return ifElse(error, { error }, result);
});

type ReadWebResult = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    word_count: number;
  };
};

const readWebpage = recipe<
  { url: string },
  ReadWebResult | { error: string }
>("Read Webpage", ({ url }) => {
  const { result, error } = fetchData<ReadWebResult>({
    url: "/api/agent-tools/web-read",
    mode: "json",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        max_tokens: 4000,
        include_code: true,
      }),
    },
  });

  return ifElse(error, { error }, result);
});

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat, list }) => {
    const model = cell<string>("anthropic:claude-sonnet-4-0");
    const tools = {
      search_web: {
        description: "Search the web for information.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The query to search the web for.",
            },
          },
          required: ["query"],
        } as JSONSchema,
        pattern: searchWeb,
      },
      read_webpage: {
        description: "Read and extract content from a specific webpage URL.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "The URL of the webpage to read and extract content from.",
            },
          },
          required: ["url"],
        } as JSONSchema,
        pattern: readWebpage,
      },
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
        pattern: calculator,
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

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages: chat,
      tools: tools,
      model,
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

    const { result } = fetchData({
      url: "/api/ai/llm/models",
      mode: "json",
    });

    const items = derive(result, (models) => {
      if (!models) return [];

      console.log("[LLM] Models:", models);
      const items = Object.keys(models as any).map((key) => ({
        label: key,
        value: key,
      }));

      console.log("[LLM] Items:", items);
      return items;
    });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <ct-button
              id="clear-chat-button"
              onClick={clearChat({
                chat,
                llmResponse: { pending },
              })}
            >
              Clear Chat
            </ct-button>

            <div>
              <ct-select
                items={items}
                $value={model}
              />
            </div>
          </ct-hstack>

          <ct-autolayout tabNames={["Chat", "Tools"]}>
            <ct-screen>
              <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
                <ct-chat $messages={chat} pending={pending} tools={tools} />
              </ct-vscroll>

              <div slot="footer">
                {ifElse(
                  pending,
                  <ct-button onClick={cancelGeneration}>Cancel</ct-button>,
                  <ct-message-input
                    name="Ask"
                    placeholder="Ask the LLM a question..."
                    appearance="rounded"
                    disabled={pending}
                    onct-send={sendMessage({ addMessage })}
                  />,
                )}
              </div>
            </ct-screen>

            <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
              <ct-vstack data-label="Tools">
                <div>
                  <h3>Items</h3>
                  <ct-list $value={list} />
                </div>
              </ct-vstack>
            </ct-vscroll>
          </ct-autolayout>
        </ct-screen>
      ),
      chat,
    };
  },
);
