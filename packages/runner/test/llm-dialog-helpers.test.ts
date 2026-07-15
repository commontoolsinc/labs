import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "commonfabric";
import {
  llmDialogTestHelpers,
  llmToolExecutionHelpers,
} from "../src/builtins/llm-dialog.ts";
import { schemaWithInjectionSafeAnnotations } from "../src/cfc/schema-sanitization.ts";
import type { Cell } from "../src/cell.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const {
  buildAvailableCellsDocumentation,
  buildAvailableCellsDocumentationWithObservation,
  buildToolCatalog,
  executeToolCalls,
  PRESENT_RESULT_TOOL_NAME,
} = llmToolExecutionHelpers;

const {
  parseLLMFriendlyLink,
  extractStringField,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  simplifySchemaForContext,
  prepareSchemaForLLM,
  resolveRefsForLLM,
  serializeForLLMObservation,
  traverseAndCellify,
  toolAllowsObservedConfidentiality,
} = llmDialogTestHelpers;

type ToolResultPartForTest = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
};

type TestCell<T = unknown> = {
  get: () => T;
  getRaw?: () => unknown;
  getMetaRaw?: () => unknown;
  getAsNormalizedFullLink?: () => NormalizedFullLink;
  resolveAsCell?: () => Cell<unknown>;
  asSchemaFromLinks?: () => Cell<unknown>;
  asSchema?: (schema?: JSONSchema) => Cell<unknown>;
  key?: (name: string) => TestCell<unknown>;
  pull?: () => Promise<void>;
  withTx?: (tx: unknown) => TestCell<T> & { set?: (next: T) => void };
  set?: (next: T) => void;
  runtime?: unknown;
  schema?: unknown;
};

type ToolCatalogInput = Parameters<typeof buildToolCatalog>[0];
type CellifyRuntime = Parameters<typeof traverseAndCellify>[0];
type DocumentationRuntime = Parameters<
  typeof buildAvailableCellsDocumentation
>[0];
type DocumentationPinnedCells = Parameters<
  typeof buildAvailableCellsDocumentation
>[3];
type ExecutionRuntime = Parameters<typeof executeToolCalls>[0];
type ExecutionPinnedCells = NonNullable<
  Parameters<typeof executeToolCalls>[4]
>;

function cast<T>(value: unknown): T {
  return value as T;
}

function asCell<T>(cell: TestCell<T>): Cell<T> {
  return cast<Cell<T>>(cell);
}

