/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  getRecipeEnvironment,
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

const searchWeb = handler<
  { query: string; result: Cell<string> },
  { result: Cell<string> }
>(
  async (args, state) => {
    try {
      state.result.set(`Searching: ${args.query}...`);

      const env = getRecipeEnvironment();
      const response = await fetch(
        new URL("/api/agent-tools/web-search", env.apiUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: args.query,
            max_results: 5,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();

      // Format the search results
      const formattedResults = data.results
        .map((r: any, i: number) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
        )
        .join("\n\n");

      state.result.set(formattedResults || "No results found");
      args.result.set(formattedResults || "No results found");
    } catch (error) {
      const errorMsg = `Search error: ${
        (error as any)?.message || "Unknown error"
      }`;
      state.result.set(errorMsg);
      args.result.set(errorMsg);
    }
  },
);

const readWebpage = handler<
  { url: string; result: Cell<string> },
  { result: Cell<string> }
>(
  async (args, state) => {
    try {
      state.result.set(`Reading: ${args.url}...`);

      const env = getRecipeEnvironment();
      const response = await fetch(
        new URL("/api/agent-tools/web-read", env.apiUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: args.url,
            max_tokens: 4000,
            include_code: true,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to read webpage: ${response.statusText}`);
      }

      const data = await response.json();

      // Format the content with metadata
      const formattedContent = `Title: ${data.metadata?.title || "Unknown"}\n` +
        `Date: ${data.metadata?.date || "Unknown"}\n` +
        `Word Count: ${data.metadata?.word_count || 0}\n\n` +
        `Content:\n${data.content?.substring(0, 2000)}${
          data.content?.length > 2000 ? "..." : ""
        }`;

      state.result.set(formattedContent);
      args.result.set(formattedContent);
    } catch (error) {
      const errorMsg = `Read error: ${
        (error as any)?.message || "Unknown error"
      }`;
      state.result.set(errorMsg);
      args.result.set(errorMsg);
    }
  },
);
export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat, list }) => {
    const calculatorResult = cell<string>("");
    const model = cell<string>("anthropic:claude-sonnet-4-20250514");
    const searchWebResult = cell<string>("");
    const readWebpageResult = cell<string>("");

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
        handler: searchWeb({ result: searchWebResult }),
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
        handler: readWebpage({ result: readWebpageResult }),
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
                {chat.map((msg) => {
                  return (
                    <ct-chat-message
                      role={msg.role}
                      content={msg.content}
                      tools={tools}
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

              <div slot="footer">
                <ct-message-input
                  name="Ask"
                  placeholder="Ask the LLM a question..."
                  appearance="rounded"
                  disabled={pending}
                  onct-send={sendMessage({ addMessage })}
                />
              </div>
            </ct-screen>

            <ct-vstack data-label="Tools">
              <div>
                <h3>Web Search</h3>
                <pre>{searchWebResult}</pre>
              </div>

              <div>
                <h3>Web Page Reader</h3>
                <pre>{readWebpageResult}</pre>
              </div>

              <div>
                <h3>Calculator</h3>
                <pre>{calculatorResult}</pre>
              </div>

              <div>
                <h3>Items</h3>
                <ct-list $value={list} />
              </div>
            </ct-vstack>
          </ct-autolayout>
        </ct-screen>
      ),
      chat,
    };
  },
);
