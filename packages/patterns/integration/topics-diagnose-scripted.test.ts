import { assertEquals } from "@std/assert";
import type {
  CommitTelemetrySnapshot,
  MultiRuntimeHarnessOptions,
  RuntimeDiagnosticsSummary,
  RuntimeTelemetrySnapshot,
  TopicsDiagnosticsChurnTotals,
  TopicsDiagnosticsCrossrefValidation,
  TopicsDiagnosticsNoopOutcome,
  TopicsDiagnosticsOperationOutcome,
  TopicsDiagnosticsSummary,
} from "./multi-runtime-harness.ts";
import {
  createTopicsDiagnosticsHarness,
  runTopicsDiagnostics,
  runTopicsDiagnosticsCli,
  type TopicsDiagnosticsCase,
  type TopicsDiagnosticsConfig,
  TopicsDiagnosticsError,
  type TopicsDiagnosticsErrorCode,
  type TopicsDiagnosticsHarness,
  type TopicsDiagnosticsReport,
  type TopicsDiagnosticsSession,
} from "../tools/topics-diagnose.ts";

interface Script {
  cardinalityFailure?: boolean;
  concurrentFailure?: boolean;
  convergence?: "begin" | "publish" | "finish" | "different";
  crossrefFailure?: boolean;
  noopFailure?: boolean;
  root?: "prepare-failure" | "same-outcomes" | "invalid-telemetry";
  sequentialFailure?: boolean;
  setFailure?: boolean;
  telemetryFailure?: boolean;
  unexpectedFailure?: boolean;
}

const telemetry = (successfulEvents = 0): RuntimeTelemetrySnapshot => ({
  invocationCount: successfulEvents,
  distinctInvokedEventCount: successfulEvents,
  distinctSuccessfulEventCount: successfulEvents,
  distinctDroppedEventCount: 0,
  droppedEventsByReason: {
    "piece-load": 0,
    lineage: 0,
    preflight: 0,
    "load-gate": 0,
  },
  permanentRejectionsByReason: { "origin-committed": 0, "receipt-exists": 0 },
  commitMarkerCount: successfulEvents,
  directCommitCount: 0,
  successfulCommitCount: successfulEvents,
  failedAttemptCount: 0,
  terminalFailureCount: 0,
  retryMarkerCount: 0,
  maxRetryAttempt: 0,
  readCount: 0,
  writeCount: successfulEvents,
  changedWriteCount: successfulEvents,
  writesTruncatedCount: 0,
  writesByPathShape: successfulEvents === 0
    ? {}
    : { "value/field": successfulEvents },
});

const memoryTelemetry = (script: Script): CommitTelemetrySnapshot => ({
  transactCount: 0,
  acceptedCount: 0,
  rejectedCount: 0,
  conflictCount: script.root === "invalid-telemetry" ? 0 : 1,
  replayCount: 0,
  receivedCommitBytes: { total: 0, max: 0 },
  confirmedReadEntries: { total: 0, max: 0 },
  confirmedReadBytes: { total: 0, max: 0 },
  operationEntries: { total: 0, max: 0 },
  operationBytes: { total: 0, max: 0 },
  newlyPersistedRevisions: { total: 0, max: 0 },
  operationsByType: { set: 0, patch: 0, delete: 0, sqlite: 0 },
  receivedPatchOperationsByType: {
    replace: 0,
    add: 0,
    remove: 0,
    move: 0,
    splice: 0,
    append: 0,
    "add-unique": 0,
    "remove-by-value": 0,
    increment: 0,
  },
  newlyAppliedPatchOperationsByType: {
    replace: 0,
    add: 0,
    remove: 0,
    move: 0,
    splice: 0,
    append: 0,
    "add-unique": 0,
    "remove-by-value": 0,
    increment: 0,
  },
  patchesByPathShape: {
    "value-root": script.root === "invalid-telemetry" ? 0 : 2,
  },
  rejectedByName: {},
});

class ScriptedHarness implements TopicsDiagnosticsHarness {
  readonly sessions: readonly TopicsDiagnosticsSession[];
  readonly crossrefs: [number, number][] = [];
  #comments = 0;
  #commitCount = 0;
  #links = 0;
  #queuedEvents = 0;
  #topics = 0;
  cancelCalls = 0;
  disposeCalls = 0;
  readonly sensitiveInputs: string[] = [];

