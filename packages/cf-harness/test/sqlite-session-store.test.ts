import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  createHarnessChatEventEnvelope,
  createHarnessChatSessionStatus,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatListEventsResult,
} from "../src/contracts/interactive-chat.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { LoomLocalHostBinding } from "../src/contracts/run-manifest.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import {
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
} from "../src/contracts/transcript.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-05-27T00:00:${String(counter).padStart(2, "0")}.000Z`;
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

const localHostPromptLoopOptions = (
  binding: LoomLocalHostBinding,
  model?: string,
): CreateHarnessPromptLoopOptions => ({
  modelProvider: binding.modelProvider,
  modelAuthSource: binding.modelAuthSource,
  credentialOwner: binding.credentialOwner,
  credentialOwnerKey: binding.credentialOwner.ownerKey,
  harnessHomeIdentity: binding.harnessHomeIdentity,
  ...(model !== undefined ? { model } : {}),
  runManifest: {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    ...binding,
    ...(model !== undefined ? { model } : {}),
  },
});

Deno.test("sqlite session store rejects unsupported URL schemes", async () => {
  await assertRejects(
    () =>
      openSqliteHarnessChatSessionStore({
        url: new URL("https://example.com/chat.sqlite"),
      }),
    Error,
    "unsupported SQLite chat session store URL protocol: https:; expected file:",
  );
});

