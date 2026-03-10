import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  type ConversationFixture,
  disableMockMode,
  enableMockMode,
  LLMClient,
  loadConversationFixture,
  resetMockMode,
} from "./client.ts";

const GUARD_MESSAGE =
  "LLMClient: live LLM calls are blocked in test environments.";

describe("LLMClient test-environment guard", () => {
  const client = new LLMClient();

  it("sendRequest throws guard error without mock mode", async () => {
    // Ensure mock mode is off
    disableMockMode();

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("generateObject throws guard error without mock mode", async () => {
    disableMockMode();

    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "hello" }],
        schema: { type: "object", properties: { name: { type: "string" } } },
      }),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("sendRequest with mock mode bypasses guard", async () => {
    enableMockMode();
    addMockResponse(
      () => true,
      { role: "assistant", content: "mocked!", id: "mock-1" },
    );

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: false,
    });

    expect(result.content).toBe("mocked!");
    resetMockMode();
  });

  it("generateObject with mock mode bypasses guard", async () => {
    enableMockMode();
    addMockObjectResponse(
      () => true,
      { object: { name: "Alice" } },
    );

    const result = await client.generateObject({
      messages: [{ role: "user", content: "hello" }],
      schema: { type: "object", properties: { name: { type: "string" } } },
    });

    expect(result.object).toEqual({ name: "Alice" });
    resetMockMode();
  });

  it("mock mode without matching response throws descriptive error", async () => {
    enableMockMode();
    clearMockResponses();

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow("no matching mock response found for sendRequest");

    resetMockMode();
  });

  it("generateObject mock mode without matching response throws descriptive error", async () => {
    enableMockMode();
    clearMockResponses();

    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "hello" }],
        schema: { type: "object" },
      }),
    ).rejects.toThrow(
      "no matching mock response found for generateObject request",
    );

    resetMockMode();
  });

  it("mock responses are consumed (one-time use)", async () => {
    enableMockMode();
    addMockResponse(
      () => true,
      { role: "assistant", content: "first", id: "mock-1" },
    );

    const result1 = await client.sendRequest({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: false,
    });
    expect(result1.content).toBe("first");

    // Second call should fail - mock was consumed
    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow("no matching mock response found");

    resetMockMode();
  });

  it("conversation fixture queues sequential responses", async () => {
    resetMockMode();

    const fixture: ConversationFixture = {
      description: "test fixture",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "first", id: "fix-1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "second", id: "fix-2" },
        },
        {
          type: "generateObject",
          response: { object: { name: "Alice" }, id: "fix-3" },
        },
      ],
    };

    loadConversationFixture(fixture);

    const r1 = await client.sendRequest({
      messages: [{ role: "user", content: "one" }],
      model: "test",
      stream: false,
    });
    expect(r1.content).toBe("first");

    const r2 = await client.sendRequest({
      messages: [{ role: "user", content: "two" }],
      model: "test",
      stream: false,
    });
    expect(r2.content).toBe("second");

    const r3 = await client.generateObject({
      messages: [{ role: "user", content: "three" }],
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(r3.object).toEqual({ name: "Alice" });

    resetMockMode();
  });

  it("conversation fixture assertions pass on correct request", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "ok", id: "assert-1" },
          assert: {
            messageCount: 1,
            messagesContain: ["hello"],
            lastMessageContains: "hello",
          },
        },
      ],
    });

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hello world" }],
      model: "test",
      stream: false,
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("conversation fixture assertions throw on mismatch with description", async () => {
    resetMockMode();

    loadConversationFixture({
      description: "my test conversation",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "ok", id: "assert-2" },
          assert: {
            messagesContain: ["expected-keyword"],
          },
        },
      ],
    });

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "something else" }],
        model: "test",
        stream: false,
      }),
    ).rejects.toThrow(
      'Fixture "my test conversation" entry 0: expected some message to contain "expected-keyword"',
    );

    resetMockMode();
  });

  it("conversation fixture hasTools assertion works", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "ok", id: "tools-1" },
          assert: {
            hasTools: ["search", "calculate"],
          },
        },
      ],
    });

    // Should pass with matching tools
    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hi" }],
      model: "test",
      stream: false,
      tools: {
        search: {
          description: "Search",
          inputSchema: { type: "object" },
        },
        calculate: {
          description: "Calculate",
          inputSchema: { type: "object" },
        },
      },
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("conversation fixture systemContains assertion works", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "ok", id: "sys-1" },
          assert: {
            systemContains: "helpful assistant",
          },
        },
      ],
    });

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hi" }],
      model: "test",
      system: "You are a helpful assistant.",
      stream: false,
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("sendRequest stream validation errors still work", async () => {
    disableMockMode();

    // Stream requested without callback
    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: true,
      }),
    ).rejects.toThrow("no callback provided");

    // Callback provided without stream
    await expect(
      client.sendRequest(
        {
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          stream: false,
        },
        () => {},
      ),
    ).rejects.toThrow("not configured as a stream");
  });
});
