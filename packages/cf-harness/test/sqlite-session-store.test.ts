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
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";

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