Deno.test("sqlite session store persists chat sessions and replayable events", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const result = makeResult(options, "Persisted.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });

  try {
    const service = new HarnessInteractiveChatService({
      createPromptLoop,
      now: nextIsoNow(),
      sessionStore: store,
    });

    await service.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
      metadata: { source: "sqlite-test" },
    });
    await service.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Remember this" },
      metadata: { origin: "first-turn" },
    });
    await service.waitForTurn("session-1", "turn-1");

    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((turn) => ({
        turnId: turn.turn.turnId,
        status: turn.turn.status,
        input: turn.input,
        metadata: turn.metadata,
      })),
      [{
        turnId: "turn-1",
        status: "completed",
        input: { text: "Remember this" },
        metadata: { origin: "first-turn" },
      }],
    );
    assertEquals(
      (await store.listEvents({ sessionId: "session-1", afterSequence: 2 }))
        .map((event) => event.event.kind),
      ["assistant_delta", "assistant_completed", "turn_completed"],
    );
    assertEquals(await store.latestSequence(), 5);

    const restored = new HarnessInteractiveChatService({
      createPromptLoop,
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].status, "idle");
    assertEquals(restored.status("session-1").sessions[0].turnCount, 1);
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) =>
        turn.turn.status
      ),
      ["completed"],
    );
    assertEquals(
      restored.status("session-1").sessions[0].metadata,
      { source: "sqlite-test" },
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 1 }).events
        .map((event) => event.event.kind),
      [
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ],
    );

    await restored.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Continue after restart" },
    });
    await restored.waitForTurn("session-1", "turn-2");

    assertEquals(await store.latestSequence(), 9);
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 5 }).events
        .map((event) => [event.sequence, event.event.kind]),
      [
        [6, "turn_started"],
        [7, "assistant_delta"],
        [8, "assistant_completed"],
        [9, "turn_completed"],
      ],
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) => [
        turn.turn.turnId,
        turn.turn.status,
      ]),
      [["turn-1", "completed"], ["turn-2", "completed"]],
    );

    const duplicate = await new HarnessInteractiveChatService({
      createPromptLoop,
      sessionStore: store,
    }).startSession("req-duplicate", {
      sessionId: "session-1",
      workspace: { hostPath: "/other" },
    });
    assertEquals(duplicate.ok, false);
    assertEquals(
      duplicate.ok === false ? duplicate.error.code : "",
      "session_exists",
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart rejects changed or missing local Loom bindings before model traffic", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey: "local",
  } as const;
  const gatewayBinding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "api-key",
    credentialOwner,
    harnessHomeIdentity: "sha256:home-a",
  };
  const codexBinding: LoomLocalHostBinding = {
    ...gatewayBinding,
    modelProvider: "openai-codex",
    modelAuthSource: "cf-harness-local-store",
  };
  let promptLoopCreations = 0;
  let modelCalls = 0;

  try {
    const original = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(gatewayBinding),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    const started = await original.startSession("req-start", {
      sessionId: "session-gateway",
      workspace: { hostPath: "/workspace" },
      model: "gpt-session",
    });
    assertEquals(started.ok, true);
    assertEquals(store.getSession("session-gateway")?.session, {
      ...original.status("session-gateway").sessions[0],
      model: "gpt-session",
      loomLocalHostBinding: gatewayBinding,
    });

    store.saveSession({
      session: createHarnessChatSessionStatus({
        sessionId: "session-legacy",
        workspace: { hostPath: "/workspace" },
        model: "gpt-session",
      }),
      transcript: [],
    });

    const restored = new HarnessInteractiveChatService({
      credentialOwner,
      basePromptLoopOptions: {
        ...localHostPromptLoopOptions(codexBinding),
        modelClient: {
          providerId: "openai-codex",
          credentialOwner,
          complete: () => {
            modelCalls += 1;
            return Promise.reject(new Error("unexpected model call"));
          },
        },
      },
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();

    const changedProvider = await restored.startTurn("req-old", {
      sessionId: "session-gateway",
      turnId: "turn-old",
      input: { text: "Do not migrate this transcript" },
    });
    assertEquals(changedProvider.ok, false);
    assertEquals(
      changedProvider.ok === false ? changedProvider.error.code : undefined,
      "provider-mismatch",
    );

    const missingBinding = await restored.startTurn("req-legacy", {
      sessionId: "session-legacy",
      turnId: "turn-legacy",
      input: { text: "Do not use an unbound transcript" },
    });
    assertEquals(missingBinding.ok, false);
    assertEquals(
      missingBinding.ok === false ? missingBinding.error.code : undefined,
      "provider-mismatch",
    );

    const newSession = await restored.startSession("req-new", {
      sessionId: "session-codex",
      workspace: { hostPath: "/workspace" },
      model: "gpt-new-session",
    });
    assertEquals(newSession.ok, true);
    assertEquals(
      newSession.ok ? newSession.result.loomLocalHostBinding : undefined,
      codexBinding,
    );
    assertEquals(
      newSession.ok ? newSession.result.model : undefined,
      "gpt-new-session",
    );
    assertEquals(restored.listTurns().turns, []);
    assertEquals(promptLoopCreations, 0);
    assertEquals(modelCalls, 0);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart rejects a changed local Loom model before model traffic", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "none",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "local",
    },
    harnessHomeIdentity: "sha256:home-a",
  };
  let promptLoopCreations = 0;

  try {
    const original = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-a"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    const started = await original.startSession("req-start", {
      sessionId: "session-model-a",
      workspace: { hostPath: "/workspace" },
    });
    assertEquals(started.ok ? started.result.model : undefined, "gpt-a");

    const restored = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-b"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();
    const turn = await restored.startTurn("req-turn", {
      sessionId: "session-model-a",
      turnId: "turn-model-a",
      input: { text: "Keep the original model" },
    });

    assertEquals(turn.ok, false);
    assertEquals(
      turn.ok === false ? turn.error.code : undefined,
      "provider-mismatch",
    );
    assertEquals(restored.listTurns().turns, []);
    assertEquals(promptLoopCreations, 0);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart validates every durable local Loom binding field", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "none",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "local",
      tenantKey: "tenant-a",
    },
    harnessHomeIdentity: "sha256:home-a",
  };
  const cases = [
    {
      name: "auth",
      binding: { ...binding, modelAuthSource: "api-key" as const },
    },
    {
      name: "owner",
      binding: {
        ...binding,
        credentialOwner: { ...binding.credentialOwner, tenantKey: "tenant-b" },
      },
    },
    {
      name: "home",
      binding: { ...binding, harnessHomeIdentity: "sha256:home-b" },
    },
    { name: "model", binding, model: undefined },
  ];
  let promptLoopCreations = 0;

  try {
    for (const testCase of cases) {
      store.saveSession({
        session: createHarnessChatSessionStatus({
          sessionId: `session-${testCase.name}`,
          workspace: { hostPath: "/workspace" },
          ...(testCase.model === undefined && testCase.name === "model"
            ? {}
            : { model: "gpt-a" }),
          loomLocalHostBinding: testCase.binding,
        }),
        transcript: [],
      });
    }

    const restored = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-a"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        throw new Error("must not create a prompt loop");
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();

    for (const testCase of cases) {
      const result = await restored.startTurn(`req-${testCase.name}`, {
        sessionId: `session-${testCase.name}`,
        turnId: `turn-${testCase.name}`,
        input: { text: "Do not cross the durable binding" },
      });
      assertEquals(result.ok, false, testCase.name);
      assertEquals(
        result.ok === false ? result.error.code : undefined,
        "provider-mismatch",
        testCase.name,
      );
    }
    assertEquals(promptLoopCreations, 0);
    assertEquals(restored.listTurns().turns, []);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session replay survives bounded in-memory event retention", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const result = makeResult(options, "Pruned from memory.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });

  try {
    const service = new HarnessInteractiveChatService({
      createPromptLoop,
      now: nextIsoNow(),
      sessionStore: store,
      maxInMemoryEvents: 2,
    });

    await service.startSession("req-1", {
      sessionId: "session-pruned",
      workspace: { hostPath: "/workspace" },
    });
    await service.startTurn("req-2", {
      sessionId: "session-pruned",
      turnId: "turn-1",
      input: { text: "Generate enough events to prune" },
    });
    await service.waitForTurn("session-pruned", "turn-1");

    assertEquals(
      service.events("session-pruned").map((event) => event.event.kind),
      ["assistant_completed", "turn_completed"],
    );

    const replay = await service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-replay",
      method: "list_events",
      params: {
        sessionId: "session-pruned",
        afterSequence: 0,
      },
    });
    assertEquals(replay.ok, true);
    const result = replay.ok
      ? replay.result as HarnessChatListEventsResult
      : undefined;
    assertEquals(result?.latestSequence, 5);
    assertEquals(
      result?.events.map((event) => event.event.kind),
      [
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store persists session snapshots and events atomically", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const initialSession = createHarnessChatSessionStatus({
      sessionId: "session-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "before" },
    });
    store.saveSessionAndAppendEvent(
      {
        session: initialSession,
        transcript: [],
      },
      createHarnessChatEventEnvelope({
        sessionId: "session-atomic",
        sequence: 1,
        emittedAt: "2026-05-27T00:00:01.000Z",
        event: {
          kind: "session_started",
          session: initialSession,
        },
      }),
    );

    const updatedSession = createHarnessChatSessionStatus({
      sessionId: "session-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "after" },
    });
    assertThrows(() =>
      store.saveSessionAndAppendEvent(
        {
          session: updatedSession,
          transcript: [{ role: "assistant", content: "should rollback" }],
        },
        createHarnessChatEventEnvelope({
          sessionId: "session-atomic",
          sequence: 1,
          emittedAt: "2026-05-27T00:00:02.000Z",
          event: {
            kind: "status_changed",
            session: updatedSession,
          },
        }),
      )
    );

    assertEquals(
      store.getSession("session-atomic")?.session.metadata,
      { version: "before" },
    );
    assertEquals(store.getSession("session-atomic")?.transcript, []);
    assertEquals(await store.latestSequence(), 1);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store persists turn session event mutations atomically", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const initialSession = createHarnessChatSessionStatus({
      sessionId: "session-turn-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "before" },
    });
    store.saveSessionAndAppendEvent(
      {
        session: initialSession,
        transcript: [],
      },
      createHarnessChatEventEnvelope({
        sessionId: "session-turn-atomic",
        sequence: 1,
        emittedAt: "2026-05-27T00:00:01.000Z",
        event: {
          kind: "session_started",
          session: initialSession,
        },
      }),
    );

    const turn = {
      turnId: "turn-1",
      status: "running" as const,
      startedAt: "2026-05-27T00:00:02.000Z",
      updatedAt: "2026-05-27T00:00:02.000Z",
    };
    const updatedSession = {
      ...initialSession,
      status: "turn_running" as const,
      reusable: true,
      activeTurnId: turn.turnId,
      activeTurn: turn,
      turnCount: 1,
      updatedAt: "2026-05-27T00:00:02.000Z",
      metadata: { version: "after" },
    };

    assertThrows(() =>
      store.saveSessionTurnAndAppendEvent({
        session: {
          session: updatedSession,
          transcript: [{ role: "user", content: "should rollback" }],
        },
        turn: {
          sessionId: "session-turn-atomic",
          turn,
          input: { text: "should rollback" },
          policy: initialSession.policy,
        },
        createTurn: true,
        event: createHarnessChatEventEnvelope({
          sessionId: "session-turn-atomic",
          turnId: turn.turnId,
          sequence: 1,
          emittedAt: "2026-05-27T00:00:02.000Z",
          event: {
            kind: "turn_started",
            turn,
          },
        }),
      })
    );

    assertEquals(
      store.getSession("session-turn-atomic")?.session.metadata,
      { version: "before" },
    );
    assertEquals(store.getSession("session-turn-atomic")?.transcript, []);
    assertEquals(store.getTurn("session-turn-atomic", "turn-1"), undefined);
    assertEquals(await store.latestSequence(), 1);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store restores and terminalizes interrupted turns", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const stalled = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: () =>
          new Promise<HarnessPromptLoopResult>(() => {
            // Simulates a process dying while a turn is still in flight.
          }),
      }),
      now: nextIsoNow(),
      sessionStore: store,
    });

    await stalled.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
    });
    await stalled.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "This will be interrupted" },
    });

    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((turn) =>
        turn.turn.status
      ),
      ["running"],
    );

    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Recovered.")),
      }),
      now: () => "2026-05-27T00:01:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].status, "idle");
    assertEquals(restored.status("session-1").sessions[0].reusable, true);
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
      "failed",
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns[0].turn.error
        ?.details,
      {
        terminalReason: "process_interrupted",
        priorStatus: "running",
      },
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 2 }).events
        .map((event) => [event.sequence, event.event.kind]),
      [[3, "turn_failed"]],
    );

    const followUp = await restored.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Continue" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-2");
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) => [
        turn.turn.turnId,
        turn.turn.status,
      ]),
      [["turn-1", "failed"], ["turn-2", "completed"]],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore keeps closed sessions closed while terminalizing turns", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const turn = {
      turnId: "turn-closed",
      status: "running" as const,
      startedAt: "2026-05-27T00:00:01.000Z",
      updatedAt: "2026-05-27T00:00:01.000Z",
    };
    const session = {
      ...createHarnessChatSessionStatus({
        sessionId: "session-closed",
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      }),
      status: "closed" as const,
      reusable: false,
      activeTurnId: turn.turnId,
      activeTurn: turn,
      closedAt: "2026-05-27T00:00:02.000Z",
      updatedAt: "2026-05-27T00:00:02.000Z",
    };
    store.saveSession({
      session,
      transcript: [],
    });
    store.saveTurn({
      sessionId: "session-closed",
      turn,
      input: { text: "interrupted under closed session" },
      policy: session.policy,
    });

    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      now: () => "2026-05-27T00:01:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(
      restored.status("session-closed").sessions[0].status,
      "closed",
    );
    assertEquals(
      restored.status("session-closed").sessions[0].reusable,
      false,
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-closed" }).turns[0].turn.status,
      "failed",
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-closed" }).events.map((
        event,
      ) => event.event.kind),
      ["turn_failed"],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