function asSchema(value: unknown): JSONSchema {
  return cast<JSONSchema>(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(
  value: unknown,
  path: readonly (string | number)[],
): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }

    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function toolResultPart(value: unknown): ToolResultPartForTest {
  assert(isRecord(value));
  assertEquals(value.type, "tool-result");
  return cast<ToolResultPartForTest>(value);
}

function makeDocumentationCell(params: {
  id: `${string}:${string}`;
  space: `did:${string}:${string}`;
  path?: string[];
  schema?: JSONSchema;
  value?: unknown;
  rawValue?: unknown;
  nested?: unknown;
}) {
  const link = {
    id: params.id,
    space: params.space,
    scope: "space" as const,
    path: params.path ?? [],
    schema: params.schema,
  };
  const cell: TestCell<unknown> = {
    runtime: {},
    schema: params.schema,
    get: () => params.value,
    getRaw: () => params.rawValue ?? params.value,
    getMetaRaw: () => undefined,
    getAsNormalizedFullLink: () => link,
    resolveAsCell: () => asCell(cell),
    asSchemaFromLinks: () => asCell(cell),
    asSchema: () => asCell(cell),
    key: () => ({ getRaw: () => undefined, get: () => undefined }),
    pull: () => Promise.resolve(),
  };
  if (params.nested !== undefined) {
    cell.get = () => params.nested;
  }
  return asCell(cell);
}

Deno.test("parseTargetString recognizes handle format", () => {
  const parsed = parseLLMFriendlyLink(
    "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/foo/bar",
    "did:test:123",
  );
  assert(!("error" in parsed));
  if (!("error" in parsed)) {
    assertEquals(
      parsed.id,
      "of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai",
    );
    assertEquals(parsed.path, ["foo", "bar"]);
  }
});

Deno.test("parseTargetString handles whitespace in handle paths", () => {
  const parsed = parseLLMFriendlyLink(
    "  /of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/foo ",
    "did:test:123",
  );
  assertEquals(
    parsed.id,
    "of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai",
  );
  assertEquals(parsed.path, ["foo"]);
});

Deno.test("parseTargetString recognizes ~ encoded path elements", () => {
  const parsed = parseLLMFriendlyLink(
    "/of:baedreidptbmcghfoqcb2xa3l3qsvype5gjcfuektmzdjalfb7yqztjda5q/foo~1bar/~0/",
    "did:test:123",
  );
  assertEquals(
    parsed.id,
    "of:baedreidptbmcghfoqcb2xa3l3qsvype5gjcfuektmzdjalfb7yqztjda5q",
  );
  assertEquals(parsed.path, ["foo/bar", "~"]);
});

Deno.test("parseTargetString parses cross-space link with embedded space DID", () => {
  const parsed = parseLLMFriendlyLink(
    "/@did:key:z6MkrX123abc/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/foo/bar",
    "did:test:fallback",
  );
  assertEquals(
    parsed.id,
    "of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai",
  );
  assertEquals(parsed.path, ["foo", "bar"]);
  assertEquals(parsed.space, "did:key:z6MkrX123abc");
});

Deno.test("parseTargetString uses fallback space for standard link format", () => {
  const parsed = parseLLMFriendlyLink(
    "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/foo",
    "did:test:fallback",
  );
  assertEquals(parsed.space, "did:test:fallback");
});

Deno.test("parseTargetString errors on human name", () => {
  expect(() => parseLLMFriendlyLink("PieceName/foo/bar", "did:test:123"))
    .toThrow("must include");
});

Deno.test("parseTargetString errors when path is empty", () => {
  expect(() => parseLLMFriendlyLink("   ", "did:test:123"))
    .toThrow("must include");
});

Deno.test("extractStringField returns value from string input", () => {
  const testPath =
    "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/path";
  assertEquals(
    extractStringField(testPath, "path", testPath),
    testPath,
  );
});

Deno.test("extractStringField returns value from object field", () => {
  const value = extractStringField(
    { piece: "Piece" },
    "piece",
    "Piece",
  );
  assertEquals(value, "Piece");
});

Deno.test("extractStringField throws on missing field", () => {
  assertThrows(() => extractStringField({ wrong: "Piece" }, "piece", "Piece"));
});

Deno.test("extractRunArguments prioritizes nested args object", () => {
  const args = extractRunArguments({
    path: "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/run",
    args: { foo: "bar" },
    extra: 1,
  });
  assertEquals(args, { foo: "bar" });
});

Deno.test("extractRunArguments removes path key when no args provided", () => {
  const args = extractRunArguments({
    path: "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/run",
    mode: "test",
  });
  assertEquals(args, { mode: "test" });
});

Deno.test("extractRunArguments defaults to empty object for non-object input", () => {
  const args = extractRunArguments(undefined);
  assertEquals(args, {});
});

Deno.test("extractToolCallParts returns tool-call entries from content array", () => {
  const toolPart: BuiltInLLMToolCallPart = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "demo_run",
    input: { value: 1 },
  };
  const content: BuiltInLLMMessage["content"] = [
    { type: "text", text: "hello" },
    toolPart,
    { type: "text", text: "world" },
  ];
  assertEquals(extractToolCallParts(content), [toolPart]);
});

Deno.test("extractToolCallParts returns empty array for string content", () => {
  assertEquals(extractToolCallParts("just text"), []);
});

Deno.test("buildAssistantMessage preserves text and appends tool calls", () => {
  const toolCall: BuiltInLLMToolCallPart = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "demo",
    input: {},
  };
  const assistant = buildAssistantMessage("Hello", [toolCall]);
  assertEquals(assistant.role, "assistant");
  assertEquals(assistant.content, [
    { type: "text", text: "Hello" },
    toolCall,
  ]);
});

Deno.test("createToolResultMessages converts execution results into tool messages", () => {
  const messages = createToolResultMessages([{
    id: "call-1",
    toolName: "demo",
    result: { type: "json", value: { ok: true } },
  }, {
    id: "call-2",
    toolName: "failing",
    error: "boom",
  }]);

  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "tool");
  assertEquals(messages[0].content?.[0], {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "demo",
    output: { type: "json", value: { ok: true } },
  });
  const failurePart = toolResultPart(messages[1].content?.[0]);
  assertEquals(failurePart.type, "tool-result");
  assertEquals(failurePart.toolCallId, "call-2");
  assertEquals(failurePart.toolName, "failing");
  assertEquals(failurePart.output, { type: "error-text", value: "boom" });
});

Deno.test("hasValidContent returns true for non-empty text", () => {
  assert(hasValidContent("Hello"));
  assert(hasValidContent([{ type: "text", text: "Hello" }]));
});

Deno.test("hasValidContent returns false for empty text", () => {
  assert(!hasValidContent(""));
  assert(!hasValidContent("   \n  "));
  assert(!hasValidContent([{ type: "text", text: "" }]));
  assert(!hasValidContent([{ type: "text", text: "  " }]));
});

Deno.test("hasValidContent returns true for tool calls", () => {
  const content: BuiltInLLMMessage["content"] = [
    { type: "text", text: "" },
    { type: "tool-call", toolCallId: "1", toolName: "test", input: {} },
  ];
  assert(hasValidContent(content));
});

