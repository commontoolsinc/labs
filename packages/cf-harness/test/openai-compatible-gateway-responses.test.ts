import { assertEquals } from "@std/assert";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import {
  OpenAICompatibleGatewayModelClient,
  usesResponsesApi,
} from "../src/model/openai-compatible-gateway.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";

const GATEWAY = "https://gateway.test";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const clientWith = (
  captured: Captured[],
  bodies: unknown[],
): OpenAICompatibleGatewayModelClient => {
  let call = 0;
  return new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      fetchFn: (input, init) => {
        captured.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    }),
  );
};

const turn = (
  overrides: Partial<HarnessModelTurnRequest> = {},
): HarnessModelTurnRequest => ({
  model: "gpt-5.6-terra",
  transcript: [{ role: "user", content: "Read the notes." }],
  tools: [{
    toolId: "read_file",
    title: "Read file",
    description: "Read a file",
    effectClass: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }],
  nativeModelToolIds: [],
  runId: "run-responses",
  ...overrides,
});

const completedResponse = (output: unknown[]) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output,
});

Deno.test("gpt-5.6 turns go to the Responses API with reasoning enabled", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    }]),
  ]);

  const result = await client.complete(turn());

  assertEquals(captured[0].url, `${GATEWAY}/v1/responses`);
  const body = captured[0].body;
  assertEquals(body.model, "gpt-5.6-terra");
  assertEquals(body.store, false);
  // Reasoning must not be disabled the way the Chat Completions workaround did.
  assertEquals(body.reasoning_effort, undefined);
  assertEquals(body.include, ["reasoning.encrypted_content"]);
  // Tools use the Responses shape: a flat name, not { function: { name } }.
  assertEquals(body.tools, [{
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: null,
  }]);
  assertEquals(result.assistant.content, "Done.");
});

Deno.test("gpt-5.6 tool calls survive alongside reasoning", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted-reasoning-blob",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call-1",
        name: "read_file",
        arguments: JSON.stringify({ path: "notes.txt" }),
      },
    ]),
  ]);

  const result = await client.complete(turn());

  assertEquals(result.assistant.toolCalls, [{
    id: "call-1",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "notes.txt" }),
    },
  }]);
  // The encrypted reasoning item is retained so the next turn can replay it.
  const state = result.assistant.providerContinuation?.state as {
    output: Array<Record<string, unknown>>;
    sourceModel: string;
  };
  assertEquals(
    result.assistant.providerContinuation?.providerId,
    "openai-compatible-gateway",
  );
  assertEquals(state.sourceModel, "gpt-5.6-terra");
  assertEquals(state.output[0].encrypted_content, "encrypted-reasoning-blob");
});

Deno.test("reasoning items are replayed on the following turn", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "All set.", annotations: [] }],
    }]),
  ]);

  const transcript: HarnessTranscriptMessage[] = [
    { role: "user", content: "Read the notes." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
      providerContinuation: {
        providerId: "openai-compatible-gateway",
        state: {
          version: 1,
          sourceModel: "gpt-5.6-terra",
          output: [{
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-reasoning-blob",
          }],
          functionCallItemIds: { "call-1": "fc_1" },
        },
      },
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "file contents",
    },
  ];

  await client.complete(turn({ transcript }));

  const input = captured[0].body.input as Array<Record<string, unknown>>;
  assertEquals(input[0].role, "user");
  // The encrypted reasoning item is replayed ahead of the call it produced.
  assertEquals(input[1], {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "encrypted-reasoning-blob",
  });
  // The recorded item id is reattached so the provider can match the call.
  assertEquals(input[2].type, "function_call");
  assertEquals(input[2].id, "fc_1");
  assertEquals(input[3], {
    type: "function_call_output",
    call_id: "call-1",
    output: "file contents",
  });
});

Deno.test("non-OpenAI models and native tools stay on Chat Completions", async () => {
  // The gateway cannot translate the Responses schema for Vertex-backed
  // models, and provider-native tools have no Responses equivalent there.
  assertEquals(usesResponsesApi("gpt-5.6-sol", []), true);
  assertEquals(usesResponsesApi("gpt-5.5", []), true);
  assertEquals(usesResponsesApi("gemini-3.5-flash", []), false);
  assertEquals(usesResponsesApi("claude-opus-5", []), false);
  assertEquals(usesResponsesApi("gpt-5.6-sol", ["google_search"]), false);

  const captured: Captured[] = [];
  const client = clientWith(captured, [{
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Searched." },
    }],
  }]);

  await client.complete(turn({ model: "gemini-3.5-flash" }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/chat/completions`);
});

Deno.test("a turn without a system message sends no instructions", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_3",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }]),
  ]);

  await client.complete(turn());
  assertEquals(captured[0].body.instructions, undefined);

  await client.complete(turn({
    transcript: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi." },
    ],
  }));
  assertEquals(captured[1].body.instructions, "Be brief.");
});
