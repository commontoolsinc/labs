import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  disableMockMode,
  enableMockMode,
  LLMClient,
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
