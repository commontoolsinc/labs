import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MultiRuntimeHarness } from "../integration/multi-runtime-harness.ts";
import {
  casesFromArgs,
  configFromArgs,
  deriveTelemetry,
  rootOscillationMetadata,
  writePathShape,
} from "./topics-diagnose-config.ts";
import {
  graphSummary,
  reportSafeErrorCode,
  runTopicsDiagnostics,
  settleSummary,
  TopicsDiagnosticsError,
} from "./topics-diagnose.ts";

Deno.test("Topics diagnostics validates explicit matrix arguments", () => {
  const config = configFromArgs([
    "--topics=2,4",
    "--users=1,3",
    "--rounds=2",
    "--typing-steps=3",
    "--sessions-per-user=2",
    "--ws-delay-ms=5",
    "--scenario=comments,bodies",
  ]);
  assertEquals(config.topicCounts, [2, 4]);
  assertEquals(config.userCounts, [1, 3]);
  assertEquals(config.scenarios, ["comments", "bodies"]);
  assertEquals(casesFromArgs(["--cases=2x1,4x3"], config), [
    { topics: 2, users: 1 },
    { topics: 4, users: 3 },
  ]);
  assertThrows(() => configFromArgs(["--topics="]));
  assertThrows(() => configFromArgs(["--users=0"]));
  assertThrows(() => configFromArgs(["--scenario=unknown"]));
  assertThrows(() => casesFromArgs(["--cases=2by3"], config));
});

Deno.test("Topics diagnostics requires two topics for crossrefs only", () => {
  const crossrefs = configFromArgs(["--scenario=crossrefs"]);
  assertThrows(() => casesFromArgs(["--cases=1x1"], crossrefs));
  const generatedCrossrefs = configFromArgs([
    "--topics=1",
    "--users=1",
    "--scenario=crossrefs",
  ]);
  assertThrows(() => casesFromArgs([], generatedCrossrefs));
  const comments = configFromArgs(["--scenario=comments"]);
  assertEquals(casesFromArgs(["--cases=1x1"], comments), [{
    topics: 1,
    users: 1,
  }]);
});

Deno.test("Topics diagnostics applies conflicts profile defaults before explicit overrides", () => {
  const conflicts = configFromArgs(["--profile=conflicts"]);
  assertEquals(conflicts, {
    profile: "conflicts",
    program: "topics/main.tsx",
    topicCounts: [2],
    userCounts: [2],
    rounds: 4,
    typingSteps: 2,
    sessionsPerUser: 2,
    wsDelayMs: 10,
    scenarios: ["root-oscillation"],
  });
  assertEquals(configFromArgs(["--profile=conflicts", "--quick"]).rounds, 2);

  const overridden = configFromArgs([
    "--profile=conflicts",
    "--topics=3",
    "--users=4",
    "--rounds=7",
    "--typing-steps=6",
    "--sessions-per-user=1",
    "--ws-delay-ms=0",
    "--scenario=comments",
  ]);
  assertEquals(overridden.topicCounts, [3]);
  assertEquals(overridden.userCounts, [4]);
  assertEquals(overridden.rounds, 7);
  assertEquals(overridden.typingSteps, 6);
  assertEquals(overridden.sessionsPerUser, 1);
  assertEquals(overridden.wsDelayMs, 0);
  assertEquals(overridden.scenarios, ["comments"]);
  assertThrows(() => configFromArgs(["--profile=missing"]));
});

Deno.test("Topics diagnostics keeps root oscillation opt-in for matrix runs", () => {
  assertEquals(configFromArgs(["--quick"]).scenarios, [
    "names",
    "create-topics",
    "noops",
    "titles",
    "comments",
    "links",
    "bodies",
    "crossrefs",
  ]);
  assertEquals(
    configFromArgs(["--quick", "--scenario=all"]).scenarios.at(-1),
    "root-oscillation",
  );
});

Deno.test("Topics diagnostics validates root oscillation topology", () => {
  const oneTopic = configFromArgs([
    "--profile=conflicts",
    "--topics=1",
  ]);
  assertThrows(() => casesFromArgs([], oneTopic));
  const oneSession = configFromArgs([
    "--profile=conflicts",
    "--users=1",
    "--sessions-per-user=1",
  ]);
  assertThrows(() => casesFromArgs([], oneSession));
  const zeroRounds = configFromArgs([
    "--profile=conflicts",
    "--rounds=0",
  ]);
  assertThrows(() => casesFromArgs([], zeroRounds));
  const oneRound = configFromArgs([
    "--profile=conflicts",
    "--rounds=1",
  ]);
  assertEquals(casesFromArgs([], oneRound), [{ topics: 2, users: 2 }]);
});

Deno.test("Topics diagnostics derives write amplification ratios without negatives", () => {
  const telemetry = {
    invocationCount: 2,
    distinctInvokedEventCount: 2,
    distinctSuccessfulEventCount: 1,
    distinctDroppedEventCount: 1,
    droppedEventsByReason: {
      "piece-load": 0,
      lineage: 1,
      preflight: 0,
      "load-gate": 0,
    },
    permanentRejectionsByReason: {
      "origin-committed": 0,
      "receipt-exists": 1,
    },
    commitMarkerCount: 3,
    directCommitCount: 0,
    successfulCommitCount: 2,
    failedAttemptCount: 1,
    terminalFailureCount: 0,
    retryMarkerCount: 1,
    maxRetryAttempt: 2,
    readCount: 4,
    writeCount: 5,
    changedWriteCount: 3,
    writesTruncatedCount: 0,
    writesByPathShape: { "value/*": 3 },
  };
  assertEquals(deriveTelemetry(telemetry, 2), {
    changedWritesPerSubmittedOperation: 1.5,
    attemptedWritesPerSubmittedOperation: 2.5,
    elidedNoopCandidateWrites: 2,
  });
  assertEquals(deriveTelemetry({ ...telemetry, changedWriteCount: 8 }, 0), {
    changedWritesPerSubmittedOperation: 0,
    attemptedWritesPerSubmittedOperation: 0,
    elidedNoopCandidateWrites: 0,
  });
});

Deno.test("Topics diagnostics redacts write path keys", () => {
  const shape = writePathShape("value/did:key:private/topic-content/17");
  assertEquals(shape, "value/*/*/#");
  assertEquals(shape.includes("did:key"), false);
  assertEquals(shape.includes("content"), false);
});

Deno.test("Topics diagnostics reports bounded root oscillation repeat metadata", () => {
  assertEquals(rootOscillationMetadata([]), {
    distinctStateCount: 0,
    targetWriteCount: 0,
    twoStepEligibleCount: 0,
    twoStepRepeatCount: 0,
    twoStepRepeatRatio: null,
  });
  assertEquals(rootOscillationMetadata([0]), {
    distinctStateCount: 1,
    targetWriteCount: 1,
    twoStepEligibleCount: 0,
    twoStepRepeatCount: 0,
    twoStepRepeatRatio: null,
  });
  assertEquals(rootOscillationMetadata([0, 1]), {
    distinctStateCount: 2,
    targetWriteCount: 2,
    twoStepEligibleCount: 0,
    twoStepRepeatCount: 0,
    twoStepRepeatRatio: null,
  });
  assertEquals(rootOscillationMetadata([0, 1, 0, 1]), {
    distinctStateCount: 2,
    targetWriteCount: 4,
    twoStepEligibleCount: 2,
    twoStepRepeatCount: 2,
    twoStepRepeatRatio: 1,
  });
});

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
