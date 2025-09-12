/// <cts-enable />
import {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  h,
  handler,
  ifElse,
  llmDialog,
  NAME,
  recipe,
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

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;
};

const calculator = recipe<
  CalculatorRequest,
  string | { error: string }
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

/** Add an item to the list. */
type AddListItemRequest = {
  /** The item to add to the list. */
  item: string;
  result: Cell<string>;
};

const addListItem = handler<
  AddListItemRequest,
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

/** Search the web for information. */
type SearchQuery = {
  /** The query to search the web for. */
  query: string;
};

type SearchWebResult = {
  results: {
    title: string;
    url: string;
    description: string;
  }[];
};

const searchWeb = recipe<
  SearchQuery,
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

/** Read and extract content from a specific webpage URL. */
type ReadWebRequest = {
  /** The URL of the webpage to read and extract content from. */
  url: string;
};

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
  ReadWebRequest,
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
    const tools: Record<string, BuiltInLLMTool> = {
      search_web: {
        pattern: searchWeb,
      },
      read_webpage: {
        pattern: readWebpage,
      },
      calculator: {
        pattern: calculator,
      },
      addListItem: {
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