Deno.test("hasValidContent returns true for tool results", () => {
  const content: BuiltInLLMMessage["content"] = [
    {
      type: "tool-result",
      toolCallId: "1",
      toolName: "test",
      output: { type: "json", value: null },
    },
  ];
  assert(hasValidContent(content));
});

Deno.test("hasValidContent returns false for only empty text parts", () => {
  const content: BuiltInLLMMessage["content"] = [
    { type: "text", text: "" },
    { type: "text", text: "  " },
  ];
  assert(!hasValidContent(content));
});

Deno.test("createToolResultMessages handles undefined result with explicit null", () => {
  const messages = createToolResultMessages([{
    id: "call-1",
    toolName: "empty",
    result: undefined,
  }]);

  assertEquals(messages.length, 1);
  assertEquals(messages[0].role, "tool");
  assertEquals(messages[0].content?.[0], {
    type: "tool-result",
    toolCallId: "call-1",
    toolName: "empty",
    output: { type: "json", value: null },
  });
});

Deno.test("createToolResultMessages handles null result with explicit null", () => {
  const messages = createToolResultMessages([{
    id: "call-1",
    toolName: "empty",
    result: null,
  }]);

  assertEquals(messages.length, 1);
  const outputPart = toolResultPart(messages[0].content?.[0]);
  assertEquals(outputPart.output, { type: "json", value: null });
});

Deno.test("serializeForLLMObservation keeps below-ceiling data inline", () => {
  const rootLink: NormalizedFullLink = {
    id: "of:test-inline",
    space: "did:test:inline",
    scope: "space",
    path: [],
  };
  const result = serializeForLLMObservation({
    value: { body: "hello" },
    schema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          ifc: { confidentiality: ["internal"] },
        },
      },
    },
    contextSpace: "did:test:inline",
    rootLink,
    observationMaxConfidentiality: ["internal"],
  });

  assertEquals(result.value, { body: "hello" });
  assertEquals(result.observedConfidentiality, ["internal"]);
});

Deno.test("serializeForLLMObservation redacts above-ceiling fields to links", () => {
  const rootLink: NormalizedFullLink = {
    id: "of:test-redacted",
    space: "did:test:redacted",
    scope: "space",
    path: [],
  };
  const result = serializeForLLMObservation({
    value: { public: "ok", secret: "classified" },
    schema: {
      type: "object",
      properties: {
        public: { type: "string" },
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
    },
    contextSpace: "did:test:redacted",
    rootLink,
    observationMaxConfidentiality: ["internal"],
  });

  assertEquals(result.value, {
    public: "ok",
    secret: { "@link": "/of:test-redacted/secret" },
  });
  assertEquals(result.observedConfidentiality, []);
});

Deno.test("serializeForLLMObservation exposes injection-safe booleans but links free strings", () => {
  const promptRisk = {
    type: "https://commonfabric.org/cfc/atom/Caveat",
    kind:
      "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
    source: "of:hostile",
  } as const;
  const promptInfluence = {
    type: "https://commonfabric.org/cfc/atom/Caveat",
    kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
    source: "of:hostile",
  } as const;
  const rootLink: NormalizedFullLink = {
    id: "of:test-assessment",
    space: "did:test:assessment",
    scope: "space",
    path: [],
  };
  const schema = schemaWithInjectionSafeAnnotations({
    type: "object",
    properties: {
      approved: { type: "boolean" },
      reasoning: { type: "string" },
    },
    required: ["approved", "reasoning"],
    additionalProperties: false,
  }, [promptRisk, promptInfluence]);

  const result = serializeForLLMObservation({
    value: {
      approved: false,
      reasoning: "The briefing includes untrusted free-form text.",
    },
    schema,
    contextSpace: "did:test:assessment",
    rootLink,
    observationMaxConfidentiality: [promptInfluence],
  });

  assertEquals(result.value, {
    approved: false,
    reasoning: { "@link": "/of:test-assessment/reasoning" },
  });
  assertEquals(result.observedConfidentiality, [promptInfluence]);
});

Deno.test("serializeForLLMObservation does not taint from redacted nested values", () => {
  const rootLink: NormalizedFullLink = {
    id: "of:test-mixed",
    space: "did:test:mixed",
    scope: "space",
    path: [],
  };
  const result = serializeForLLMObservation({
    value: {
      headline: "public",
      details: {
        safe: "allowed",
        secret: "hidden",
      },
    },
    schema: {
      type: "object",
      properties: {
        headline: { type: "string" },
        details: {
          type: "object",
          properties: {
            safe: {
              type: "string",
              ifc: { confidentiality: ["internal"] },
            },
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
        },
      },
    },
    contextSpace: "did:test:mixed",
    rootLink,
    observationMaxConfidentiality: ["internal"],
  });

  assertEquals(result.value, {
    headline: "public",
    details: {
      safe: "allowed",
      secret: { "@link": "/of:test-mixed/details/secret" },
    },
  });
  assertEquals(result.observedConfidentiality, ["internal"]);
});

Deno.test("serializeForLLMObservation stops at the maximum depth", () => {
  const result = serializeForLLMObservation({
    value: { too: "deep" },
    depth: 101,
  });

  assertEquals(result.value, "[Maximum depth reached]");
  assertEquals(result.observedConfidentiality, []);
});

Deno.test("serializeForLLMObservation serializes arrays", () => {
  const rootLink: NormalizedFullLink = {
    id: "of:test-array",
    space: "did:test:array",
    scope: "space",
    path: [],
  };
  const result = serializeForLLMObservation({
    value: [{ title: "first" }, { title: "second" }],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
      },
    },
    contextSpace: "did:test:array",
    rootLink,
  });

  assertEquals(result.value, [{ title: "first" }, { title: "second" }]);
  assertEquals(result.observedConfidentiality, []);
});

