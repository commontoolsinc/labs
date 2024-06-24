import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { InMemoryConversationThreadManager } from "./conversation.ts";

Deno.test("ThreadManager - Create and Get Thread", () => {
  const manager = new InMemoryConversationThreadManager();
  const thread = manager.create("system prompt", "initial message", []);

  assertEquals(thread.system, "system prompt");
  assertEquals(thread.conversation.length, 1);
  assertEquals(thread.conversation[0].role, "user");
  assertEquals(thread.conversation[0].content[0].text, "initial message");

  const retrievedThread = manager.get(thread.id);
  assertEquals(retrievedThread, thread);
});

Deno.test("ThreadManager - Update Thread", () => {
  const manager = new InMemoryConversationThreadManager();
  const thread = manager.create("system prompt", "initial message", []);

  manager.update(thread.id, [
    {
      role: "assistant",
      content: [{ type: "text", text: "Hello! How can I help you?" }],
    },
  ]);

  const updatedThread = manager.get(thread.id);
  assertEquals(updatedThread?.conversation.length, 2);
  assertEquals(updatedThread?.conversation[1].role, "assistant");
  assertEquals(
    updatedThread?.conversation[1].content[0].text,
    "Hello! How can I help you?",
  );
});

Deno.test("ThreadManager - Set Pending Tool Calls", () => {
  const manager = new InMemoryConversationThreadManager();
  const thread = manager.create("system prompt", "initial message", []);

  const toolCalls = [
    { type: "tool_use", tool: { name: "calculator", arguments: "1 + 1" } },
  ];
  manager.setPendingToolCalls(thread.id, toolCalls);

  const updatedThread = manager.get(thread.id);
  assertEquals(updatedThread?.pendingToolCalls, toolCalls);
});

Deno.test("ThreadManager - Delete Thread", () => {
  const manager = new InMemoryConversationThreadManager();
  const thread = manager.create("system prompt", "initial message", []);

  manager.delete(thread.id);

  const deletedThread = manager.get(thread.id);
  assertEquals(deletedThread, undefined);
});
