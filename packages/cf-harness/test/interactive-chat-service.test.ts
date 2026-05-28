import { assertEquals } from "@std/assert";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatBrowserAccessLease,
  type HarnessChatRequestEnvelope,
} from "../src/contracts/interactive-chat.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessChatSessionStore } from "../src/session-store.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-05-22T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

const makeResult = (
  options: RunHarnessTranscriptOptions,
  finalAssistantText: string,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-test",
  finalAssistantText,
  transcript: [
    ...options.transcript,
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {} as HarnessPromptLoopResult["runState"],
});

const browserAccess: HarnessChatBrowserAccessLease = {
  type: "cf-harness.chat.browser-access-lease",
  leaseId: "lease-1",
  cdpUrl: "http://127.0.0.1:9222",
  owner: "loom",
};

Deno.test("interactive service starts sessions and completes non-streaming turns", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: async (runOptions) => {
        const result = makeResult(runOptions, "Done.");
        await runOptions.onTranscriptEvent?.({
          message: result.transcript[result.transcript.length - 1],
          transcript: result.transcript,
        });
        return result;
      },
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
    randomUUID: () => "generated-id",
  });

  const startSession = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-1",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace", cwd: "/workspace/project" },
      model: "gpt-test",
    },
  });
  assertEquals(startSession.ok, true);

  const startTurn = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-2",
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Hi" },
    },
  });
  assertEquals(startTurn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].turnCount, 1);
  assertEquals(
    service.listEvents({ sessionId: "session-1", afterSequence: 2 }).events
      .map((event) => event.event.kind),
    ["assistant_delta", "assistant_completed", "turn_completed"],
  );
  assertEquals(
    service.listEvents({ sessionId: "session-1" }).latestSequence,
    5,
  );
  assertEquals(loopOptions[0], {
    workspaceHostPath: "/workspace",
    cwd: "/workspace/project",
    model: "gpt-test",
    allowedToolIds: [
      "bash",
      "read_file",
      "view_image",
      "read_skill_resource",
      "edit_file",
      "write_file",
      "delegate_task",
    ],
    allowedSubagentProfiles: ["default"],
  });
});

Deno.test("interactive service forces comment-thread turns to read-only prompt-loop options", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: (runOptions) =>
        Promise.resolve(makeResult(runOptions, "Readonly.")),
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    context: {
      type: "comment-thread",
      threadId: "thread-1",
    },
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: [
        "bash",
        "read_file",
        "edit_file",
        "write_file",
        "delegate_task",
      ],
      allowedSubagentProfiles: ["default"],
    },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Read only please" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(loopOptions[0], {
    workspaceHostPath: "/workspace",
    allowedToolIds: ["read_file", "view_image", "read_skill_resource"],
    allowedSubagentProfiles: [],
  });
  assertEquals(service.status("session-1").sessions[0].policy, {
    type: "cf-harness.chat-policy",
    toolMode: "read-only",
    allowedToolIds: ["read_file", "view_image", "read_skill_resource"],
    allowedSubagentProfiles: [],
  });
});

Deno.test("interactive service passes Browser Access leases to browser-profile turns", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: (runOptions) =>
        Promise.resolve(makeResult(runOptions, "Browser.")),
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    browserAccess,
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
  });
  const turn = await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Inspect the browser" },
  });
  assertEquals(turn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(loopOptions[0], {
    workspaceHostPath: "/workspace",
    allowedToolIds: ["delegate_task"],
    allowedSubagentProfiles: ["browser"],
    browserAccess,
  });
});

Deno.test("interactive service rejects browser-profile turns without Browser Access leases", async () => {
  let createdLoop = false;
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => {
      createdLoop = true;
      return {
        runTranscript: (runOptions) =>
          Promise.resolve(makeResult(runOptions, "Browser.")),
      };
    },
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
  });
  const turn = await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Inspect the browser" },
  });

  assertEquals(turn.ok, false);
  assertEquals(
    turn.ok === false ? turn.error.code : "",
    "browser_access_required",
  );
  assertEquals(createdLoop, false);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started"],
  );
});

