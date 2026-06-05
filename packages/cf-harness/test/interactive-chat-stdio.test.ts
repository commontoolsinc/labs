import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatListEventsResult,
  type HarnessChatListTurnsResult,
  type HarnessChatStatusResult,
} from "../src/contracts/interactive-chat.ts";
import { HARNESS_BROWSER_ACCESS_LEASE_TYPE } from "../src/contracts/browser-access.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import {
  type HarnessInteractiveChatOutputEnvelope,
  parseHarnessInteractiveChatStdioCliOptions,
  runHarnessInteractiveChatNdjsonTransport,
  runHarnessInteractiveChatStdio,
} from "../src/interactive-chat-stdio.ts";
import type { HarnessPromptLoopResult } from "../src/prompt-loop.ts";

const decodeLines = (
  lines: readonly string[],
): HarnessInteractiveChatOutputEnvelope[] =>
  lines.map((line) => JSON.parse(line) as HarnessInteractiveChatOutputEnvelope);

const encodeInputLines = (
  lines: readonly string[],
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
};

const captureOutputLines = (): {
  output: WritableStream<Uint8Array>;
  lines: () => string[];
} => {
  const decoder = new TextDecoder();
  let text = "";
  return {
    output: new WritableStream({
      write(chunk) {
        text += decoder.decode(chunk, { stream: true });
      },
      close() {
        text += decoder.decode();
      },
    }),
    lines: () => text.split("\n").filter((line) => line.trim().length > 0),
  };
};

const runStdioCli = async (
  lines: readonly string[],
  args: readonly string[],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  envelopes: HarnessInteractiveChatOutputEnvelope[];
}> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      fromFileUrl(new URL("../src/interactive-chat-stdio.ts", import.meta.url)),
      ...args,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(encoder.encode(lines.map((line) => `${line}\n`).join("")));
  await writer.close();
  const output = await child.output();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  return {
    code: output.code,
    stdout,
    stderr,
    envelopes: decodeLines(
      stdout.split("\n").filter((line) => line.trim().length > 0),
    ),
  };
};

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

Deno.test("interactive NDJSON transport waits for active turns before close after write failure", async () => {
  let loopFinished = false;
  let resolveLoop: (() => void) | undefined;
  let closeBeforeLoopFinished = false;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
    createPromptLoop: () => ({
      runTranscript: async (options) => {
        await new Promise<void>((resolve) => {
          resolveLoop = resolve;
        });
        loopFinished = true;
        const finalMessage = {
          role: "assistant" as const,
          content: "done",
        };
        const transcript = [...options.transcript, finalMessage];
        await options.onTranscriptEvent?.({
          message: finalMessage,
          transcript,
        });
        return {
          model: "gpt-test",
          finalAssistantText: "done",
          transcript,
          modelTurns: 1,
          runState: {} as HarnessPromptLoopResult["runState"],
        };
      },
    }),
  });

  await assertRejects(
    () =>
      runHarnessInteractiveChatNdjsonTransport({
        lines: [
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-start-session",
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
            requestId: "req-start-turn",
            method: "start_turn",
            params: {
              sessionId: "session-1",
              turnId: "turn-1",
              input: { text: "finish later" },
            },
          }),
        ],
        createService: () => service,
        closeService: () => {
          closeBeforeLoopFinished = !loopFinished;
        },
        writeLine: (line) => {
          const envelope = JSON.parse(line) as Record<string, unknown>;
          if (envelope.requestId === "req-start-turn") {
            resolveLoop?.();
            throw new Error("simulated stdout failure");
          }
        },
      }),
    Error,
    "simulated stdout failure",
  );

  assertEquals(loopFinished, true);
  assertEquals(closeBeforeLoopFinished, false);
});

Deno.test("interactive NDJSON transport preserves write failure over close hook failure", async () => {
  let closeCalls = 0;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
  });

  await assertRejects(
    () =>
      runHarnessInteractiveChatNdjsonTransport({
        lines: [
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-start-session",
            method: "start_session",
            params: {
              sessionId: "session-1",
              workspace: { hostPath: "/workspace" },
              model: "gpt-test",
            },
          }),
        ],
        createService: () => service,
        closeService: () => {
          closeCalls += 1;
          throw new Error("simulated close failure");
        },
        writeLine: (line) => {
          const envelope = JSON.parse(line) as Record<string, unknown>;
          if (envelope.requestId === "req-start-session") {
            throw new Error("simulated stdout failure");
          }
        },
      }),
    Error,
    "simulated stdout failure",
  );

  assertEquals(closeCalls, 1);
});

Deno.test("interactive NDJSON transport calls close hook after normal completion", async () => {
  const output: string[] = [];
  let closeCalls = 0;
  const service = new HarnessInteractiveChatService({
    onEvent: async () => {},
  });

  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start-session",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
    ],
    createService: () => service,
    closeService: (closedService) => {
      assertEquals(closedService, service);
      closeCalls += 1;
    },
    writeLine: (line) => {
      output.push(line);
    },
  });

  assertEquals(closeCalls, 1);
  assertEquals(
    decodeLines(output).filter((envelope) => "ok" in envelope).map((
      envelope,
    ) => "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined),
    [["req-start-session", true]],
  );
});