const toolCall = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "read_file", arguments: "{}" },
});

/**
 * A loop that reports an assistant message declaring two tool calls and then as
 * many of their results as `resultsBeforeFault` names, before handing control
 * to `fault`. Every fault point CT-2069 names is one value of that pair.
 */
const partialToolTurnLoop = (
  resultsBeforeFault: number,
  fault: () => Promise<HarnessPromptLoopResult>,
): HarnessInteractivePromptLoopFactory =>
() => ({
  runTranscript: async (options) => {
    const assistant = {
      role: "assistant" as const,
      content: "Reading both files.",
      toolCalls: [toolCall("call-a"), toolCall("call-b")],
    };
    const transcript: HarnessTranscriptMessage[] = [
      ...options.transcript,
      assistant,
    ];
    await options.onTranscriptEvent?.({ message: assistant, transcript });
    for (const id of ["call-a", "call-b"].slice(0, resultsBeforeFault)) {
      const message = {
        role: "tool" as const,
        toolCallId: id,
        toolName: "read_file",
        content: `contents for ${id}`,
      };
      transcript.push(message);
      await options.onTranscriptEvent?.({ message, transcript });
    }
    return await fault();
  },
});

/**
 * Complete one turn, fail a second after partial tool progress, rebuild the
 * service from the same store, and report the transcript the next turn's prompt
 * loop is handed.
 */
