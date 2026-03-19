/// <cts-enable />
import {
  computed,
  handler,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  schema,
  type Stream,
} from "commontools";
import "commontools/schema";

interface Input {
  lastMessage: string;
  messageCount: number;
  legacyCount: number;
  messages: string[];
}

interface Output {
  [NAME]: string;
  lastMessage: string;
  messageCount: number;
  legacyCount: number;
  messages: string[];
  recordMessage: Stream<{ message: string }>;
  legacyWrite: Stream<Record<string, never>>;
  search: PatternToolResult<{ messages: string[] }>;
}

const model = schema({
  type: "object",
  properties: {
    lastMessage: { type: "string", default: "", asCell: true },
    messageCount: { type: "number", default: 0, asCell: true },
    legacyCount: { type: "number", default: 0, asCell: true },
    messages: {
      type: "array",
      items: { type: "string" },
      default: [],
      asCell: true,
    },
  },
  default: {
    lastMessage: "",
    messageCount: 0,
    legacyCount: 0,
    messages: [],
  },
});

const recordMessage = handler(
  {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
  model,
  ({ message }, state) => {
    state.lastMessage.set(message);
    state.messageCount.set(state.messageCount.get() + 1);
    state.messages.push(message);
  },
);

const legacyWrite = handler(
  {
    type: "object",
    properties: {},
  },
  model,
  (_event, state) => {
    state.legacyCount.set(state.legacyCount.get() + 1);
  },
);

const searchTool = pattern(
  (
    { query, messages }: { query: string; messages: string[] },
  ) => {
    const results = computed(() => {
      const q = query.toLowerCase();
      return messages.filter((m) => m.toLowerCase().includes(q));
    });
    return {
      query,
      results,
      count: computed(() => results.length),
    };
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      messages: { type: "array", items: { type: "string" } },
    },
    required: ["query", "messages"],
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      results: { type: "array", items: { type: "string" } },
      count: { type: "number" },
    },
    required: ["query", "results", "count"],
  },
);

export const customPatternExport = pattern<Input, Output>(
  (cell) => {
    return {
      [NAME]: "Fuse Exec Fixture",
      lastMessage: cell.lastMessage,
      messageCount: cell.messageCount,
      legacyCount: cell.legacyCount,
      messages: cell.messages,
      recordMessage: recordMessage(cell),
      legacyWrite: legacyWrite(cell),
      search: patternTool(searchTool, {
        messages: cell.messages,
      }),
    };
  },
  model,
);