Deno.test({
  name: "interactive stdio persists and restores SQLite chat runtime state",
  // Dynamic SQLite imports load a native library that @db/sqlite does not unload.
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "cf-harness-chat-stdio-",
    });
    const dbPath = join(tempDir, "chat.sqlite");
    const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
      runTranscript: async (options) => {
        const finalMessage = {
          role: "assistant" as const,
          content: "Persisted over stdio.",
        };
        const transcript = [...options.transcript, finalMessage];
        await options.onTranscriptEvent?.({
          message: finalMessage,
          transcript,
        });
        return {
          model: "gpt-test",
          finalAssistantText: "Persisted over stdio.",
          transcript,
          modelTurns: 1,
          runState: {} as HarnessPromptLoopResult["runState"],
        };
      },
    });
    try {
      const firstOutput = captureOutputLines();
      await runHarnessInteractiveChatStdio({
        sessionDbPath: dbPath,
        createPromptLoop,
        input: encodeInputLines([
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
              input: { text: "Remember this" },
            },
          }),
        ]),
        output: firstOutput.output,
      });
      assertEquals(
        decodeLines(firstOutput.lines()).filter((envelope) =>
          "event" in envelope
        )
          .map((envelope) => "event" in envelope ? envelope.event.kind : ""),
        [
          "session_started",
          "turn_started",
          "assistant_delta",
          "assistant_completed",
          "turn_completed",
        ],
      );

      const restoredOutput = captureOutputLines();
      await runHarnessInteractiveChatStdio({
        sessionDbPath: dbPath,
        createPromptLoop,
        input: encodeInputLines([
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-status",
            method: "status",
            params: {
              sessionId: "session-1",
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-events",
            method: "list_events",
            params: {
              sessionId: "session-1",
              afterSequence: 0,
            },
          }),
          JSON.stringify({
            type: HARNESS_CHAT_REQUEST_TYPE,
            protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
            requestId: "req-turns",
            method: "list_turns",
            params: {
              sessionId: "session-1",
              status: "completed",
            },
          }),
        ]),
        output: restoredOutput.output,
      });

      const restoredEnvelopes = decodeLines(restoredOutput.lines());
      const statusResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-status"
      );
      const statusResult = statusResponse !== undefined &&
          "ok" in statusResponse && statusResponse.ok
        ? statusResponse.result as HarnessChatStatusResult
        : undefined;
      assertEquals(
        statusResult?.sessions.map((session) => ({
          sessionId: session.sessionId,
          status: session.status,
          turnCount: session.turnCount,
        })),
        [{
          sessionId: "session-1",
          status: "idle",
          turnCount: 1,
        }],
      );

      const eventsResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-events"
      );
      const eventsResult = eventsResponse !== undefined &&
          "ok" in eventsResponse && eventsResponse.ok
        ? eventsResponse.result as HarnessChatListEventsResult
        : undefined;
      assertEquals(
        eventsResult?.events.map((event) => event.event.kind),
        [
          "session_started",
          "turn_started",
          "assistant_delta",
          "assistant_completed",
          "turn_completed",
        ],
      );

      const turnsResponse = restoredEnvelopes.find((envelope) =>
        "ok" in envelope && envelope.requestId === "req-turns"
      );
      const turnsResult =
        turnsResponse !== undefined && "ok" in turnsResponse &&
          turnsResponse.ok
          ? turnsResponse.result as HarnessChatListTurnsResult
          : undefined;
      assertEquals(
        turnsResult?.turns.map((turn) => ({
          turnId: turn.turn.turnId,
          status: turn.turn.status,
          input: turn.input,
        })),
        [{
          turnId: "turn-1",
          status: "completed",
          input: { text: "Remember this" },
        }],
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("interactive stdio CLI persists sessions across process invocations", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "cf-harness-chat-stdio-cli-",
  });
  const dbPath = join(tempDir, "chat.sqlite");
  try {
    const first = await runStdioCli([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start",
        method: "start_session",
        params: {
          sessionId: "cli-session-1",
          workspace: { hostPath: "/workspace" },
          model: "gpt-test",
        },
      }),
    ], ["--chat-session-db", dbPath]);
    assertEquals(first.code, 0, first.stderr);
    assertEquals(
      first.envelopes.filter((envelope) => "event" in envelope).map((
        envelope,
      ) => "event" in envelope ? envelope.event.kind : ""),
      ["session_started"],
    );
    assertEquals(
      first.envelopes.filter((envelope) => "ok" in envelope).map((
        envelope,
      ) => "ok" in envelope ? [envelope.requestId, envelope.ok] : undefined),
      [["req-start", true]],
    );

    const restored = await runStdioCli([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-status",
        method: "status",
        params: {
          sessionId: "cli-session-1",
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-events",
        method: "list_events",
        params: {
          sessionId: "cli-session-1",
          afterSequence: 0,
        },
      }),
    ], [`--chat-session-db=${dbPath}`]);
    assertEquals(restored.code, 0, restored.stderr);
    const statusResponse = restored.envelopes.find((envelope) =>
      "ok" in envelope && envelope.requestId === "req-status"
    );
    const statusResult = statusResponse !== undefined &&
        "ok" in statusResponse && statusResponse.ok
      ? statusResponse.result as HarnessChatStatusResult
      : undefined;
    assertEquals(
      statusResult?.sessions.map((session) => ({
        sessionId: session.sessionId,
        status: session.status,
        turnCount: session.turnCount,
      })),
      [{
        sessionId: "cli-session-1",
        status: "idle",
        turnCount: 0,
      }],
    );

    const eventsResponse = restored.envelopes.find((envelope) =>
      "ok" in envelope && envelope.requestId === "req-events"
    );
    const eventsResult = eventsResponse !== undefined &&
        "ok" in eventsResponse && eventsResponse.ok
      ? eventsResponse.result as HarnessChatListEventsResult
      : undefined;
    assertEquals(
      eventsResult?.events.map((event) => event.event.kind),
      ["session_started"],
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("interactive stdio bounds in-memory event replay when configured", async () => {
  const output = captureOutputLines();
  await runHarnessInteractiveChatStdio({
    maxInMemoryEvents: 0,
    input: encodeInputLines([
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-start",
        method: "start_session",
        params: {
          sessionId: "session-pruned",
          workspace: { hostPath: "/workspace" },
        },
      }),
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-events",
        method: "list_events",
        params: {
          sessionId: "session-pruned",
          afterSequence: 0,
        },
      }),
    ]),
    output: output.output,
  });

  const envelopes = decodeLines(output.lines());
  assertEquals(
    envelopes.filter((envelope) => "event" in envelope).map((envelope) =>
      "event" in envelope ? envelope.event.kind : undefined
    ),
    ["session_started"],
  );
  const response = envelopes.find((envelope) =>
    "ok" in envelope && envelope.requestId === "req-events"
  );
  const result = response !== undefined && "ok" in response && response.ok
    ? response.result as HarnessChatListEventsResult
    : undefined;
  assertEquals(result, {
    events: [],
    latestSequence: 1,
  });
});

