import { assertEquals } from "@std/assert";
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
    fetchFn: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
});
