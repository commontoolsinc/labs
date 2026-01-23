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
  expect(() => parseLLMFriendlyLink("CharmName/foo/bar", "did:test:123"))
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
    { charm: "Charm" },
    "charm",
    "Charm",
  );
  assertEquals(value, "Charm");
});

Deno.test("extractStringField throws on missing field", () => {
  assertThrows(() => extractStringField({ wrong: "Charm" }, "charm", "Charm"));
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