Deno.test("interactive service maps tool transcript messages to tool and file events", async () => {
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (runOptions) => {
      const assistantMessage = {
        role: "assistant" as const,
        content: "",
        toolCalls: [{
          id: "tool-write-1",
          type: "function" as const,
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "notes.md",
              content: "hello",
            }),
          },
        }],
      };
      const toolMessage = {
        role: "tool" as const,
        toolCallId: "tool-write-1",
        toolName: "write_file",
        content: JSON.stringify({
          outputId: "run-1:write_file:1",
          path: "/workspace/notes.md",
          mode: "replace",
        }),
      };
      const finalMessage = {
        role: "assistant" as const,
        content: "Wrote notes.",
      };
      const transcript = [
        ...runOptions.transcript,
        assistantMessage,
        toolMessage,
        finalMessage,
      ];
      await runOptions.onTranscriptEvent?.({
        message: assistantMessage,
        transcript: [...runOptions.transcript, assistantMessage],
      });
      await runOptions.onTranscriptEvent?.({
        message: toolMessage,
        transcript: [...runOptions.transcript, assistantMessage, toolMessage],
      });
      await runOptions.onTranscriptEvent?.({
        message: finalMessage,
        transcript,
      });
      return {
        model: "gpt-test",
        finalAssistantText: "Wrote notes.",
        transcript,
        modelTurns: 2,
        runState: {} as HarnessPromptLoopResult["runState"],
      };
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Write notes" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "tool_started",
      "tool_completed",
      "file_changed",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  const fileEvent = service.events("session-1").find((event) =>
    event.event.kind === "file_changed"
  );
  assertEquals(fileEvent?.event, {
    kind: "file_changed",
    change: {
      kind: "update",
      path: "/workspace/notes.md",
      summary: "write_file replace",
    },
  });
});

Deno.test("interactive service aborts canceled turns without closing the session", async () => {
  let runCount = 0;
  let firstSignal: AbortSignal | undefined;
  let finishFirstTurn: (() => void) | undefined;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      runCount += 1;
      if (runCount === 1) {
        firstSignal = options.signal;
        return await new Promise<HarnessPromptLoopResult>(
          (resolve) => {
            finishFirstTurn = () =>
              resolve(makeResult(options, "Ignored after cancel."));
          },
        );
      }
      const result = makeResult(options, "Second answer.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  const canceled = await service.cancelTurn(
    "req-3",
    "session-1",
    "turn-1",
    "user_requested",
  );
  assertEquals(canceled.ok, true);
  assertEquals(firstSignal instanceof AbortSignal, true);
  assertEquals(firstSignal?.aborted, true);
  assertEquals(service.status("session-1").sessions[0].status, "canceling");
  assertEquals(service.status("session-1").sessions[0].reusable, false);
  const earlySecondTurn = await service.startTurn("req-early", {
    sessionId: "session-1",
    turnId: "turn-early",
    input: { text: "Too soon" },
  });
  assertEquals(earlySecondTurn.ok, false);
  assertEquals(
    earlySecondTurn.ok === false ? earlySecondTurn.error.code : "",
    "turn_already_running",
  );

  finishFirstTurn?.();
  await service.waitForTurn("session-1", "turn-1");
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started", "turn_started", "turn_canceled", "status_changed"],
  );

  const secondTurn = await service.startTurn("req-4", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Again" },
  });
  assertEquals(secondTurn.ok, true);
  await service.waitForTurn("session-1", "turn-2");

  assertEquals(runCount, 2);
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(service.status("session-1").sessions[0].turnCount, 2);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "turn_canceled",
      "status_changed",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
});

Deno.test("interactive service aborts active turns when closing a session", async () => {
  let activeSignal: AbortSignal | undefined;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      activeSignal = options.signal;
      return await new Promise<HarnessPromptLoopResult>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        }, { once: true });
      });
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  const closed = await service.closeSession("req-3", "session-1", "done");
  assertEquals(closed.ok, true);
  assertEquals(activeSignal instanceof AbortSignal, true);
  assertEquals(activeSignal?.aborted, true);
  assertEquals(service.status("session-1").sessions[0].status, "closed");
  assertEquals(service.status("session-1").sessions[0].reusable, false);

  await service.waitForTurn("session-1", "turn-1");
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started", "turn_started", "session_closed"],
  );
});