Deno.test("traverseAndCellify converts LLM-friendly links inside strings and objects", () => {
  const parsedLinks: unknown[] = [];
  const runtime = {
    getCellFromLink(link: unknown) {
      parsedLinks.push(link);
      return { kind: "cell", link };
    },
  };
  const target =
    "/of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai/path";

  const direct = traverseAndCellify(
    cast<CellifyRuntime>(runtime),
    "did:test:cellify",
    JSON.stringify({ "@link": target }),
  );
  const nested = traverseAndCellify(
    cast<CellifyRuntime>(runtime),
    "did:test:cellify",
    {
      keep: "value",
      list: [{ "@link": target }],
      malformed: '{"@link":',
    },
  );

  assertEquals(valueAt(direct, ["kind"]), "cell");
  assertEquals(valueAt(nested, ["keep"]), "value");
  assertEquals(valueAt(nested, ["list", 0, "kind"]), "cell");
  assertEquals(valueAt(nested, ["malformed"]), '{"@link":');
  assertEquals(parsedLinks.length, 2);
});

Deno.test("buildToolCatalog normalizes dynamic legacy tools", () => {
  const childValues = new Map<string, unknown>([
    [
      "fromChildPattern",
      {
        pattern: {
          get: () => ({
            argumentSchema: {
              type: "object",
              properties: { prompt: { type: "string" } },
            },
          }),
        },
      },
    ],
  ]);
  const childCells = new Map<string, unknown>();
  const toolsCell = {
    get: () => ({
      fromInputSchema: {
        description: "uses a parent schema",
        inputSchema: {
          type: "object",
          properties: {
            result: { type: "string" },
            value: { type: "number" },
          },
          required: ["result", "value"],
        },
      },
      fromChildPattern: {
        description: "uses a child pattern schema",
      },
      booleanSchema: {
        description: "uses a boolean schema",
        inputSchema: true,
      },
      missingSchema: {
        description: "skipped",
      },
      pieceTool: {
        piece: {
          get: () => ({ name: "piece" }),
          getAsNormalizedFullLink: () => ({
            id: "of:piece",
            path: [],
            space: "did:test:tools",
            scope: "space",
          }),
        },
      },
    }),
    key(name: string) {
      const cell = {
        get: () => childValues.get(name),
      };
      childCells.set(name, cell);
      return cell;
    },
  };

  const catalog = buildToolCatalog(cast<ToolCatalogInput>(toolsCell), false);

  assertEquals(Object.keys(catalog.llmTools).sort(), [
    "booleanSchema",
    "fromChildPattern",
    "fromInputSchema",
  ]);
  assertEquals(
    catalog.llmTools.fromInputSchema.description,
    "uses a parent schema",
  );
  assertEquals(
    valueAt(catalog.llmTools.fromInputSchema.inputSchema, ["properties"]),
    { value: { type: "number" } },
  );
  assertEquals(
    valueAt(catalog.llmTools.fromInputSchema.inputSchema, ["required"]),
    ["value"],
  );
  assertEquals(
    valueAt(catalog.llmTools.fromChildPattern.inputSchema, [
      "properties",
      "prompt",
      "type",
    ]),
    "string",
  );
  assertEquals(
    valueAt(catalog.llmTools.booleanSchema.inputSchema, [
      "additionalProperties",
    ]),
    {},
  );
  assertEquals(
    catalog.dynamicToolCells.get("fromChildPattern"),
    childCells.get("fromChildPattern"),
  );
});

Deno.test("buildToolCatalog adds built-in tools by default", () => {
  const toolsCell = {
    get: () => undefined,
    key: () => ({ get: () => undefined }),
  };

  const catalog = buildToolCatalog(cast<ToolCatalogInput>(toolsCell));

  assert("read" in catalog.llmTools);
  assert("invoke" in catalog.llmTools);
  assert("pin" in catalog.llmTools);
  assert("unpin" in catalog.llmTools);
  assert("updateArgument" in catalog.llmTools);
  assert("schema" in catalog.llmTools);
  assert(!(PRESENT_RESULT_TOOL_NAME in catalog.llmTools));
  assertEquals(catalog.dynamicToolCells.size, 0);
});

