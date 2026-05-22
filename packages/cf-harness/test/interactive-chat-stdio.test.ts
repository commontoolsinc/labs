import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import {
  type HarnessInteractiveChatOutputEnvelope,
  runHarnessInteractiveChatNdjsonTransport,
} from "../src/interactive-chat-stdio.ts";
import type { HarnessPromptLoopResult } from "../src/prompt-loop.ts";

const decodeLines = (
  lines: readonly string[],
): HarnessInteractiveChatOutputEnvelope[] =>
  lines.map((line) => JSON.parse(line) as HarnessInteractiveChatOutputEnvelope);

Deno.test("interactive NDJSON transport emits events and responses", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "start_turn",
        params: {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Hello" },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
    createService: (onEvent) =>
      new HarnessInteractiveChatService({
        onEvent,
        now: (() => {
          let counter = 0;
          return () =>
            `2026-05-22T00:00:${String(++counter).padStart(2, "0")}.000Z`;
        })(),
        createPromptLoop: () => ({
          runTranscript: async (options) => {
            const finalMessage = {
              role: "assistant" as const,
              content: "Hello from cf-harness.",
            };
            const transcript = [...options.transcript, finalMessage];
            await options.onTranscriptEvent?.({
              message: finalMessage,
              transcript,
            });
            return {
              model: "gpt-test",
              finalAssistantText: "Hello from cf-harness.",
              transcript,
              modelTurns: 1,
              runState: {} as HarnessPromptLoopResult["runState"],
            };
          },
        }),
      }),
  });

  const envelopes = decodeLines(output);
  assertEquals(
    envelopes.filter((envelope) => "event" in envelope).map((envelope) =>
      "event" in envelope ? envelope.event.kind : ""
    ),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  assertEquals(
    envelopes.filter((envelope) => "ok" in envelope).map((envelope) =>
      "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined
    ),
    [["req-1", true], ["req-2", true]],
  );
});

Deno.test("interactive NDJSON transport returns structured parse errors", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: ["not json"],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const envelopes = decodeLines(output);
  assertEquals(envelopes.length, 1);
  const response = envelopes[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
  assertStringIncludes(
    "ok" in response && response.ok === false ? response.error.message : "",
    "failed to parse chat request JSON:",
  );
});
