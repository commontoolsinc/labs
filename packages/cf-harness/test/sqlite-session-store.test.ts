import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
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
    });
    await service.waitForTurn("session-1", "turn-1");

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
