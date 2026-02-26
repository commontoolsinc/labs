import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import type { BuiltInLLMMessage, BuiltInLLMToolCallPart } from "commontools";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

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
} = llmDialogTestHelpers;

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
  const failurePart = messages[1].content?.[0] as any;
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
  const outputPart = messages[0].content?.[0] as any;
  assertEquals(outputPart.output, { type: "json", value: null });
});

// Tests for simplifySchemaForContext
// Note: We cast schemas to `any` to avoid strict type checking on `type` field literals

Deno.test("simplifySchemaForContext preserves asStream marker", () => {
  const schema: any = {
    type: "object",
    properties: {
      events: { asStream: true, type: "string" },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.events?.asStream, true);
  assertEquals(result.properties?.events?.type, "string");
});

Deno.test("simplifySchemaForContext preserves asCell marker with nested properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      user: {
        asCell: true,
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.user?.asCell, true);
  assertEquals(result.properties?.user?.properties?.name?.type, "string");
  assertEquals(result.properties?.user?.properties?.age?.type, "number");
  assertEquals(result.properties?.user?.required, ["name", "age"]);
});

Deno.test("simplifySchemaForContext preserves asOpaque marker", () => {
  const schema: any = {
    type: "object",
    properties: {
      state: { asOpaque: true, type: "object" },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.state?.asOpaque, true);
});

Deno.test("simplifySchemaForContext preserves small enums", () => {
  const schema: any = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "closed", "pending"] },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.status?.enum, ["open", "closed", "pending"]);
});

Deno.test("simplifySchemaForContext truncates large enums", () => {
  const schema: any = {
    type: "object",
    properties: {
      country: {
        type: "string",
        enum: Array.from({ length: 20 }, (_, i) => `country${i}`),
      },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.country?.enum?.length, 11); // 10 + "..."
  assertEquals(result.properties?.country?.enum?.[10], "...");
});

Deno.test("simplifySchemaForContext removes $defs and $ref", () => {
  const schema: any = {
    $defs: { Foo: { type: "string" } },
    type: "object",
    properties: {
      foo: { $ref: "#/$defs/Foo" },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.$defs, undefined);
  assertEquals(result.properties?.foo?.$ref, undefined);
});

Deno.test("simplifySchemaForContext skips $-prefixed properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      $UI: { type: "object" },
      $TYPE: { type: "string" },
      name: { type: "string" },
    },
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.$UI, undefined);
  assertEquals(result.properties?.$TYPE, undefined);
  assertEquals(result.properties?.name?.type, "string");
});

Deno.test("simplifySchemaForContext limits recursion depth", () => {
  const deepSchema: any = {
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
                asStream: true, // wrapper marker to verify it's preserved at depth limit
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
  const result = simplifySchemaForContext(deepSchema) as any;
  // At depth 3, we should get minimal schema (just type and wrapper markers)
  // depth 0: root -> depth 1: a -> depth 2: b -> depth 3: c (hits maxDepth)
  const deep = result.properties?.a?.properties?.b?.properties?.c;
  // At max depth, only type and wrapper markers are preserved, properties are dropped
  assertEquals(deep?.type, "object");
  assertEquals(deep?.asStream, true);
  assertEquals(deep?.properties, undefined); // nested properties dropped at max depth
});

Deno.test("simplifySchemaForContext preserves required array", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.required, ["name"]);
});

Deno.test("simplifySchemaForContext preserves items schema for arrays", () => {
  const schema: any = {
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
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.items?.type, "object");
  assertEquals(result.items?.properties?.id?.type, "number");
  assertEquals(result.items?.required, ["id"]);
});