Deno.test("buildAvailableCellsDocumentation documents context and pinned cells", () => {
  const space = "did:test:docs";
  const nestedCell = makeDocumentationCell({
    id: "of:bafyreihqwsfjfvsr6zbmwhk7fo4hcxqaihmqqzv3ohfyv5gfdjt5jnzqai",
    space,
    path: ["project"],
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
    value: { name: "Ada" },
  });
  const outerCell = makeDocumentationCell({
    id: "of:bafyreiearlyouterouterouterouterouterouterouterouterouteroutera",
    space,
    nested: nestedCell,
  });
  const pinnedCell = makeDocumentationCell({
    id: "of:bafyreibbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmmnnoo",
    space,
    path: ["tasks"],
    value: { title: "Todo", $hidden: "skip" },
  });
  const runtime = {
    getCellFromLink: () => pinnedCell,
  };
  const pinnedCells = {
    get: () => [{
      path:
        "/of:bafyreibbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmmnnoo/tasks",
      name: "Pinned",
    }],
  };

  const docs = buildAvailableCellsDocumentation(
    cast<DocumentationRuntime>(runtime),
    space,
    {
      Project: outerCell,
      NotACell: { title: "ignored" },
    },
    cast<DocumentationPinnedCells>(pinnedCells),
  );

  assert(docs.includes("# Available Cells"));
  assert(docs.includes("## Project"));
  assert(docs.includes("## Pinned"));
  assert(docs.includes("Ada"));
  assert(docs.includes("Todo"));
  assert(docs.includes("- Schema:"));
  assert(docs.includes("title"));

  const empty = buildAvailableCellsDocumentationWithObservation(
    cast<DocumentationRuntime>(runtime),
    space,
    undefined,
    cast<DocumentationPinnedCells>(asCell({ get: () => [] })),
  );
  assertEquals(empty, { docs: "", observedConfidentiality: [] });
});