  constructor(
    readonly topicCount: number,
    sessionCount: number,
    readonly script: Script = {},
  ) {
    this.sessions = Array.from(
      { length: sessionCount },
      () => new ScriptedSession(this),
    );
  }

  async diagnosticsBarrier(): Promise<void> {
    await Promise.resolve();
    if (this.script.unexpectedFailure) {
      throw new Error("private runtime failure");
    }
  }

  memoryTelemetry(): CommitTelemetrySnapshot {
    return memoryTelemetry(this.script);
  }

  async dispose(): Promise<void> {
    await Promise.resolve();
    this.disposeCalls++;
  }

  counts(): { topics: number; comments: number; links: number } {
    return {
      topics: this.#topics,
      comments: this.#comments,
      links: this.#links,
    };
  }

  summary(): TopicsDiagnosticsSummary {
    const counts = this.counts();
    return this.script.cardinalityFailure
      ? {
        ok: true,
        topics: counts.topics + 1,
        comments: counts.comments,
        links: counts.links,
      }
      : {
        ok: true,
        ...counts,
      };
  }

  enqueue(): void {
    this.#queuedEvents++;
  }

  nextTelemetry(): RuntimeTelemetrySnapshot {
    const snapshot = telemetry(
      this.#queuedEvents + (this.script.telemetryFailure ? 1 : 0),
    );
    this.#queuedEvents = 0;
    return snapshot;
  }

  addTopic(): TopicsDiagnosticsOperationOutcome {
    if (this.script.sequentialFailure && this.#topics === 0) {
      return { ok: false };
    }
    if (this.script.concurrentFailure) return { ok: false };
    this.#topics++;
    this.enqueue();
    return { ok: true };
  }

  addComment(): TopicsDiagnosticsOperationOutcome {
    if (this.script.concurrentFailure) return { ok: false };
    this.#comments++;
    this.enqueue();
    return { ok: true };
  }

  addLink(): TopicsDiagnosticsOperationOutcome {
    if (this.script.concurrentFailure) return { ok: false };
    this.#links++;
    this.enqueue();
    return { ok: true };
  }

  prepare(): TopicsDiagnosticsOperationOutcome {
    return { ok: this.script.root !== "prepare-failure" };
  }

  commit(): TopicsDiagnosticsOperationOutcome {
    const ok = this.script.root === "same-outcomes" ||
      this.#commitCount++ % 2 === 0;
    return { ok };
  }

  churn(): TopicsDiagnosticsChurnTotals {
    const rootConflictOccurred = this.#commitCount > 0;
    return {
      commitConflicts: rootConflictOccurred ? 1 : 0,
      commitPreempted: 0,
      commitHeldRevert: 0,
      commitHeldSent: 0,
      commitReverts: rootConflictOccurred ? 1 : 0,
      commitRejected: 0,
    };
  }
}

class ScriptedSession implements TopicsDiagnosticsSession {
  constructor(readonly harness: ScriptedHarness) {}

  async diagnosticsSummary(): Promise<RuntimeDiagnosticsSummary> {
    await Promise.resolve();
    return {
      nodeCount: 0,
      edgeCount: 0,
      dirtyNodeCount: 0,
      pendingNodeCount: 0,
      settleHistoryEntryCount: 0,
      maxTrailingSettleDurationMs: 0,
    };
  }

  async telemetry(): Promise<RuntimeTelemetrySnapshot> {
    await Promise.resolve();
    return this.harness.nextTelemetry();
  }

  async topicsDiagnosticsSummary(): Promise<TopicsDiagnosticsSummary> {
    await Promise.resolve();
    return this.harness.summary();
  }

  async topicsDiagnosticsChurn(): Promise<TopicsDiagnosticsChurnTotals> {
    await Promise.resolve();
    return this.harness.churn();
  }

