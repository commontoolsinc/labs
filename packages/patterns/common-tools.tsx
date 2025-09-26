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

///// COMMON TOOLS (get it?) ////

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;
};

export const calculator = recipe<
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

/** Read all items from the list. */
type ReadListItemsRequest = {
  result: Cell<string>;
};

export type ListItem = {
  title: string;
};

export const addListItem = handler<
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

export const readListItems = handler<
  ReadListItemsRequest,
  { list: ListItem[] }
>(
  (args, state) => {
    try {
      const items = state.list;
      if (items.length === 0) {
        args.result.set("The list is empty");
      } else {
        const itemList = items.map((item, index) =>
          `${index + 1}. ${item.title}`
        ).join("\n");
        args.result.set(`List items (${items.length} total):\n${itemList}`);
      }
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

export const searchWeb = recipe<
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

export const readWebpage = recipe<
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

type ToolsInput = {
  list: ListItem[];
};

export default recipe<ToolsInput>("Tools", ({ list }) => {
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

  return { tools, list };
});