Deno.test("executeToolCalls wraps denied, present-result, pin, and error results", async () => {
  const space = "did:test:tools";
  const emptyToolsCell = {
    get: () => undefined,
    key: () => ({ get: () => undefined }),
  };
  const catalog = buildToolCatalog(cast<ToolCatalogInput>(emptyToolsCell));
  catalog.llmTools.secretTool = {
    description: "secret",
    inputSchema: {
      type: "object",
      ifc: { maxConfidentiality: [] },
    },
  };

  const pinnedState = [{ path: "/of:already", name: "Already" }];
  const pinnedCells = {
    get: () => pinnedState,
    withTx: () => ({
      get: () => pinnedState,
      set: (next: typeof pinnedState) => {
        pinnedState.splice(0, pinnedState.length, ...next);
      },
    }),
  };
  const targetCell = makeDocumentationCell({
    id: "of:bafyreiqqqqrrrrssssttttuuuuvvvvwwwwxxxxyyyyzzzzaaaabbbbccccd",
    space,
    path: ["target"],
    schema: {
      type: "object",
      properties: { value: { type: "number" } },
    },
    value: { value: 7 },
  });
  const runtime = {
    editWithRetry: (fn: (tx: unknown) => void) => {
      fn({});
      return true;
    },
    getCellFromLink: () => targetCell,
  };
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const results = await executeToolCalls(
      cast<ExecutionRuntime>(runtime),
      space,
      catalog,
      [
        {
          type: "tool-call",
          toolCallId: "denied",
          toolName: "secretTool",
          input: {},
        },
        {
          type: "tool-call",
          toolCallId: "present",
          toolName: PRESENT_RESULT_TOOL_NAME,
          input: { answer: 42 },
        },
        {
          type: "tool-call",
          toolCallId: "already",
          toolName: "pin",
          input: { path: "/of:already", name: "Already" },
        },
        {
          type: "tool-call",
          toolCallId: "new",
          toolName: "pin",
          input: { path: "/of:new", name: "New" },
        },
        {
          type: "tool-call",
          toolCallId: "missing",
          toolName: "unpin",
          input: { path: "/of:missing" },
        },
        {
          type: "tool-call",
          toolCallId: "remove",
          toolName: "unpin",
          input: { path: "/of:already" },
        },
        {
          type: "tool-call",
          toolCallId: "schema",
          toolName: "schema",
          input: {
            path:
              "/of:bafyreiqqqqrrrrssssttttuuuuvvvvwwwwxxxxyyyyzzzzaaaabbbbccccd/target",
          },
        },
        {
          type: "tool-call",
          toolCallId: "bad-update",
          toolName: "updateArgument",
          input: {
            path:
              "/of:bafyreiqqqqrrrrssssttttuuuuvvvvwwwwxxxxyyyyzzzzaaaabbbbccccd/target",
          },
        },
        {
          type: "tool-call",
          toolCallId: "bad-invoke",
          toolName: "invoke",
          input: {
            path:
              "/of:bafyreiqqqqrrrrssssttttuuuuvvvvwwwwxxxxyyyyzzzzaaaabbbbccccd/target",
          },
        },
        {
          type: "tool-call",
          toolCallId: "unknown",
          toolName: "unknownTool",
          input: {},
        },
      ],
      cast<ExecutionPinnedCells>(pinnedCells),
      ["internal"],
    );

    assertEquals(
      results.map((result) => result.id),
      [
        "denied",
        "present",
        "already",
        "new",
        "missing",
        "remove",
        "schema",
        "bad-update",
        "bad-invoke",
        "unknown",
      ],
    );
    assertEquals(
      results[0].error,
      "Tool call denied: observed confidentiality exceeds maxConfidentiality for secretTool",
    );
    assertEquals(results[1].result, {
      type: "json",
      value: { answer: 42 },
    });
    assertEquals(results[2].result?.value, {
      success: false,
      message: "Already pinned",
    });
    assertEquals(results[3].result?.value, { success: true });
    assertEquals(results[4].result?.value, {
      success: false,
      message: "Not found",
    });
    assertEquals(results[5].result?.value, { success: true });
    assertEquals(results[6].result?.value, {
      type: "object",
      properties: { value: { type: "number" } },
    });
    assertEquals(
      results[7].error,
      "updates must be an object with field names and values",
    );
    assertEquals(
      results[8].error,
      "target does not resolve to a handler stream or pattern.",
    );
    assertEquals(results[9].error, "Tool has neither pattern nor handler");
    assertEquals(pinnedState, [{ path: "/of:new", name: "New" }]);
    assertEquals(errors.length, 3);
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("toolAllowsObservedConfidentiality denies tools above maxConfidentiality", () => {
  const allowed = toolAllowsObservedConfidentiality(
    {
      llmTools: {
        restrictedTool: {
          description: "restricted",
          inputSchema: {
            type: "object",
            ifc: { maxConfidentiality: ["internal"] },
          },
        },
      },
      dynamicToolCells: new Map(),
    },
    "restrictedTool",
    ["secret"],
  );

  assertEquals(allowed, false);
});

Deno.test("toolAllowsObservedConfidentiality permits tools within maxConfidentiality", () => {
  const allowed = toolAllowsObservedConfidentiality(
    {
      llmTools: {
        restrictedTool: {
          description: "restricted",
          inputSchema: {
            type: "object",
            ifc: { maxConfidentiality: ["secret"] },
          },
        },
      },
      dynamicToolCells: new Map(),
    },
    "restrictedTool",
    ["secret"],
  );

  assertEquals(allowed, true);
});

Deno.test("simplifySchemaForContext preserves asCell stream marker", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      events: { asCell: ["stream"], type: "string" },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["properties", "events", "asCell"]), [
    "stream",
  ]);
  assertEquals(valueAt(result, ["properties", "events", "type"]), "string");
});

Deno.test("simplifySchemaForContext preserves asCell marker with nested properties", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      user: {
        asCell: ["cell"],
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["properties", "user", "asCell"]), ["cell"]);
  assertEquals(
    valueAt(result, ["properties", "user", "properties", "name", "type"]),
    "string",
  );
  assertEquals(
    valueAt(result, ["properties", "user", "properties", "age", "type"]),
    "number",
  );
  assertEquals(valueAt(result, ["properties", "user", "required"]), [
    "name",
    "age",
  ]);
});

Deno.test("simplifySchemaForContext preserves small enums", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "closed", "pending"] },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["properties", "status", "enum"]), [
    "open",
    "closed",
    "pending",
  ]);
});

Deno.test("simplifySchemaForContext truncates large enums", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      country: {
        type: "string",
        enum: Array.from({ length: 20 }, (_, i) => `country${i}`),
      },
    },
  };
  const result = simplifySchemaForContext(schema);
  const truncatedEnum = valueAt(result, ["properties", "country", "enum"]);
  assert(Array.isArray(truncatedEnum));
  assertEquals(truncatedEnum.length, 11);
  assertEquals(truncatedEnum[10], "...");
});

Deno.test("simplifySchemaForContext removes $defs and $ref", () => {
  const schema: JSONSchema = {
    $defs: { Foo: { type: "string" } },
    type: "object",
    properties: {
      foo: { $ref: "#/$defs/Foo" },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["$defs"]), undefined);
  assertEquals(valueAt(result, ["properties", "foo", "$ref"]), undefined);
});

