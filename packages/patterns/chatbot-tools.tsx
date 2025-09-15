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

import Chat from "./chatbot.tsx";

type ListItem = {
  title: string;
};

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
  list: Default<Array<ListItem>, []>;
};

type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
};

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
      body: {
        query,
        max_results: 5,
      },
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
      body: {
        url,
        max_tokens: 4000,
        include_code: true,
      },
    },
  });

  return ifElse(error, { error }, result);
});

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, messages, list }) => {
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

    const chat = Chat({ messages, tools });
    const { addMessage, cancelGeneration, pending } = chat;

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <ct-input
              $value={title}
              placeholder="Enter title..."
            />
          </ct-hstack>

          <ct-autolayout tabNames={["Chat", "Tools"]}>
            {chat}

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
      messages,
    };
  },
);