const transcriptAfterFaultedTurn = async (
  resultsBeforeFault: number,
): Promise<readonly HarnessTranscriptMessage[]> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    let turn = 0;
    const service = new HarnessInteractiveChatService({
      createPromptLoop: (options) => {
        turn += 1;
        if (turn === 1) {
          return {
            runTranscript: (runOptions) =>
              Promise.resolve(makeResult(runOptions, "Read the first.")),
          };
        }
        return partialToolTurnLoop(
          resultsBeforeFault,
          () => Promise.reject(new Error("read_file exhausted its budget")),
        )(options);
      },
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
      input: { text: "Read the first file" },
    });
    await service.waitForTurn("session-1", "turn-1");
    await service.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Read both files" },
    });
    await service.waitForTurn("session-1", "turn-2");

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();
    const followUp = await restored.startTurn("req-4", {
      sessionId: "session-1",
      turnId: "turn-3",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-3");
    return next;
  } finally {
    store.close();
    await Deno.remove(path);
  }
};

const RESUMED_AFTER_FIRST_TURN: readonly HarnessTranscriptMessage[] = [
  { role: "user", content: "Read the first file" },
  { role: "assistant", content: "Read the first." },
  { role: "user", content: "Try again" },
];

Deno.test("sqlite session restore is provider-valid after a turn dies having declared two tool calls", async () => {
  const next = await transcriptAfterFaultedTurn(0);
  assertEquals(next, RESUMED_AFTER_FIRST_TURN);
  assertEquals(inspectHarnessTranscriptPairing(next).valid, true);
});

