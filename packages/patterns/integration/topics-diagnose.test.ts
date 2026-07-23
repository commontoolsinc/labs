import { assertEquals, assertRejects } from "@std/assert";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";
import {
  graphSummary,
  reportSafeErrorCode,
  runTopicsDiagnostics,
  settleSummary,
  TopicsDiagnosticsError,
} from "../tools/topics-diagnose.ts";

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

// Covered by tools/topics-diagnose-config.test.ts.

Deno.test("Topics diagnostics maps report errors to fixed safe codes", () => {
  assertEquals(
    reportSafeErrorCode(
      new TopicsDiagnosticsError("invalid-configuration"),
    ),
    "invalid-configuration",
  );
  assertEquals(
    reportSafeErrorCode(
      new TopicsDiagnosticsError("harness-initialization-failed"),
    ),
    "harness-initialization-failed",
  );
  assertEquals(
    reportSafeErrorCode(
      new TopicsDiagnosticsError("phase-verification-failed"),
    ),
    "phase-verification-failed",
  );
  assertEquals(
    reportSafeErrorCode(new TopicsDiagnosticsError("phase-operation-failed")),
    "phase-operation-failed",
  );
  assertEquals(
    reportSafeErrorCode(new TopicsDiagnosticsError("convergence-failed")),
    "convergence-failed",
  );
  assertEquals(
    reportSafeErrorCode(new Error("https://example.invalid/private?id=123")),
    "unknown-error",
  );
  assertEquals(
    reportSafeErrorCode({ message: "user-supplied input" }),
    "unknown-error",
  );
});

Deno.test("Topics diagnostics classifies invalid CLI configuration", async () => {
  let error: unknown;
  try {
    await runTopicsDiagnostics(["--topics=0"]);
  } catch (caught) {
    error = caught;
  }
  assertEquals(reportSafeErrorCode(error), "invalid-configuration");
});

Deno.test("Topics diagnostics reduces content-free runtime summaries", () => {
  const summaries = [
    {
      nodeCount: 3,
      edgeCount: 2,
      dirtyNodeCount: 1,
      pendingNodeCount: 0,
      settleHistoryEntryCount: 7,
      maxTrailingSettleDurationMs: 4,
    },
    {
      nodeCount: 5,
      edgeCount: 1,
      dirtyNodeCount: 0,
      pendingNodeCount: 2,
      settleHistoryEntryCount: 9,
      maxTrailingSettleDurationMs: 6,
    },
  ];
  assertEquals(graphSummary(summaries), {
    postSettleMaxNodesAcrossSessions: 5,
    postSettleMaxEdgesAcrossSessions: 2,
    postSettleMaxDirtyAcrossSessions: 1,
    postSettleMaxPendingAcrossSessions: 2,
  });
  assertEquals(settleSummary(summaries), {
    trailingCumulativeHistoryEntries: 16,
    maxTrailingSettleMs: 6,
  });
});

function assertTopicsDiagnosticsIpcShape(value: unknown): void {
  const forbiddenKey =
    /(?:did|fid|url|content|body|title|token|fingerprint|hash|piece.?id|(?:^|_)id|message|stack)/i;
  const forbiddenValue =
    /(?:did:|fid1:|https?:\/\/|diagnostic-(?:topic|title|body|comment|link))/i;
  if (typeof value === "string") {
    if (forbiddenValue.test(value)) throw new Error("unsafe diagnostic value");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertTopicsDiagnosticsIpcShape);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenKey.test(key)) {
        throw new Error(`unsafe diagnostic key: ${key}`);
      }
      assertTopicsDiagnosticsIpcShape(entry);
    }
  }
}