  async topicsDiagnosticsSend(
    ...[target, input]: Parameters<
      TopicsDiagnosticsSession["topicsDiagnosticsSend"]
    >
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    await Promise.resolve();
    if (input !== undefined) {
      this.harness.sensitiveInputs.push(JSON.stringify(input));
    }
    if (target === "addTopic") return this.harness.addTopic();
    if (Array.isArray(target) && target.at(-1) === "addComment") {
      return this.harness.addComment();
    }
    if (Array.isArray(target) && target.at(-1) === "addLink") {
      return this.harness.addLink();
    }
    if (this.harness.script.concurrentFailure) return { ok: false };
    this.harness.enqueue();
    return { ok: true };
  }

  async topicsDiagnosticsSet(
    ...[_path, value]: Parameters<
      TopicsDiagnosticsSession["topicsDiagnosticsSet"]
    >
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    await Promise.resolve();
    this.harness.sensitiveInputs.push(JSON.stringify(value));
    return { ok: !this.harness.script.setFailure };
  }

  async topicsDiagnosticsNoop(): Promise<TopicsDiagnosticsNoopOutcome> {
    await Promise.resolve();
    const ok = !this.harness.script.noopFailure;
    if (ok) this.harness.enqueue();
    return {
      ok,
      submitted: 1,
      directAccepted: ok ? 1 : 0,
      directRejected: ok ? 0 : 1,
    };
  }

  async topicsDiagnosticsPrepareReversedRoot(): Promise<
    TopicsDiagnosticsOperationOutcome
  > {
    await Promise.resolve();
    return this.harness.prepare();
  }

  async topicsDiagnosticsCommitPreparedRoot(): Promise<
    TopicsDiagnosticsOperationOutcome
  > {
    await Promise.resolve();
    return this.harness.commit();
  }

  async topicsDiagnosticsCreateCrossref(
    sourceIndex: number,
    targetIndex: number,
  ): Promise<TopicsDiagnosticsOperationOutcome> {
    await Promise.resolve();
    this.harness.crossrefs.push([sourceIndex, targetIndex]);
    if (this.harness.script.concurrentFailure) return { ok: false };
    this.harness.enqueue();
    return { ok: true };
  }

  async topicsDiagnosticsValidateCrossrefs(): Promise<
    TopicsDiagnosticsCrossrefValidation
  > {
    await Promise.resolve();
    return {
      ok: !this.harness.script.crossrefFailure,
      validatedSources: this.harness.crossrefs.length,
    };
  }

  async topicsDiagnosticsConvergenceBegin(): Promise<
    { ok: true; ready: true } | { ok: false; error: "operation-failed" }
  > {
    await Promise.resolve();
    return this.harness.script.convergence === "begin"
      ? { ok: false, error: "operation-failed" }
      : { ok: true, ready: true };
  }

  async topicsDiagnosticsConvergencePublish(): Promise<
    { ok: true } | { ok: false; error: "operation-failed" }
  > {
    await Promise.resolve();
    return this.harness.script.convergence === "publish"
      ? { ok: false, error: "operation-failed" }
      : { ok: true };
  }

  async topicsDiagnosticsConvergenceFinish(): Promise<
    | {
      ok: true;
      converged: boolean;
      summary: { topics: number[]; comments: number[]; links: number[] };
    }
    | { ok: false; error: "operation-failed" }
  > {
    await Promise.resolve();
    if (this.harness.script.convergence === "finish") {
      return { ok: false, error: "operation-failed" };
    }
    const summary = this.harness.counts();
    return {
      ok: true,
      converged: this.harness.script.convergence !== "different",
      summary: {
        topics: Array(this.harness.sessions.length).fill(summary.topics),
        comments: Array(this.harness.sessions.length).fill(
          summary.comments,
        ),
        links: Array(this.harness.sessions.length).fill(summary.links),
      },
    };
  }

  async topicsDiagnosticsConvergenceCancel(): Promise<{ ok: true }> {
    await Promise.resolve();
    this.harness.cancelCalls++;
    return { ok: true };
  }
}

interface HarnessExpectation {
  config: TopicsDiagnosticsConfig;
  caseConfig: TopicsDiagnosticsCase;
  sessionCount: number;
}

