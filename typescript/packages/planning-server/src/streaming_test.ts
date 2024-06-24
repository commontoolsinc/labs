// streaming_test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { MockStream } from "./mock_stream.ts";
import { Anthropic } from "./deps.ts";
import { processStream } from "./stream.ts";

Deno.test("Stream processing - text only", async () => {
  const mockEvents: Anthropic.Messages.MessageStreamEvent[] = [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { text: "Hello" } },
    { type: "content_block_delta", delta: { text: " world" } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ];

  const mockStream = new MockStream(mockEvents);
  const { message, stopReason } = await processStream(mockStream);

  assertEquals(message, [{ type: "text", text: "Hello world" }]);
});

Deno.test("Stream processing - with tool use", async () => {
  const mockEvents: Anthropic.Messages.MessageStreamEvent[] = [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { text: "Using a tool:" } },
    { type: "content_block_stop" },
    {
      type: "content_block_start",
      content_block: {
        type: "tool_use",
        id: "tool1",
        name: "testTool",
        input: {},
      },
    },
    { type: "content_block_delta", delta: { partial_json: '{"key":' } },
    { type: "content_block_delta", delta: { partial_json: '"value"}' } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ];

  const mockStream = new MockStream(mockEvents);
  const { message, stopReason } = await processStream(mockStream);

  assertEquals(message, [
    { type: "text", text: "Using a tool:" },
    {
      type: "tool_use",
      id: "tool1",
      name: "testTool",
      input: { key: "value" },
    },
  ]);
});

Deno.test("Stream processing - multiple content blocks", async () => {
  const mockEvents: Anthropic.Messages.MessageStreamEvent[] = [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { text: "First block" } },
    { type: "content_block_stop" },
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { text: "Second block" } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ];

  const mockStream = new MockStream(mockEvents);
  const { message, stopReason } = await processStream(mockStream);

  assertEquals(message, [
    { type: "text", text: "First block" },
    { type: "text", text: "Second block" },
  ]);
});

Deno.test("Stream processing - error handling", async () => {
  const mockEvents: Anthropic.Messages.MessageStreamEvent[] = [
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { text: "Partial message" } },
    {
      type: "error",
      error: { type: "server_error", message: "Internal server error" },
    },
  ];

  const mockStream = new MockStream(mockEvents);
  const { message, stopReason } = await processStream(mockStream);

  assertEquals(message, [{ type: "text", text: "Partial message" }]);
});