Deno.test("sqlite session restore is provider-valid after a turn dies between two tool results", async () => {
  const next = await transcriptAfterFaultedTurn(1);
  assertEquals(next, RESUMED_AFTER_FIRST_TURN);
  assertEquals(inspectHarnessTranscriptPairing(next).valid, true);
});

Deno.test("sqlite session restore keeps a reusable checkpoint when a turn is interrupted mid-tool", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    let turn = 0;
    // Resolves once the interrupted turn has durably emitted everything it is
    // ever going to, so the restore below reads a settled store rather than
    // racing the writes.
    let reachFault: (() => void) | undefined;
    const reachedFault = new Promise<void>((resolve) => {
      reachFault = () => resolve();
    });
    const stalled = new HarnessInteractiveChatService({
      createPromptLoop: (options) => {
        turn += 1;
        if (turn === 1) {
          return {
            runTranscript: (runOptions) =>
              Promise.resolve(makeResult(runOptions, "Read the first.")),
          };
        }
        return partialToolTurnLoop(
          1,
          () => {
            reachFault?.();
            // Simulates the process dying between two tool results.
            return new Promise<HarnessPromptLoopResult>(() => {});
          },
        )(options);
      },
      now: nextIsoNow(),
      sessionStore: store,
    });
    await stalled.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
    });
    await stalled.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Read the first file" },
    });
    await stalled.waitForTurn("session-1", "turn-1");
    await stalled.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Read both files" },
    });
    await reachedFault;
    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((record) => [
        record.turn.turnId,
        record.turn.status,
      ]),
      [["turn-1", "completed"], ["turn-2", "running"]],
    );

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    const session = restored.status("session-1").sessions[0];
    assertEquals(session.status, "idle");
    assertEquals(session.reusable, true);
    const interrupted = restored.listTurns({ sessionId: "session-1" }).turns
      .find((record) => record.turn.turnId === "turn-2");
    assertEquals(interrupted?.turn.status, "failed");
    assertEquals(interrupted?.turn.error?.details, {
      terminalReason: "process_interrupted",
      priorStatus: "running",
    });
    // The interrupted turn's tool history is still on the audit trail even
    // though its model history was rolled back.
    assertEquals(
      restored.listEvents({ sessionId: "session-1" }).events.filter((event) =>
        event.event.kind === "tool_started"
      ).length,
      2,
    );

    await restored.startTurn("req-4", {
      sessionId: "session-1",
      turnId: "turn-3",
      input: { text: "Try again" },
    });
    await restored.waitForTurn("session-1", "turn-3");
    assertEquals(next, RESUMED_AFTER_FIRST_TURN);
    assertEquals(inspectHarnessTranscriptPairing(next).valid, true);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