Deno.test("simplifySchemaForContext handles Stream with nested detail structure", () => {
  // This is the exact case from the bug report: Stream<{ detail: { value: string }}>
  const schema: any = {
    type: "object",
    properties: {
      editContent: {
        asStream: true,
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
  const result = simplifySchemaForContext(schema) as any;
  assertEquals(result.properties?.editContent?.asStream, true);
  assertEquals(result.properties?.editContent?.type, "object");
  assertEquals(
    result.properties?.editContent?.properties?.detail?.properties?.value?.type,
    "string",
  );
});

// Tests for resolveRefsForLLM

Deno.test("resolveRefsForLLM converts boolean true schema to empty object", () => {
  const result = resolveRefsForLLM(true as any);
  assertEquals(result, {});
});

Deno.test("resolveRefsForLLM converts boolean false schema to permissive object", () => {
  const result = resolveRefsForLLM(false as any);
  // false schemas are mapped to a permissive object instead of { not: true }
  // since LLMs don't handle JSON Schema `not` well
  assertEquals(result, { type: "object", properties: {} });
});

Deno.test("resolveRefsForLLM converts boolean sub-schemas in properties to objects", () => {
  const schema: any = {
    type: "object",
    properties: {
      anything: true,
      nothing: false,
    },
  };
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.properties?.anything, {});
  assertEquals(result.properties?.nothing, { type: "object", properties: {} });
});

Deno.test("resolveRefsForLLM resolves simple $ref", () => {
  const schema: any = {
    type: "object",
    $defs: {
      Name: { type: "string" },
    },
    properties: {
      name: { $ref: "#/$defs/Name" },
    },
  };
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.properties?.name, { type: "string" });
  assertEquals(result.$defs, undefined);
});

Deno.test("resolveRefsForLLM resolves nested $ref chains", () => {
  const schema: any = {
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
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.properties?.data?.type, "object");
  assertEquals(result.properties?.data?.properties?.value, { type: "number" });
  assertEquals(result.$defs, undefined);
});

Deno.test("resolveRefsForLLM truncates circular $ref", () => {
  const schema: any = {
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
  const result = resolveRefsForLLM(schema) as any;
  // First level should be resolved
  assertEquals(result.properties?.root?.type, "object");
  assertEquals(result.properties?.root?.properties?.value, { type: "string" });
  // Circular reference should be truncated
  assertEquals(result.properties?.root?.properties?.child, {
    type: "object",
    additionalProperties: true,
  });
  assertEquals(result.$defs, undefined);
});

Deno.test("resolveRefsForLLM passes through schema with no $ref unchanged", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.type, "object");
  assertEquals(result.properties?.name, { type: "string" });
  assertEquals(result.properties?.age, { type: "number" });
  assertEquals(result.required, ["name"]);
});

Deno.test("resolveRefsForLLM preserves sibling properties alongside $ref", () => {
  const schema: any = {
    type: "object",
    $defs: {
      Items: { type: "array", items: { type: "string" } },
    },
    properties: {
      list: { $ref: "#/$defs/Items", default: [] },
    },
  };
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.properties?.list?.type, "array");
  assertEquals(result.properties?.list?.default, []);
  assertEquals(result.properties?.list?.items, { type: "string" });
});

Deno.test("resolveRefsForLLM handles mutually recursive types", () => {
  const schema: any = {
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
  const result = resolveRefsForLLM(schema) as any;
  assertEquals(result.properties?.start?.type, "object");
  // A resolved -> B resolved -> A is circular, truncated
  assertEquals(result.properties?.start?.properties?.b?.type, "object");
  assertEquals(
    result.properties?.start?.properties?.b?.properties?.a,
    { type: "object", additionalProperties: true },
  );
});

// Tests for prepareSchemaForLLM

Deno.test("prepareSchemaForLLM strips internal markers and resolves $ref", () => {
  const schema: any = {
    type: "object",
    $defs: {
      Item: { type: "string" },
    },
    properties: {
      data: { $ref: "#/$defs/Item", asCell: true },
      stream: { type: "number", asStream: true },
      hidden: { type: "object", asOpaque: true },
    },
  };
  const result = prepareSchemaForLLM(schema) as any;
  // asCell, asStream, asOpaque should be stripped
  assertEquals(result.properties?.data?.asCell, undefined);
  assertEquals(result.properties?.stream?.asStream, undefined);
  assertEquals(result.properties?.hidden?.asOpaque, undefined);
  // $ref should be resolved
  assertEquals(result.properties?.data?.type, "string");
  assertEquals(result.$defs, undefined);
});

Deno.test("prepareSchemaForLLM handles recursive TodoItem schema", () => {
  // This mirrors the writable-recursive-todoitem.expected.json fixture
  const schema: any = {
    $defs: {
      AnonymousType_1: {
        items: { $ref: "#/$defs/TodoItem" },
        type: "array",
      },
      TodoItem: {
        properties: {
          done: { default: false, type: "boolean" },
          items: { $ref: "#/$defs/AnonymousType_1", asCell: true, default: [] },
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
  const result = prepareSchemaForLLM(schema) as any;

  // No $defs or $ref in output
  assertEquals(result.$defs, undefined);
  assertEquals(JSON.stringify(result).includes("$ref"), false);

  // No internal markers
  assertEquals(JSON.stringify(result).includes("asCell"), false);

  // Structure should be resolved
  assertEquals(result.type, "object");
  assertEquals(result.properties?.todos?.type, "array");
  assertEquals(result.properties?.todos?.default, []);

  // The items of todos should be resolved TodoItem objects
  const todoItem = result.properties?.todos?.items;
  assertEquals(todoItem?.type, "object");
  assertEquals(todoItem?.properties?.title?.type, "string");
  assertEquals(todoItem?.properties?.done?.type, "boolean");

  // The nested items field (recursive) should be truncated
  // since TodoItem -> AnonymousType_1 -> TodoItem is circular.
  // When a circular $ref is detected, it's replaced with a permissive object.
  const nestedItems = todoItem?.properties?.items;
  assertEquals(nestedItems, {
    type: "object",
    additionalProperties: true,
  });
});