Deno.test("interactive service closes sessions and filters status", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startSession("req-2", {
    sessionId: "session-2",
    workspace: { hostPath: "/other-workspace" },
  });

  assertEquals(service.status().sessions.length, 2);
  assertEquals(service.status("session-1").sessions.length, 1);

  const closed = await service.closeSession("req-3", "session-1", "done");
  assertEquals(closed.ok, true);
  assertEquals(service.status("session-1").sessions[0].status, "closed");
  assertEquals(service.status("session-1").sessions[0].reusable, false);

  const startTurn = await service.startTurn("req-4", {
    sessionId: "session-1",
    input: { text: "Hello again" },
  });
  assertEquals(startTurn.ok, false);
  assertEquals(
    startTurn.ok === false ? startTurn.error.code : "",
    "session_closed",
  );
});

Deno.test("interactive service rejects duplicate session ids", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });
  const first = await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const duplicate = await service.startSession("req-2", {
    sessionId: "session-1",
    workspace: { hostPath: "/other-workspace" },
  });

  assertEquals(first.ok, true);
  assertEquals(duplicate.ok, false);
  assertEquals(
    duplicate.ok === false ? duplicate.error.code : "",
    "session_exists",
  );
  assertEquals(service.status().sessions.length, 1);
  assertEquals(
    service.status("session-1").sessions[0].workspace?.hostPath,
    "/workspace",
  );
});

Deno.test("interactive service rejects concurrent duplicate session creation after durable checks", async () => {
  let releaseDurableCheck: (() => void) | undefined;
  const durableCheck = new Promise<undefined>((resolve) => {
    releaseDurableCheck = () => resolve(undefined);
  });
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => durableCheck,
    listSessions: () => [],
    saveSessionAndAppendEvent: () => {},
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  const first = service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const duplicate = service.startSession("req-2", {
    sessionId: "session-1",
    workspace: { hostPath: "/other-workspace" },
  });
  releaseDurableCheck?.();
  const [firstResult, duplicateResult] = await Promise.all([
    first,
    duplicate,
  ]);

  assertEquals(firstResult.ok, true);
  assertEquals(duplicateResult.ok, false);
  assertEquals(
    duplicateResult.ok === false ? duplicateResult.error.code : "",
    "session_exists",
  );
  assertEquals(service.status().sessions.length, 1);
  assertEquals(
    service.status("session-1").sessions[0].workspace?.hostPath,
    "/workspace",
  );
});

Deno.test("interactive service serializes concurrent emitted event sequences", async () => {
  const persistedSequences: number[] = [];
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: async (_snapshot, event) => {
      await Promise.resolve();
      persistedSequences.push(event.sequence);
    },
    appendEvent: async (event) => {
      await Promise.resolve();
      persistedSequences.push(event.sequence);
    },
    listEvents: () => [],
    latestSequence: () => 0,
  };
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const first = { role: "assistant" as const, content: "First." };
      const second = { role: "assistant" as const, content: "Second." };
      const firstTranscript = [...options.transcript, first];
      const secondTranscript = [...firstTranscript, second];
      const firstEvent = options.onTranscriptEvent?.({
        message: first,
        transcript: firstTranscript,
      }) ?? Promise.resolve();
      const secondEvent = options.onTranscriptEvent?.({
        message: second,
        transcript: secondTranscript,
      }) ?? Promise.resolve();
      await Promise.all([firstEvent, secondEvent]);
      return {
        model: "gpt-test",
        finalAssistantText: "Second.",
        transcript: secondTranscript,
        modelTurns: 1,
        runState: {} as HarnessPromptLoopResult["runState"],
      };
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Hi" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assertEquals(persistedSequences, [1, 2, 3, 4, 5, 6, 7]);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_delta",
      "assistant_completed",
      "assistant_completed",
      "turn_completed",
    ],
  );
});

Deno.test("interactive service rejects missing sessions and concurrent turns", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });

  const missing = await service.handleRequest(
    {
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-missing",
      method: "start_turn",
      params: {
        sessionId: "missing",
        input: { text: "Hi" },
      },
    } satisfies HarnessChatRequestEnvelope<"start_turn">,
  );
  assertEquals(missing.ok, false);
  assertEquals(
    missing.ok === false ? missing.error.code : "",
    "session_not_found",
  );

  let release: (() => void) | undefined;
  const busyService = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ transcript: [] }, "Done."));
        }),
    }),
    now: nextIsoNow(),
  });
  await busyService.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await busyService.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "First" },
  });
  const concurrent = await busyService.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Second" },
  });
  assertEquals(concurrent.ok, false);
  assertEquals(
    concurrent.ok === false ? concurrent.error.code : "",
    "turn_already_running",
  );
  release?.();
  await busyService.waitForTurn("session-1", "turn-1");
});
