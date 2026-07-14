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
  LLMStreamError,
  loadConversationFixture,
  normalizeLLMResponse,
  resetMockMode,
} from "./client.ts";
import { GOOGLE_SEARCH_NATIVE_MODEL_TOOL } from "./types.ts";
import { createInternalLLMBrokerRequestOptions } from "./internal.ts";

const GUARD_MESSAGE =
  "LLMClient: live LLM calls are blocked in test environments.";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function runClientStream(client: LLMClient, chunks: string[]) {
  return (client as unknown as {
    stream(
      body: ReadableStream<Uint8Array>,
      id: string,
      callback?: (text: string) => void,
    ): Promise<unknown>;
  }).stream(streamFromChunks(chunks), "trace-1", () => {});
}

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

  it("global fetch injection does not bypass the guard", async () => {
    disableMockMode();

    await expect(
      client.sendRequest(
        {
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          stream: false,
        },
        undefined,
        undefined,
        { fetch: globalThis.fetch },
      ),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("ordinary fetch wrappers do not bypass the guard", async () => {
    disableMockMode();
    let calls = 0;
    const ordinaryFetch: typeof globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(Response.json({ object: { allowed: false } }));
    };

    await expect(
      client.generateObject(
        {
          messages: [{ role: "user", content: "hello" }],
          schema: { type: "object" },
        },
        undefined,
        { fetch: ordinaryFetch },
      ),
    ).rejects.toThrow(GUARD_MESSAGE);
    expect(calls).toBe(0);
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

  it("normalizes JSON responses without dropping native model tool metadata", () => {
    const nativeModelToolResults = [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: { query: "example" },
      sources: [{ url: "https://example.com" }],
    }];

    const result = normalizeLLMResponse({
      role: "assistant",
      content: "searched",
      nativeModelToolResults,
    }, "trace-json");

    expect(result).toEqual({
      role: "assistant",
      content: "searched",
      id: "trace-json",
      nativeModelToolResults,
    });
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
          expectRequest: {
            messageCount: 1,
            messagesContain: ["hello"],
            lastMessageContains: "hello",
          },
          response: { role: "assistant", content: "ok", id: "assert-1" },
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
          expectRequest: {
            messagesContain: ["expected-keyword"],
          },
          response: { role: "assistant", content: "ok", id: "assert-2" },
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
          expectRequest: {
            hasTools: ["search", "calculate"],
          },
          response: { role: "assistant", content: "ok", id: "tools-1" },
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
          expectRequest: {
            systemContains: "helpful assistant",
          },
          response: { role: "assistant", content: "ok", id: "sys-1" },
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

  it("throws LLMStreamError for streamed error events mid-stream", async () => {
    for (
      const chunks of [
        [
          JSON.stringify({ type: "text-delta", textDelta: "hello" }) + "\n",
          JSON.stringify({ type: "error", error: "boom" }) + "\n",
        ],
        [
          JSON.stringify({ type: "text-delta", textDelta: "hello" }) + "\n",
          JSON.stringify({ type: "error", error: "boom" }),
        ],
      ]
    ) {
      try {
        await runClientStream(client, chunks);
      } catch (error) {
        expect(error).toBeInstanceOf(LLMStreamError);
        expect((error as Error).message).toBe("boom");
        continue;
      }

      throw new Error("Expected LLMStreamError");
    }
  });

  it("preserves native model tool metadata from stream finish events", async () => {
    const nativeModelToolResults = [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: { query: "example" },
      sources: [{ url: "https://example.com" }],
    }];

    const result = await runClientStream(client, [
      JSON.stringify({ type: "text-delta", textDelta: "searched" }) + "\n",
      JSON.stringify({
        type: "finish",
        nativeModelToolResults,
      }) + "\n",
    ]);

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "searched" }],
      id: "trace-1",
      nativeModelToolResults,
    });
  });

  it("logs and ignores garbage lines mid-stream", async () => {
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    try {
      const result = await runClientStream(client, [
        JSON.stringify("hello") + "\n",
        "not json\n",
        "not final json",
      ]);

      expect(result).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        id: "trace-1",
      });
      expect(loggedErrors.length).toBe(2);
      expect(loggedErrors[0][0]).toBe("Failed to parse JSON line:");
      expect(loggedErrors[0][1]).toBe("not json");
      expect(loggedErrors[1][0]).toBe("Failed to parse final JSON line:");
      expect(loggedErrors[1][1]).toBe("not final json");
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("LLMClient authorized internal transport", () => {
  const client = new LLMClient();

  it("routes sendRequest through the injected fetch and endpoint", async () => {
    disableMockMode();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await client.sendRequest(
      {
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      },
      undefined,
      undefined,
      createInternalLLMBrokerRequestOptions({
        endpoint: new URL("https://broker.example/api/ai/llm"),
        fetch: (input, init) => {
          calls.push({ url: input.toString(), init });
          return Promise.resolve(Response.json({
            role: "assistant",
            content: "brokered",
          }, { headers: { "x-cf-llm-trace-id": "trace-broker" } }));
        },
      }),
    );

    expect(result.content).toBe("brokered");
    expect(calls[0]?.url).toBe("https://broker.example/api/ai/llm");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("routes generateObject through the injected fetch", async () => {
    disableMockMode();
    const calls: string[] = [];
    const result = await client.generateObject(
      {
        messages: [{ role: "user", content: "hello" }],
        schema: { type: "object" },
      },
      undefined,
      createInternalLLMBrokerRequestOptions({
        endpoint: new URL("https://broker.example/api/ai/llm"),
        fetch: (input) => {
          calls.push(input.toString());
          return Promise.resolve(Response.json({ object: { ok: true } }));
        },
      }),
    );

    expect(result.object).toEqual({ ok: true });
    expect(calls).toEqual([
      "https://broker.example/api/ai/llm/generateObject",
    ]);
  });
});