function factory(
  script: Script = {},
  expectation?: HarnessExpectation,
): {
  createHarness: (
    config: TopicsDiagnosticsConfig,
    caseConfig: TopicsDiagnosticsCase,
  ) => Promise<TopicsDiagnosticsHarness>;
  harnesses: ScriptedHarness[];
} {
  const harnesses: ScriptedHarness[] = [];
  return {
    harnesses,
    createHarness: async (config, caseConfig) => {
      await Promise.resolve();
      if (expectation !== undefined) {
        assertEquals(config, expectation.config);
        assertEquals(caseConfig, expectation.caseConfig);
        assertEquals(
          caseConfig.users * config.sessionsPerUser,
          expectation.sessionCount,
        );
      }
      const harness = new ScriptedHarness(
        caseConfig.topics,
        caseConfig.users * config.sessionsPerUser,
        script,
      );
      if (expectation !== undefined) {
        assertEquals(harness.topicCount, expectation.caseConfig.topics);
        assertEquals(harness.sessions.length, expectation.sessionCount);
      }
      harnesses.push(harness);
      return harness;
    },
  };
}

async function assertFailure(
  args: readonly string[],
  script: Script,
  expected: TopicsDiagnosticsErrorCode,
  expectedCancelCalls = 0,
): Promise<void> {
  const dependency = factory(script);
  const report = await runTopicsDiagnostics(args, dependency);
  const [result] = report.results;
  if (result === undefined || result.ok) throw new Error("expected failure");
  assertEquals(result.error, expected);
  assertEquals(dependency.harnesses.length, 1);
  assertEquals(dependency.harnesses[0]?.cancelCalls, expectedCancelCalls);
  assertEquals(dependency.harnesses[0]?.disposeCalls, 1);
}

Deno.test("Topics diagnostics constructs production harness options without private report data", async () => {
  const config: TopicsDiagnosticsConfig = {
    profile: "matrix",
    program: "topics/main.tsx",
    topicCounts: [3],
    userCounts: [2],
    rounds: 1,
    typingSteps: 1,
    sessionsPerUser: 2,
    wsDelayMs: 7,
    scenarios: ["noops"],
  };
  const scripted = new ScriptedHarness(3, 4);
  let options: MultiRuntimeHarnessOptions | undefined;
  let nextId = 0;
  const harness = await createTopicsDiagnosticsHarness(
    config,
    { topics: 3, users: 2 },
    {
      randomUUID: () => `id-${++nextId}`,
      createRuntimeHarness: (value) => {
        options = value;
        return Promise.resolve(scripted);
      },
    },
  );
  if (harness !== scripted || options === undefined) {
    throw new Error("expected injected runtime harness");
  }
  assertEquals(options.programPath.endsWith("/topics/main.tsx"), true);
  assertEquals(options.diagnostics, true);
  assertEquals(options.aggregateOnlyDiagnostics, true);
  assertEquals(options.spaceName, "topics-diagnostics-id-3");
  const sessionOptions = options.sessions.map((session) => {
    if (typeof session === "string") {
      throw new Error("expected configured diagnostic session");
    }
    return { label: session.label, wsDelayMs: session.wsDelayMs };
  });
  assertEquals(sessionOptions, [
    { label: "user-1-session-1", wsDelayMs: 7 },
    { label: "user-1-session-2", wsDelayMs: 7 },
    { label: "user-2-session-1", wsDelayMs: 7 },
    { label: "user-2-session-2", wsDelayMs: 7 },
  ]);
});

Deno.test("Topics diagnostics CLI prints reports and maps failures to safe exits", async () => {
  const success: TopicsDiagnosticsReport = {
    kind: "topics-workload-diagnostics",
    config: {
      profile: "matrix",
      topicCounts: [1],
      userCounts: [1],
      rounds: 1,
      typingSteps: 1,
      sessionsPerUser: 1,
      wsDelayMs: 0,
      scenarios: ["noops"],
    },
    elapsedMs: 1,
    results: [],
  };
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const dependencies = {
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
    exit: (code: number) => exits.push(code),
  };

  await runTopicsDiagnosticsCli([], {
    ...dependencies,
    run: () => Promise.resolve(success),
  });
  assertEquals(JSON.parse(logs[0]), success);
  assertEquals(errors, []);
  assertEquals(exits, []);

  await runTopicsDiagnosticsCli([], {
    ...dependencies,
    run: () =>
      Promise.resolve({
        ...success,
        results: [{
          ok: false,
          case: { topics: 1, users: 1 },
          error: "phase-operation-failed",
        }],
      }),
  });
  assertEquals(exits, [1]);

  await runTopicsDiagnosticsCli([], {
    ...dependencies,
    run: () =>
      Promise.reject(new TopicsDiagnosticsError("invalid-configuration")),
  });
  assertEquals(errors, ["invalid-configuration"]);
  assertEquals(exits, [1, 1]);
});