const recordedSession = (transcript: readonly HarnessTranscriptMessage[]) => ({
  session: createHarnessChatSessionStatus({
    sessionId: "session-1",
    createdAt: "2026-05-27T00:00:01.000Z",
    workspace: { hostPath: "/workspace" },
  }),
  transcript,
});

Deno.test("sqlite session restore rolls a truncated recorded transcript back to its safe boundary", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    await store.saveSession(recordedSession([
      { role: "user", content: "Read the first file" },
      { role: "assistant", content: "Read the first." },
      {
        role: "assistant",
        content: "Reading both files.",
        toolCalls: [toolCall("call-a"), toolCall("call-b")],
      },
    ]));

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].reusable, true);
    assertEquals(
      restored.listEvents({ sessionId: "session-1" }).events.map((event) =>
        event.event.kind
      ),
      ["status_changed"],
    );
    assertEquals(
      (await store.getSession("session-1"))?.transcript,
      [
        { role: "user", content: "Read the first file" },
        { role: "assistant", content: "Read the first." },
      ],
    );

    const followUp = await restored.startTurn("req-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-1");
    assertEquals(next, RESUMED_AFTER_FIRST_TURN);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore refuses a structurally corrupt recorded transcript", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    await store.saveSession(recordedSession([
      { role: "user", content: "Read the first file" },
      {
        role: "tool",
        toolCallId: "call-ghost",
        toolName: "read_file",
        content: "contents nobody asked for",
      },
    ]));

    let reachedTheLoop = false;
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          reachedTheLoop = true;
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].reusable, false);
    const followUp = await restored.startTurn("req-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, false);
    assertEquals(
      followUp.ok === false ? followUp.error.code : "",
      "incomplete_transcript",
    );
    assertEquals(
      followUp.ok === false
        ? (followUp.error.details?.defects as { kind: string }[])[0].kind
        : "",
      "orphan_tool_result",
    );
    assertEquals(reachedTheLoop, false);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});
