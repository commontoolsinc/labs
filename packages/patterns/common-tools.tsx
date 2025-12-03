/// <cts-enable />
import {
  BuiltInLLMTool,
  Cell,
  compileAndRun,
  computed,
  derive,
  fetchData,
  fetchProgram,
  handler,
  ifElse,
  navigateTo,
  recipe,
} from "commontools";

///// COMMON TOOLS (get it?) ////

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;
  /** The base to use for the calculation. */
  base?: number;
};

export const calculator = recipe<
  CalculatorRequest,
  string | { error: string }
>(({ expression, base }) => {
  return derive({ expression, base }, ({ expression, base }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, "");
    let sanitizedBase = Number(base);
    if (
      Number.isNaN(sanitizedBase) || sanitizedBase < 2 || sanitizedBase > 36
    ) {
      sanitizedBase = 10;
    }
    let result;
    try {
      result = Function(
        `"use strict"; return Number(${sanitized}).toString(${sanitizedBase})`,
      )();
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
>(({ query }) => {
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
>(({ url }) => {
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

export default recipe<ToolsInput>(({ list }) => {
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

/**
 * `fetchAndRunPattern({ url: "https://...", args: {} })`
 *
 * Instantiates patterns (e.g. from listPatternIndex) and returns the cell that
 * contains the results. The instantiated pattern will keep running and updating
 * the cell. Pass the resulting cell to `navigateTo` to show the pattern's UI.
 *
 * Pass in arguments to initialize the pattern. It's especially useful to pass
 * in links to other cells as `{ "@link": "/of:bafe.../path/to/data" }`.
 */
type FetchAndRunPatternInput = {
  url: string;
  args: Cell<any>;
};
export const fetchAndRunPattern = recipe<FetchAndRunPatternInput>(
  ({ url, args }) => {
    const { pending: _fetchPending, result: program, error: _fetchError } =
      fetchProgram({ url });

    // Use derive to safely handle when program is undefined/pending
    const compileParams = derive(program, (p) => ({
      files: p?.files ?? [],
      main: p?.main ?? "",
      input: args,
    }));

    const { pending, result, error } = compileAndRun(compileParams);

    return ifElse(
      computed(() => pending || (!result && !error)),
      undefined,
      {
        cell: result,
        error,
      },
    );
  },
);

/**
 * `navigateTo({ cell: { "@link": "/of:xyz" } })` - Navigates to that cell's UI
 *
 * Especially useful after instantiating a pattern with fetchAndRunPattern:
 * Pass the "@link" you get at `cell` to navigate to the pattern's view.
 */
type NavigateToPatternInput = { cell: Cell<any> }; // Hack to steer LLM
export const navigateToPattern = recipe<NavigateToPatternInput>(
  ({ cell }) => {
    const success = navigateTo(cell);

    return ifElse(success, { success }, undefined);
  },
);

/**
 * `listPatternIndex()` - Returns the index of patterns.
 *
 * Useful as input to fetchAndRun.
 */
type ListPatternIndexInput = Record<string, never>;

export const listPatternIndex = recipe<ListPatternIndexInput>(
  ({ _ }) => {
    const { pending, result } = fetchData({
      url: "/api/patterns/index.md",
      mode: "text",
    });
    return ifElse(computed(() => pending || !result), undefined, { result });
  },
);