Deno.test("simplifySchemaForContext skips $-prefixed properties", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      $UI: { type: "object" },
      $TYPE: { type: "string" },
      name: { type: "string" },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["properties", "$UI"]), undefined);
  assertEquals(valueAt(result, ["properties", "$TYPE"]), undefined);
  assertEquals(valueAt(result, ["properties", "name", "type"]), "string");
});

Deno.test("simplifySchemaForContext limits recursion depth", () => {
  const deepSchema: JSONSchema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                asCell: ["stream"],
                properties: {
                  d: { type: "string", description: "deep field" },
                },
              },
            },
          },
        },
      },
    },
  };
  const result = simplifySchemaForContext(deepSchema);
  const deepPath = ["properties", "a", "properties", "b", "properties", "c"];
  assertEquals(valueAt(result, [...deepPath, "type"]), "object");
  assertEquals(valueAt(result, [...deepPath, "asCell"]), ["stream"]);
  assertEquals(valueAt(result, [...deepPath, "properties"]), undefined);
});

Deno.test("simplifySchemaForContext preserves required array", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["required"]), ["name"]);
});

Deno.test("simplifySchemaForContext preserves items schema for arrays", () => {
  const schema: JSONSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
      required: ["id"],
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["items", "type"]), "object");
  assertEquals(
    valueAt(result, ["items", "properties", "id", "type"]),
    "number",
  );
  assertEquals(valueAt(result, ["items", "required"]), ["id"]);
});

Deno.test("simplifySchemaForContext handles Stream with nested detail structure", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      editContent: {
        asCell: ["stream"],
        type: "object",
        properties: {
          detail: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      },
    },
  };
  const result = simplifySchemaForContext(schema);
  assertEquals(valueAt(result, ["properties", "editContent", "asCell"]), [
    "stream",
  ]);
  assertEquals(
    valueAt(result, ["properties", "editContent", "type"]),
    "object",
  );
  assertEquals(
    valueAt(result, [
      "properties",
      "editContent",
      "properties",
      "detail",
      "properties",
      "value",
      "type",
    ]),
    "string",
  );
});

Deno.test("simplifySchemaForContext handles primitive and composed schemas", () => {
  assertEquals<unknown>(simplifySchemaForContext(asSchema("plain")), "plain");

  const result = simplifySchemaForContext({
    type: "object",
    description: "choice",
    anyOf: [{ type: "string" }, asSchema("literal")],
    oneOf: [{ type: "number" }],
    allOf: [{ type: "object", properties: { id: { type: "string" } } }],
  });

  assertEquals(valueAt(result, ["description"]), "choice");
  assertEquals(valueAt(result, ["anyOf"]), [{ type: "string" }, "literal"]);
  assertEquals(valueAt(result, ["oneOf"]), [{ type: "number" }]);
  assertEquals(
    valueAt(result, ["allOf", 0, "properties", "id", "type"]),
    "string",
  );
});

Deno.test("resolveRefsForLLM converts boolean true schema to empty object", () => {
  const result = resolveRefsForLLM(true);
  assertEquals(result, {});
});

Deno.test("resolveRefsForLLM converts boolean false schema to permissive object", () => {
  const result = resolveRefsForLLM(false);
  assertEquals(result, { type: "object", properties: {} });
});

Deno.test("resolveRefsForLLM converts boolean sub-schemas in properties to objects", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      anything: true,
      nothing: false,
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "anything"]), {});
  assertEquals(valueAt(result, ["properties", "nothing"]), {
    type: "object",
    properties: {},
  });
});

Deno.test("resolveRefsForLLM resolves simple $ref", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      Name: { type: "string" },
    },
    properties: {
      name: { $ref: "#/$defs/Name" },
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "name"]), { type: "string" });
  assertEquals(valueAt(result, ["$defs"]), undefined);
});

Deno.test("resolveRefsForLLM resolves nested $ref chains", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      Inner: { type: "number" },
      Outer: {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Inner" },
        },
      },
    },
    properties: {
      data: { $ref: "#/$defs/Outer" },
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "data", "type"]), "object");
  assertEquals(
    valueAt(result, ["properties", "data", "properties", "value"]),
    { type: "number" },
  );
  assertEquals(valueAt(result, ["$defs"]), undefined);
});

Deno.test("resolveRefsForLLM truncates circular $ref", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      Node: {
        type: "object",
        properties: {
          child: { $ref: "#/$defs/Node" },
          value: { type: "string" },
        },
      },
    },
    properties: {
      root: { $ref: "#/$defs/Node" },
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "root", "type"]), "object");
  assertEquals(valueAt(result, ["properties", "root", "properties", "value"]), {
    type: "string",
  });
  assertEquals(valueAt(result, ["properties", "root", "properties", "child"]), {
    type: "object",
    additionalProperties: true,
  });
  assertEquals(valueAt(result, ["$defs"]), undefined);
});

