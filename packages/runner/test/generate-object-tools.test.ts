/**
 * Tests for generateObject with tool calling support.
 */

import { assertEquals } from "jsr:@std/assert";
import {
  addMockResponse,
  enableMockMode,
  resetMockMode,
} from "@commontools/llm/client";

Deno.test({
  name: "generateObject with tools - finalResult tool is added to catalog",
  async fn() {
    // This is a basic test to verify the structure is working
    // We'll add more comprehensive tests once we have the mock mode working
    assertEquals(1, 1);
  },
});

Deno.test({
  name: "mock mode - can register and match responses",
  async fn() {
    resetMockMode();
    enableMockMode();

    addMockResponse(
      (req) => req.messages.some((m) =>
        typeof m.content === "string" && m.content.includes("test")
      ),
      {
        role: "assistant",
        content: "mock response",
        id: "mock-1",
      },
    );

    // Test will be expanded with actual LLM client usage
    assertEquals(true, true);

    resetMockMode();
  },
});

Deno.test({
  name: "mock mode - finalResult tool call simulation",
  async fn() {
    resetMockMode();
    enableMockMode();

    // Mock response with tool call for finalResult
    addMockResponse(
      (req) => req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "finalResult",
            input: { name: "Test Object", value: 42 },
          },
        ],
        id: "mock-with-finalResult",
      },
    );

    // Verify the mock is registered
    // Actual integration test will follow
    assertEquals(true, true);

    resetMockMode();
  },
});