Deno.test("Topics diagnostics orchestrates all ordinary phases and row-local crossrefs", async () => {
  const dependency = factory({}, {
    config: {
      profile: "matrix",
      program: "topics/main.tsx",
      topicCounts: [3],
      userCounts: [2],
      rounds: 1,
      typingSteps: 1,
      sessionsPerUser: 2,
      wsDelayMs: 0,
      scenarios: [
        "create-topics",
        "noops",
        "titles",
        "comments",
        "links",
        "bodies",
        "crossrefs",
      ],
    },
    caseConfig: { topics: 3, users: 2 },
    sessionCount: 4,
  });
  const report = await runTopicsDiagnostics([
    "--quick",
    "--topics=3",
    "--users=2",
    "--rounds=1",
    "--typing-steps=1",
    "--sessions-per-user=2",
    "--scenario=create-topics,noops,titles,comments,links,bodies,crossrefs",
  ], dependency);
  const [result] = report.results;
  if (result === undefined || !result.ok) throw new Error("expected success");
  assertEquals(result.result.phases.map((phase) => phase.phase), [
    "concurrent-topic-creation",
    "repeated-noop-writes",
    "live-title-typing",
    "concurrent-comments",
    "concurrent-links",
    "concurrent-body-saves",
    "cross-reference-fanout",
  ]);
  const [harness] = dependency.harnesses;
  if (harness === undefined) throw new Error("expected scripted harness");
  assertEquals(harness.crossrefs, [[1, 0], [2, 0]]);
  assertEquals(result.result.convergence, {
    converged: true,
    summary: {
      topics: [3, 3, 3, 3],
      comments: [4, 4, 4, 4],
      links: [4, 4, 4, 4],
    },
  });
  assertEquals(result.result.phases.map((phase) => phase.telemetry), [
    telemetry(3),
    telemetry(3),
    telemetry(),
    telemetry(4),
    telemetry(4),
    telemetry(4),
    telemetry(2),
  ]);
  assertEquals(result.result.phases[1].derivedTelemetry, {
    attemptedWritesPerSubmittedOperation: 1,
    changedWritesPerSubmittedOperation: 1,
    elidedNoopCandidateWrites: 0,
  });
  assertEquals(harness.cancelCalls, 1);
  assertEquals(harness.disposeCalls, 1);
  const serializedReport = JSON.stringify(report);
  for (
    const sensitiveFragment of [
      "diagnostic-",
      "Topics Diagnostics",
      "https://",
      "did:",
    ]
  ) {
    assertEquals(serializedReport.includes(sensitiveFragment), false);
  }
  for (const sensitiveInput of harness.sensitiveInputs) {
    assertEquals(serializedReport.includes(sensitiveInput), false);
  }
});