Deno.test("Topics diagnostics RPC responses are aggregate-only", async () => {
  const rootPath = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const harness = await MultiRuntimeHarness.create({
    programPath: new URL("../topics/main.tsx", import.meta.url).pathname,
    rootPath,
    diagnostics: true,
    aggregateOnlyDiagnostics: true,
    sessions: ["topics-diagnostics-ipc-a", "topics-diagnostics-ipc-b"],
  });
  try {
    assertEquals(harness.pieceId, "aggregate-only");
    const [first, second] = harness.sessions;
    const adds = await Promise.all([
      first.topicsDiagnosticsSend("addTopic", { title: "diagnostic-topic-1" }),
      second.topicsDiagnosticsSend("addTopic", { title: "diagnostic-topic-2" }),
    ]);
    await harness.diagnosticsBarrier();
    const summary = await first.topicsDiagnosticsSummary();
    await Promise.all(harness.sessions.map((session) => session.telemetry()));
    const sameValueOutcome = await first.topicsDiagnosticsSend(
      ["topics", 0, "setBody"],
      { body: "" },
      { idle: false },
    );
    await harness.diagnosticsBarrier();
    const sameValueTelemetry = await Promise.all(
      harness.sessions.map((session) => session.telemetry()),
    );
    const attemptedSameValueWrites = sameValueTelemetry.reduce(
      (total, entry) => total + entry.writeCount,
      0,
    );
    const changedSameValueWrites = sameValueTelemetry.reduce(
      (total, entry) => total + entry.changedWriteCount,
      0,
    );
    assertEquals(attemptedSameValueWrites > changedSameValueWrites, true);
    const set = await first.topicsDiagnosticsSet(
      ["topics", 0, "title"],
      "diagnostic-title",
    );
    const noop = await first.topicsDiagnosticsNoop(0);
    const churn = await first.topicsDiagnosticsChurn();
    const crossref = await first.topicsDiagnosticsCreateCrossref(1, 0);
    await harness.diagnosticsBarrier();
    const crossrefValidation = await first.topicsDiagnosticsValidateCrossrefs(
      2,
    );
    const prepares = await Promise.all(
      harness.sessions.map((session) =>
        session.topicsDiagnosticsPrepareReversedRoot({ idle: false })
      ),
    );
    const commits = await Promise.all(
      harness.sessions.map((session) =>
        session.topicsDiagnosticsCommitPreparedRoot()
      ),
    );
    const convergenceChannel = `topics-test-${crypto.randomUUID()}`;
    const convergenceReady = await first.topicsDiagnosticsConvergenceBegin(
      convergenceChannel,
      2,
    );
    const publish = await Promise.all(
      harness.sessions.map((session) =>
        session.topicsDiagnosticsConvergencePublish(convergenceChannel)
      ),
    );
    assertEquals(publish, [{ ok: true }, { ok: true }]);
    const finish = await first.topicsDiagnosticsConvergenceFinish();
    const cancel = await first.topicsDiagnosticsConvergenceCancel();
    const responses = {
      adds,
      summary,
      sameValueOutcome,
      sameValueTelemetry,
      set,
      noop,
      churn,
      crossref,
      crossrefValidation,
      prepares,
      commits,
      convergenceReady,
      publish,
      finish,
      cancel,
    };
    assertEquals(Object.keys(summary).sort(), [
      "comments",
      "links",
      "ok",
      "topics",
    ]);
    assertEquals(Object.keys(noop).sort(), [
      "directAccepted",
      "directRejected",
      "ok",
      "submitted",
    ]);
    assertEquals(Object.keys(crossrefValidation).sort(), [
      "ok",
      "validatedSources",
    ]);
    for (
      const outcome of [
        ...adds,
        sameValueOutcome,
        set,
        crossref,
        ...prepares,
        ...commits,
      ]
    ) {
      assertEquals(
        Object.keys(outcome).sort(),
        outcome.ok ? ["ok"] : ["error", "ok"],
      );
      assertEquals(outcome.ok || outcome.error === "operation-failed", true);
    }
    assertEquals(Object.keys(convergenceReady).sort(), ["ok", "ready"]);
    assertEquals(Object.keys(finish).sort(), ["converged", "ok", "summary"]);
    if (!finish.ok) throw new Error("convergence unexpectedly failed");
    assertEquals(Object.keys(finish.summary).sort(), [
      "comments",
      "links",
      "topics",
    ]);
    assertEquals(Object.keys(cancel).sort(), ["ok"]);
    assertTopicsDiagnosticsIpcShape(responses);
    const createWithoutPrivateBootstrap = await first.client().call(
      "createPiece",
    );
    assertEquals(createWithoutPrivateBootstrap, {
      ok: false,
      error: "operation-failed",
    });
    assertTopicsDiagnosticsIpcShape(createWithoutPrivateBootstrap);
    const reinitializeAsBootstrap = await first.client().call("init", {
      aggregateOnlyDiagnostics: true,
      aggregateBootstrapCreator: true,
      aggregateBootstrapChannel: `topics-test-${crypto.randomUUID()}`,
      aggregateBootstrapParticipants: 1,
    });
    assertEquals(reinitializeAsBootstrap, {
      ok: false,
      error: "operation-failed",
    });
    const createWithCallerChannel = await first.client().call("createPiece", {
      programPath: new URL("../topics/main.tsx", import.meta.url).pathname,
      rootPath,
      bootstrapChannel: `topics-test-${crypto.randomUUID()}`,
      bootstrapParticipants: 1,
    });
    assertEquals(createWithCallerChannel, {
      ok: false,
      error: "operation-failed",
    });
    assertTopicsDiagnosticsIpcShape({
      reinitializeAsBootstrap,
      createWithCallerChannel,
    });
    for (
      const forbiddenCall of [
        () => first.read(),
        () => first.readRaw(),
        () => first.rawRead({ id: "private", space: "private" }),
        () => first.link(),
        () => first.diagnostics(),
        () => first.loggerCounts(),
      ]
    ) {
      await assertRejects(forbiddenCall, Error, "operation-failed");
    }
  } finally {
    await harness.dispose();
  }
});

Deno.test("aggregate-only diagnostics reject remote storage before worker creation", async () => {
  await assertRejects(
    () =>
      MultiRuntimeHarness.create({
        programPath: new URL("../topics/main.tsx", import.meta.url).pathname,
        rootPath: new URL("..", import.meta.url).pathname,
        aggregateOnlyDiagnostics: true,
        apiUrl: new URL("https://example.invalid/"),
        sessions: ["remote-rejected"],
      }),
    Error,
    "aggregate-only diagnostics require the local in-process memory server",
  );
});