Deno.test({
  name:
    "interactive stdio CLI reports invalid SQLite session DB startup failures",
  // Dynamic SQLite imports load a native library that @db/sqlite does not unload.
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "cf-harness-chat-stdio-bad-db-",
    });
    try {
      const result = await runStdioCli([], [
        "--chat-session-db",
        join(tempDir, "missing", "chat.sqlite"),
      ]);
      assertEquals(result.code, 1);
      assertEquals(result.stdout, "");
      assertEquals(result.envelopes, []);
      assertEquals(result.stderr.trim().length > 0, true);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("interactive stdio CLI parses runtime options", () => {
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([], {
      CF_HARNESS_CHAT_SESSION_DB: "/tmp/chat.sqlite",
    }),
    {
      sessionDbPath: "/tmp/chat.sqlite",
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-session-db",
      "/tmp/explicit.sqlite",
    ], {
      CF_HARNESS_CHAT_SESSION_DB: "/tmp/env.sqlite",
    }),
    {
      sessionDbPath: "/tmp/explicit.sqlite",
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([], {
      CF_HARNESS_CHAT_MAX_IN_MEMORY_EVENTS: "3",
    }),
    {
      maxInMemoryEvents: 3,
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-max-in-memory-events",
      "0",
    ], {}),
    {
      maxInMemoryEvents: 0,
      help: false,
    },
  );
  assertEquals(
    parseHarnessInteractiveChatStdioCliOptions([
      "--chat-session-db=/tmp/inline.sqlite",
      "--chat-max-in-memory-events=2",
      "--help",
    ], {}),
    {
      sessionDbPath: "/tmp/inline.sqlite",
      maxInMemoryEvents: 2,
      help: true,
    },
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events",
        "-1",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-negative integer value",
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events=1.5",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-negative integer value",
  );
  assertThrows(
    () =>
      parseHarnessInteractiveChatStdioCliOptions([
        "--chat-max-in-memory-events",
      ], {}),
    Error,
    "--chat-max-in-memory-events requires a non-empty value",
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

Deno.test("interactive NDJSON transport accepts list_turns requests", async () => {
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
        method: "list_turns",
        params: {
          sessionId: "session-1",
          status: "completed",
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
      turns: [],
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
            profileMode: "transient",
            accountAccess: "none",
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

Deno.test("interactive NDJSON transport rejects invalid Browser Access profile mode", async () => {
  const output: string[] = [];
  await runHarnessInteractiveChatNdjsonTransport({
    lines: [
      JSON.stringify({
        type: HARNESS_CHAT_REQUEST_TYPE,
        protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
        requestId: "req-bad-browser-mode",
        method: "start_session",
        params: {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
          browserAccess: {
            type: HARNESS_BROWSER_ACCESS_LEASE_TYPE,
            leaseId: "lease-1",
            cdpUrl: "http://127.0.0.1:9222",
            profileMode: "loggedout",
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