Deno.test("Topics diagnostics reports successful conflict metrics and disposes its convergence channel", async () => {
  const dependency = factory({}, {
    config: {
      profile: "conflicts",
      program: "topics/main.tsx",
      topicCounts: [2],
      userCounts: [1],
      rounds: 1,
      typingSteps: 2,
      sessionsPerUser: 2,
      wsDelayMs: 10,
      scenarios: ["root-oscillation"],
    },
    caseConfig: { topics: 2, users: 1 },
    sessionCount: 2,
  });
  const report = await runTopicsDiagnostics([
    "--profile=conflicts",
    "--users=1",
    "--rounds=1",
  ], dependency);
  const [result] = report.results;
  if (result === undefined || !result.ok) throw new Error("expected success");
  assertEquals(result.result.phases.map((phase) => phase.phase), [
    "setup-topics",
    "alternating-whole-root-oscillation",
  ]);
  const oscillation = result.result.phases[1];
  if (oscillation === undefined) throw new Error("expected conflict phase");
  assertEquals(oscillation.operations, {
    submitted: 4,
    directAccepted: 2,
    directRejected: 2,
  });
  assertEquals(oscillation.memoryTelemetry.conflictCount, 1);
  assertEquals(oscillation.churn, {
    commitConflicts: 2,
    commitPreempted: 0,
    commitHeldRevert: 0,
    commitHeldSent: 0,
    commitReverts: 2,
    commitRejected: 0,
  });
  assertEquals(oscillation.rootOscillation, {
    distinctStateCount: 2,
    targetWriteCount: 2,
    twoStepEligibleCount: 0,
    twoStepRepeatCount: 0,
    twoStepRepeatRatio: null,
  });
  const [harness] = dependency.harnesses;
  if (harness === undefined) throw new Error("expected scripted harness");
  assertEquals(harness.cancelCalls, 1);
  assertEquals(harness.disposeCalls, 1);
});

Deno.test("Topics diagnostics reports phase operation and verification failures safely", async () => {
  await assertFailure(
    ["--quick", "--topics=2", "--users=1", "--scenario=noops"],
    { sequentialFailure: true },
    "phase-operation-failed",
  );
  await assertFailure(
    ["--quick", "--topics=2", "--users=2", "--scenario=create-topics"],
    { concurrentFailure: true },
    "phase-operation-failed",
  );
  await assertFailure(
    ["--quick", "--topics=2", "--users=1", "--scenario=titles"],
    { setFailure: true },
    "phase-operation-failed",
  );
  await assertFailure(
    ["--quick", "--topics=2", "--users=1", "--scenario=noops"],
    { noopFailure: true },
    "phase-operation-failed",
  );
  await assertFailure(
    ["--quick", "--topics=2", "--users=1", "--scenario=noops"],
    { telemetryFailure: true },
    "phase-operation-failed",
  );
  await assertFailure(
    ["--quick", "--topics=2", "--users=1", "--scenario=comments"],
    { cardinalityFailure: true },
    "phase-verification-failed",
  );
  await assertFailure(
    ["--quick", "--topics=3", "--users=1", "--scenario=crossrefs"],
    { crossrefFailure: true },
    "phase-verification-failed",
  );
});

Deno.test("Topics diagnostics reports root and convergence failures safely", async () => {
  for (
    const root of [
      "prepare-failure",
      "same-outcomes",
      "invalid-telemetry",
    ] as const
  ) {
    await assertFailure(
      ["--profile=conflicts", "--rounds=1"],
      { root },
      root === "same-outcomes" || root === "invalid-telemetry"
        ? "root-oscillation-failed"
        : "phase-operation-failed",
    );
  }
  for (
    const convergence of ["begin", "publish", "finish", "different"] as const
  ) {
    await assertFailure(
      ["--quick", "--topics=1", "--users=1", "--scenario=noops"],
      { convergence },
      "convergence-failed",
      convergence === "begin" ? 0 : 1,
    );
  }
});

Deno.test("Topics diagnostics classifies harness and per-case failures safely", async () => {
  const initialization = await runTopicsDiagnostics(["--quick"], {
    createHarness: () => Promise.reject(new Error("private initialization")),
  });
  assertEquals(initialization.results[0], {
    ok: false,
    case: { topics: 2, users: 2 },
    error: "harness-initialization-failed",
  });

  const dependency = factory();
  const report = await runTopicsDiagnostics([
    "--quick",
    "--cases=1x1,2x1",
    "--scenario=noops",
  ], {
    createHarness: (_config, caseConfig) => {
      if (caseConfig.topics === 1) {
        return Promise.resolve(
          new ScriptedHarness(1, 1, {
            unexpectedFailure: true,
          }),
        );
      }
      return dependency.createHarness(_config, caseConfig);
    },
  });
  assertEquals(report.results.map((result) => result.ok), [false, true]);
  const [failed] = report.results;
  if (failed === undefined || failed.ok) throw new Error("expected failure");
  assertEquals(failed.error, "unknown-error");
});
