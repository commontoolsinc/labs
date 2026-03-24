/// <cts-enable />
import {
  computed,
  handler,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  schema,
  str,
  type Stream,
} from "commonfabric";
import "commonfabric/schema";

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
  search: PatternToolResult<{ source: string }>;
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
    { query, help, source }: { query: string; help?: string; source: string },
  ) => {
    const helpValue = computed(() => help ?? "");
    return {
      query,
      help: helpValue,
      source,
      summary: str`${source}:${query}:${helpValue}`,
    };
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      help: { type: "string" },
      source: { type: "string" },
    },
    required: ["query", "source"],
  },
  {
    type: "object",
    properties: {
      query: { type: "string" },
      help: { type: "string" },
      source: { type: "string" },
      summary: { type: "string" },
    },
    required: ["query", "help", "source", "summary"],
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
        source: "bound-source",
      }),
    };
  },
  model,
);
