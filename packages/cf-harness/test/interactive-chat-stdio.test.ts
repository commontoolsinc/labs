import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import { HARNESS_BROWSER_ACCESS_LEASE_TYPE } from "../src/contracts/browser-access.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
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

Deno.test("interactive NDJSON transport accepts list_events requests", async () => {
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
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "list_events",
        params: {
          sessionId: "session-1",
          afterSequence: 0,
          limit: 10,
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-2"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
  assertEquals(
    response !== undefined && "ok" in response && response.ok
      ? response.result
      : undefined,
    {
      events: [decodeLines(output)[0]],
      latestSequence: 1,
    },
  );
});

Deno.test("interactive NDJSON transport rejects unsupported methods", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-method",
        method: "delete_everything",
        params: {},
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport validates method-specific params", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-turn",
        method: "start_turn",
        params: {
          sessionId: "session-1",
          input: {},
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport rejects malformed policy params", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-policy",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport rejects malformed policy prompt slots", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-prompt-slot",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
            allowedToolIds: ["write_file"],
            allowedSubagentProfiles: [],
            promptSlot: {
              role: "direct-command",
            },
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport accepts valid policy prompt slots", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-good-prompt-slot",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          policy: {
            type: "cf-harness.chat-policy",
            toolMode: "workspace-write",
            allowedToolIds: ["write_file"],
            allowedSubagentProfiles: [],
            promptSlot: {
              type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
              source: "comment-1",
              role: "direct-command",
              kernelName: "loom",
              surface: "comment-thread",
            },
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-good-prompt-slot"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
});

Deno.test("interactive NDJSON transport rejects malformed Browser Access leases", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-browser-access",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {},
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output)[0];
  assertEquals("ok" in response ? response.ok : true, false);
  assertEquals(
    "ok" in response && response.ok === false ? response.error.code : "",
    "invalid_request",
  );
});

Deno.test("interactive NDJSON transport accepts valid Browser Access leases", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-good-browser-access",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {
            type: HARNESS_BROWSER_ACCESS_LEASE_TYPE,
            leaseId: "lease-1",
            cdpUrl: "http://127.0.0.1:9222",
            owner: "loom",
          },
        },
      }),
    ],
    writeLine: (line) => {
      output.push(line);
    },
  });

  const response = decodeLines(output).find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-good-browser-access"
  );
  assertEquals(
    response !== undefined && "ok" in response ? response.ok : false,
    true,
  );
});
