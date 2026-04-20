import { assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";

Deno.test("OpenAICompatibleGatewayClient resolves endpoint URLs against the base URL", () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
  });

  assertEquals(
    client.endpoint("/v1/models").toString(),
    "https://llm.stage.commontools.dev/v1/models",
  );
  assertEquals(
    client.endpoint("/v1/chat/completions").toString(),
    "https://llm.stage.commontools.dev/v1/chat/completions",
  );
});

Deno.test("OpenAICompatibleGatewayClient forwards requests through the injected fetch implementation", async () => {
  const calls: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
  });

  await client.listModels();
  await client.createChatCompletion({ model: "gpt-5.4", messages: [] });

  assertEquals(
    (calls[0].input as URL).toString(),
    "https://llm.stage.commontools.dev/v1/models",
  );
  assertEquals(
    (calls[1].input as URL).toString(),
    "https://llm.stage.commontools.dev/v1/chat/completions",
  );
  assertEquals(calls[1].init?.method, "POST");
  assertEquals(
    new Headers(calls[1].init?.headers).get("authorization"),
    "Bearer test-key",
  );
});

Deno.test("OpenAICompatibleGatewayClient omits authorization headers in no-auth mode", async () => {
  const calls: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    authMode: "none",
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
  });

  await client.createChatCompletion({ model: "gpt-5.4", messages: [] });

  assertEquals(
    new Headers(calls[0].init?.headers).get("authorization"),
    null,
  );
});

Deno.test("OpenAICompatibleGatewayClient parses successful chat completion JSON responses", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "ok" },
            }],
          }),
          { status: 200 },
        ),
      ),
  });

  const response = await client.createChatCompletionJson({
    model: "gpt-5.4",
    messages: [],
  });

  assertEquals(response.choices[0]?.message.content, "ok");
});

Deno.test("OpenAICompatibleGatewayClient surfaces chat completion errors with response text", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        new Response("bad request", {
          status: 400,
          statusText: "Bad Request",
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat completion request failed (400): bad request",
  );
});

Deno.test("OpenAICompatibleGatewayClient fails clearly when no API key is configured", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    fetchFn: () =>
      Promise.resolve(
        new Response("should not be called", {
          status: 500,
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
  );
});

Deno.test("OpenAICompatibleGatewayClient fails clearly on placeholder API keys", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "...",
    apiKeySource: "CF_HARNESS_API_KEY",
    fetchFn: () =>
      Promise.resolve(
        new Response("should not be called", {
          status: 500,
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "CF_HARNESS_API_KEY is set to a placeholder value ('...'); provide a real API key",
  );
});

Deno.test("OpenAICompatibleGatewayClient surfaces 401s with API key source context", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    apiKeySource: "CF_HARNESS_API_KEY",
    fetchFn: () =>
      Promise.resolve(
        new Response("organization rejected", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat completion request failed (401, api key source: CF_HARNESS_API_KEY; backend rejected the supplied key): organization rejected",
  );
});

Deno.test("OpenAICompatibleGatewayClient surfaces 401s in no-auth mode without implying caller auth", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    authMode: "none",
    fetchFn: () =>
      Promise.resolve(
        new Response("organization rejected", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat completion request failed (401, unauthenticated caller mode was used; gateway or upstream credentials rejected the request): organization rejected",
  );
});