Deno.test("resolveRefsForLLM truncates unresolved $ref", () => {
  const result = resolveRefsForLLM({
    type: "object",
    properties: {
      missing: { $ref: "#/$defs/Missing" },
    },
  });

  assertEquals(valueAt(result, ["properties", "missing"]), {
    type: "object",
    additionalProperties: true,
  });
});

Deno.test("resolveRefsForLLM passes through schema with no $ref unchanged", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["type"]), "object");
  assertEquals(valueAt(result, ["properties", "name"]), { type: "string" });
  assertEquals(valueAt(result, ["properties", "age"]), { type: "number" });
  assertEquals(valueAt(result, ["required"]), ["name"]);
});

Deno.test("resolveRefsForLLM preserves sibling properties alongside $ref", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      Items: { type: "array", items: { type: "string" } },
    },
    properties: {
      list: { $ref: "#/$defs/Items", default: [] },
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "list", "type"]), "array");
  assertEquals(valueAt(result, ["properties", "list", "default"]), []);
  assertEquals(valueAt(result, ["properties", "list", "items"]), {
    type: "string",
  });
});

Deno.test("resolveRefsForLLM handles mutually recursive types", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      A: {
        type: "object",
        properties: { b: { $ref: "#/$defs/B" } },
      },
      B: {
        type: "object",
        properties: { a: { $ref: "#/$defs/A" } },
      },
    },
    properties: {
      start: { $ref: "#/$defs/A" },
    },
  };
  const result = resolveRefsForLLM(schema);
  assertEquals(valueAt(result, ["properties", "start", "type"]), "object");
  assertEquals(
    valueAt(result, ["properties", "start", "properties", "b", "type"]),
    "object",
  );
  assertEquals(
    valueAt(result, [
      "properties",
      "start",
      "properties",
      "b",
      "properties",
      "a",
    ]),
    { type: "object", additionalProperties: true },
  );
});

Deno.test("prepareSchemaForLLM returns primitive schemas unchanged", () => {
  assertEquals<unknown>(prepareSchemaForLLM(asSchema("plain")), "plain");
  assertEquals<unknown>(prepareSchemaForLLM(asSchema(null)), null);
});

Deno.test("prepareSchemaForLLM strips internal markers and resolves $ref", () => {
  const schema: JSONSchema = {
    type: "object",
    $defs: {
      Item: { type: "string" },
    },
    properties: {
      data: { $ref: "#/$defs/Item", asCell: ["cell"] },
      stream: { type: "number", asCell: ["stream"] },
      hidden: { type: "object", asCell: ["opaque"] },
    },
  };
  const result = prepareSchemaForLLM(schema);
  assertEquals(valueAt(result, ["properties", "data", "asCell"]), undefined);
  assertEquals(valueAt(result, ["properties", "stream", "asCell"]), undefined);
  assertEquals(valueAt(result, ["properties", "hidden", "asCell"]), undefined);
  assertEquals(valueAt(result, ["properties", "data", "type"]), "string");
  assertEquals(valueAt(result, ["$defs"]), undefined);
});

Deno.test("prepareSchemaForLLM handles recursive TodoItem schema", () => {
  const schema: JSONSchema = {
    $defs: {
      AnonymousType_1: {
        items: { $ref: "#/$defs/TodoItem" },
        type: "array",
      },
      TodoItem: {
        properties: {
          done: { default: false, type: "boolean" },
          items: {
            $ref: "#/$defs/AnonymousType_1",
            asCell: ["cell"],
            default: [],
          },
          title: { type: "string" },
        },
        required: ["done", "items", "title"],
        type: "object",
      },
    },
    properties: {
      todos: { $ref: "#/$defs/AnonymousType_1", default: [] },
    },
    required: ["todos"],
    type: "object",
  };
  const result = prepareSchemaForLLM(schema);

  assertEquals(valueAt(result, ["$defs"]), undefined);
  assertEquals(JSON.stringify(result).includes("$ref"), false);
  assertEquals(JSON.stringify(result).includes("asCell"), false);
  assertEquals(valueAt(result, ["type"]), "object");
  assertEquals(valueAt(result, ["properties", "todos", "type"]), "array");
  assertEquals(valueAt(result, ["properties", "todos", "default"]), []);
  assertEquals(
    valueAt(result, ["properties", "todos", "items", "type"]),
    "object",
  );
  assertEquals(
    valueAt(result, [
      "properties",
      "todos",
      "items",
      "properties",
      "title",
      "type",
    ]),
    "string",
  );
  assertEquals(
    valueAt(result, [
      "properties",
      "todos",
      "items",
      "properties",
      "done",
      "type",
    ]),
    "boolean",
  );
  assertEquals(
    valueAt(result, [
      "properties",
      "todos",
      "items",
      "properties",
      "items",
    ]),
    {
      type: "object",
      additionalProperties: true,
    },
  );
});
