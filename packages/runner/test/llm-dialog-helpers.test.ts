import { assert, assertEquals, assertThrows } from "@std/assert";
import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
} from "commontools";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const {
  createCharmToolDefinitions,
  normalizeCharmPathSegments,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
} = llmDialogTestHelpers;

Deno.test("createCharmToolDefinitions slugifies charm names and returns tool metadata", () => {
  const defs = createCharmToolDefinitions("My Charm!", "{ \"type\": \"object\" }");
  assertEquals(defs.read.name, "My_Charm_read");
  assertEquals(defs.run.name, "My_Charm_run");
  const readSchema = defs.read.inputSchema as any;
  const runSchema = defs.run.inputSchema as any;
  assertEquals(readSchema.properties.path.type, "array");
  assertEquals(runSchema.required, ["path"]);
  assert(defs.read.description.includes("My Charm!"));
});

Deno.test("normalizeCharmPathSegments returns sanitized segments", () => {
  const segments = normalizeCharmPathSegments({ path: ["foo", 1, "bar", ""] });
  assertEquals(segments, ["foo", "1", "bar"]);
});

Deno.test("normalizeCharmPathSegments throws when path is missing", () => {
  assertThrows(() => normalizeCharmPathSegments({}));
});

Deno.test("extractRunArguments prioritizes nested args object", () => {
  const args = extractRunArguments({
    path: ["demo"],
    args: { foo: "bar" },
    extra: 1,
  });
  assertEquals(args, { foo: "bar" });
});

Deno.test("extractRunArguments removes path key when no args provided", () => {
  const args = extractRunArguments({
    path: ["demo"],
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
