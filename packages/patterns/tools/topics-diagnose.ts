import { Identity } from "@commonfabric/identity";
import { join } from "@std/path";
import {
  type CommitTelemetrySnapshot,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSummary,
  type TopicsDiagnosticsOperationOutcome,
} from "../integration/multi-runtime-harness.ts";
import {
  casesFromArgs,
  configFromArgs,
  type DerivedTelemetry,
  deriveTelemetry,
  type RootOscillationMetadata,
  rootOscillationMetadata,
  type RuntimeTelemetrySnapshot,
  type TopicsDiagnosticsCase,
  type TopicsDiagnosticsConfig,
} from "./topics-diagnose-config.ts";

export {
  ALL_TOPICS_SCENARIOS,
  casesFromArgs,
  configFromArgs,
  type DerivedTelemetry,
  deriveTelemetry,
  type RootOscillationMetadata,
  rootOscillationMetadata,
  type RuntimeTelemetrySnapshot,
  type TopicsDiagnosticsCase,
  type TopicsDiagnosticsConfig,
  type TopicsDiagnosticsProfile,
  type TopicsScenario,
} from "./topics-diagnose-config.ts";

const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface ChurnTotals {
  commitConflicts: number;
  commitPreempted: number;
  commitHeldRevert: number;
  commitHeldSent: number;
  commitReverts: number;
  commitRejected: number;
}

interface PhaseReport {
  phase: string;
  elapsedMs: number;
  operations: PhaseOperations;
  telemetry: RuntimeTelemetrySnapshot;
  derivedTelemetry: DerivedTelemetry;
  memoryTelemetry: CommitTelemetrySnapshot;
  rootOscillation?: RootOscillationMetadata;
  graph: {
    postSettleMaxNodesAcrossSessions: number;
    postSettleMaxEdgesAcrossSessions: number;
    postSettleMaxDirtyAcrossSessions: number;
    postSettleMaxPendingAcrossSessions: number;
  };
  settle: {
    trailingCumulativeHistoryEntries: number;
    maxTrailingSettleMs: number;
  };
  churn: ChurnTotals;
}

interface PhaseOperations {
  submitted: number;
  directAccepted: number;
  directRejected: number;
}

interface PhaseExecution extends PhaseOperations {
  /** Internal only: queued events which must reach a final successful commit. */
  expectedQueuedEventCount: number;
  rootOscillation?: RootOscillationMetadata;
}

export interface ConvergenceReport {
  converged: boolean;
  summary: { topics: number[]; comments: number[]; links: number[] };
}

export interface CaseReport {
  case: TopicsDiagnosticsCase;
  phases: PhaseReport[];
  convergence: ConvergenceReport;
}

export interface TopicsDiagnosticsReportConfig {
  profile: TopicsDiagnosticsConfig["profile"];
  topicCounts: readonly number[];
  userCounts: readonly number[];
  rounds: number;
  typingSteps: number;
  sessionsPerUser: number;
  wsDelayMs: number;
  scenarios: readonly TopicsDiagnosticsConfig["scenarios"][number][];
}

export const TOPICS_DIAGNOSTICS_ERROR_CODES = [
  "invalid-configuration",
  "harness-initialization-failed",
  "phase-operation-failed",
  "phase-verification-failed",
  "root-oscillation-failed",
  "convergence-failed",
  "unknown-error",
] as const;

export type TopicsDiagnosticsErrorCode =
  typeof TOPICS_DIAGNOSTICS_ERROR_CODES[number];

/** The aggregate-only session operations used by the diagnostics orchestrator. */
export type TopicsDiagnosticsSession = Pick<
  MultiRuntimeSession,
  | "diagnosticsSummary"
  | "telemetry"
  | "topicsDiagnosticsSummary"
  | "topicsDiagnosticsChurn"
  | "topicsDiagnosticsSend"
  | "topicsDiagnosticsSet"
  | "topicsDiagnosticsNoop"
  | "topicsDiagnosticsPrepareReversedRoot"
  | "topicsDiagnosticsCommitPreparedRoot"
  | "topicsDiagnosticsCreateCrossref"
  | "topicsDiagnosticsValidateCrossrefs"
  | "topicsDiagnosticsConvergenceBegin"
  | "topicsDiagnosticsConvergencePublish"
  | "topicsDiagnosticsConvergenceFinish"
  | "topicsDiagnosticsConvergenceCancel"
>;

/** Narrow harness surface required to run Topics diagnostic cases. */
export type TopicsDiagnosticsHarness =
  & Pick<
    MultiRuntimeHarness,
    "diagnosticsBarrier" | "memoryTelemetry" | "dispose"
  >
  & {
    sessions: readonly TopicsDiagnosticsSession[];
  };

/** Optional orchestration seam for fast diagnostics tests. */
export interface TopicsDiagnosticsDependencies {
  createHarness?: (
    config: TopicsDiagnosticsConfig,
    caseConfig: TopicsDiagnosticsCase,
  ) => Promise<TopicsDiagnosticsHarness>;
}

/** Testable dependencies for constructing the production runtime harness. */
export interface TopicsDiagnosticsHarnessFactoryDependencies {
  createRuntimeHarness?: (
    options: Parameters<typeof MultiRuntimeHarness.create>[0],
  ) => Promise<TopicsDiagnosticsHarness>;
  randomUUID?: () => string;
}

export class TopicsDiagnosticsError extends Error {
  constructor(
    readonly code: TopicsDiagnosticsErrorCode,
  ) {
    super(code);
  }
}

/** Maps arbitrary failures to report-safe fixed diagnostic categories. */
export function reportSafeErrorCode(
  error: unknown,
): TopicsDiagnosticsErrorCode {
  return error instanceof TopicsDiagnosticsError ? error.code : "unknown-error";
}

function addTelemetry(
  total: RuntimeTelemetrySnapshot,
  next: RuntimeTelemetrySnapshot,
): RuntimeTelemetrySnapshot {
  const writesByPathShape = { ...total.writesByPathShape };
  for (const [path, count] of Object.entries(next.writesByPathShape)) {
    writesByPathShape[path] = (writesByPathShape[path] ?? 0) + count;
  }
  const droppedEventsByReason = {
    "piece-load": total.droppedEventsByReason["piece-load"] +
      next.droppedEventsByReason["piece-load"],
    lineage: total.droppedEventsByReason.lineage +
      next.droppedEventsByReason.lineage,
    preflight: total.droppedEventsByReason.preflight +
      next.droppedEventsByReason.preflight,
    "load-gate": total.droppedEventsByReason["load-gate"] +
      next.droppedEventsByReason["load-gate"],
  };
  const permanentRejectionsByReason = {
    "origin-committed": total.permanentRejectionsByReason[
      "origin-committed"
    ] + next.permanentRejectionsByReason["origin-committed"],
    "receipt-exists": total.permanentRejectionsByReason["receipt-exists"] +
      next.permanentRejectionsByReason["receipt-exists"],
  };
  return {
    invocationCount: total.invocationCount + next.invocationCount,
    distinctInvokedEventCount: total.distinctInvokedEventCount +
      next.distinctInvokedEventCount,
    distinctSuccessfulEventCount: total.distinctSuccessfulEventCount +
      next.distinctSuccessfulEventCount,
    distinctDroppedEventCount: total.distinctDroppedEventCount +
      next.distinctDroppedEventCount,
    droppedEventsByReason,
    permanentRejectionsByReason,
    commitMarkerCount: total.commitMarkerCount + next.commitMarkerCount,
    directCommitCount: total.directCommitCount + next.directCommitCount,
    successfulCommitCount: total.successfulCommitCount +
      next.successfulCommitCount,
    failedAttemptCount: total.failedAttemptCount + next.failedAttemptCount,
    terminalFailureCount: total.terminalFailureCount +
      next.terminalFailureCount,
    retryMarkerCount: total.retryMarkerCount + next.retryMarkerCount,
    maxRetryAttempt: Math.max(total.maxRetryAttempt, next.maxRetryAttempt),
    readCount: total.readCount + next.readCount,
    writeCount: total.writeCount + next.writeCount,
    changedWriteCount: total.changedWriteCount + next.changedWriteCount,
    writesTruncatedCount: total.writesTruncatedCount +
      next.writesTruncatedCount,
    writesByPathShape,
  };
}

const emptyTelemetry = (): RuntimeTelemetrySnapshot => ({
  invocationCount: 0,
  distinctInvokedEventCount: 0,
  distinctSuccessfulEventCount: 0,
  distinctDroppedEventCount: 0,
  droppedEventsByReason: {
    "piece-load": 0,
    lineage: 0,
    preflight: 0,
    "load-gate": 0,
  },
  permanentRejectionsByReason: {
    "origin-committed": 0,
    "receipt-exists": 0,
  },
  commitMarkerCount: 0,
  directCommitCount: 0,
  successfulCommitCount: 0,
  failedAttemptCount: 0,
  terminalFailureCount: 0,
  retryMarkerCount: 0,
  maxRetryAttempt: 0,
  readCount: 0,
  writeCount: 0,
  changedWriteCount: 0,
  writesTruncatedCount: 0,
  writesByPathShape: {},
});

async function collectChurn(
  sessions: readonly TopicsDiagnosticsSession[],
  opts: { idle?: boolean } = {},
): Promise<ChurnTotals> {
  const counts = await Promise.all(
    sessions.map((session) => session.topicsDiagnosticsChurn(opts)),
  );
  return counts.reduce<ChurnTotals>((total, entry) => {
    return {
      commitConflicts: total.commitConflicts + entry.commitConflicts,
      commitPreempted: total.commitPreempted + entry.commitPreempted,
      commitHeldRevert: total.commitHeldRevert + entry.commitHeldRevert,
      commitHeldSent: total.commitHeldSent + entry.commitHeldSent,
      commitReverts: total.commitReverts + entry.commitReverts,
      commitRejected: total.commitRejected + entry.commitRejected,
    };
  }, {
    commitConflicts: 0,
    commitPreempted: 0,
    commitHeldRevert: 0,
    commitHeldSent: 0,
    commitReverts: 0,
    commitRejected: 0,
  });
}

function subtractChurn(after: ChurnTotals, before: ChurnTotals): ChurnTotals {
  return {
    commitConflicts: after.commitConflicts - before.commitConflicts,
    commitPreempted: after.commitPreempted - before.commitPreempted,
    commitHeldRevert: after.commitHeldRevert - before.commitHeldRevert,
    commitHeldSent: after.commitHeldSent - before.commitHeldSent,
    commitReverts: after.commitReverts - before.commitReverts,
    commitRejected: after.commitRejected - before.commitRejected,
  };
}

export function graphSummary(
  diagnostics: readonly RuntimeDiagnosticsSummary[],
): PhaseReport["graph"] {
  return {
    postSettleMaxNodesAcrossSessions: Math.max(
      0,
      ...diagnostics.map((entry) => entry.nodeCount),
    ),
    postSettleMaxEdgesAcrossSessions: Math.max(
      0,
      ...diagnostics.map((entry) => entry.edgeCount),
    ),
    postSettleMaxDirtyAcrossSessions: Math.max(
      0,
      ...diagnostics.map((entry) => entry.dirtyNodeCount),
    ),
    postSettleMaxPendingAcrossSessions: Math.max(
      0,
      ...diagnostics.map((entry) => entry.pendingNodeCount),
    ),
  };
}

export function settleSummary(
  diagnostics: readonly RuntimeDiagnosticsSummary[],
): PhaseReport["settle"] {
  return {
    trailingCumulativeHistoryEntries: diagnostics.reduce(
      (total, entry) => total + entry.settleHistoryEntryCount,
      0,
    ),
    maxTrailingSettleMs: Math.max(
      0,
      ...diagnostics.map((entry) => entry.maxTrailingSettleDurationMs),
    ),
  };
}

async function phase(
  name: string,
  harness: TopicsDiagnosticsHarness,
  operation: () => Promise<PhaseExecution>,
  verifyAfterSettle?: () => Promise<void>,
): Promise<PhaseReport> {
  await harness.diagnosticsBarrier();
  const churnBefore = await collectChurn(harness.sessions, { idle: false });
  await Promise.all(harness.sessions.map((session) => session.telemetry()));
  harness.memoryTelemetry();
  const startedAt = performance.now();
  const operations = await operation();
  await harness.diagnosticsBarrier();
  try {
    await verifyAfterSettle?.();
  } catch {
    throw new TopicsDiagnosticsError("phase-verification-failed");
  }
  await harness.diagnosticsBarrier();
  const [snapshots, diagnostics, churnAfter] = await Promise.all([
    Promise.all(harness.sessions.map((session) => session.telemetry())),
    Promise.all(
      harness.sessions.map((session) =>
        session.diagnosticsSummary({ idle: false })
      ),
    ),
    collectChurn(harness.sessions, { idle: false }),
  ]);
  const telemetry = snapshots.reduce(addTelemetry, emptyTelemetry());
  if (
    telemetry.distinctSuccessfulEventCount !==
      operations.expectedQueuedEventCount ||
    telemetry.distinctDroppedEventCount !== 0 ||
    telemetry.terminalFailureCount !== 0
  ) {
    throw new TopicsDiagnosticsError("phase-operation-failed");
  }
  const {
    rootOscillation,
    expectedQueuedEventCount: _expected,
    ...phaseOperations
  } = operations;
  return {
    phase: name,
    elapsedMs: performance.now() - startedAt,
    operations: phaseOperations,
    telemetry,
    derivedTelemetry: deriveTelemetry(telemetry, phaseOperations.submitted),
    memoryTelemetry: harness.memoryTelemetry(),
    ...(rootOscillation === undefined ? {} : { rootOscillation }),
    graph: graphSummary(diagnostics),
    settle: settleSummary(diagnostics),
    churn: subtractChurn(churnAfter, churnBefore),
  };
}

export async function createTopicsDiagnosticsHarness(
  config: TopicsDiagnosticsConfig,
  caseConfig: TopicsDiagnosticsCase,
  dependencies: TopicsDiagnosticsHarnessFactoryDependencies = {},
): Promise<TopicsDiagnosticsHarness> {
  const identities = await Promise.all(Array.from(
    { length: caseConfig.users },
    (_entry, index) =>
      Identity.fromPassphrase(
        `topics-diagnose-${
          dependencies.randomUUID?.() ?? crypto.randomUUID()
        }-user-${index + 1}`,
        { implementation: "noble" },
      ),
  ));
  const sessions = identities.flatMap((identity, userIndex) =>
    Array.from({ length: config.sessionsPerUser }, (_entry, sessionIndex) => ({
      label: `user-${userIndex + 1}-session-${sessionIndex + 1}`,
      identity,
      ...(config.wsDelayMs > 0 ? { wsDelayMs: config.wsDelayMs } : {}),
    }))
  );
  const options: Parameters<typeof MultiRuntimeHarness.create>[0] = {
    programPath: join(ROOT_PATH, config.program),
    rootPath: ROOT_PATH,
    diagnostics: true,
    aggregateOnlyDiagnostics: true,
    sessions,
    spaceName: `topics-diagnostics-${
      dependencies.randomUUID?.() ?? crypto.randomUUID()
    }`,
  };
  return await (dependencies.createRuntimeHarness
    ? dependencies.createRuntimeHarness(options)
    : MultiRuntimeHarness.create(options));
}

async function setOutcomes(
  operations: readonly Promise<TopicsDiagnosticsOperationOutcome>[],
): Promise<PhaseExecution> {
  const outcomes = await Promise.all(operations);
  if (outcomes.some((outcome) => !outcome.ok)) {
    throw new TopicsDiagnosticsError("phase-operation-failed");
  }
  const directAccepted = outcomes.filter((outcome) => outcome.ok).length;
  return {
    submitted: outcomes.length,
    directAccepted,
    directRejected: outcomes.length - directAccepted,
    expectedQueuedEventCount: 0,
  };
}

async function submittedOutcomes(
  operations: readonly Promise<TopicsDiagnosticsOperationOutcome>[],
): Promise<PhaseExecution> {
  const outcomes = await Promise.all(operations);
  if (outcomes.some((outcome) => !outcome.ok)) {
    throw new TopicsDiagnosticsError("phase-operation-failed");
  }
  return submitted(outcomes.length);
}

const submitted = (count: number): PhaseExecution => ({
  submitted: count,
  directAccepted: 0,
  directRejected: 0,
  expectedQueuedEventCount: count,
});

async function assertSharedCardinality(
  session: TopicsDiagnosticsSession,
  expected: { topics: number; comments: number; links: number },
): Promise<void> {
  const actual = await session.topicsDiagnosticsSummary();
  if (
    !actual.ok ||
    actual.topics !== expected.topics ||
    actual.comments !== expected.comments ||
    actual.links !== expected.links
  ) {
    throw new TopicsDiagnosticsError("phase-verification-failed");
  }
}

async function collectConvergence(
  sessions: readonly TopicsDiagnosticsSession[],
): Promise<ConvergenceReport> {
  const coordinator = sessions[0];
  const channel = `topics-convergence-${crypto.randomUUID()}`;
  const ready = await coordinator.topicsDiagnosticsConvergenceBegin(
    channel,
    sessions.length,
  );
  if (!ready.ok) throw new TopicsDiagnosticsError("convergence-failed");
  try {
    const publishes = await Promise.all(
      sessions.map((session) =>
        session.topicsDiagnosticsConvergencePublish(channel)
      ),
    );
    if (publishes.some((outcome) => !outcome.ok)) {
      throw new TopicsDiagnosticsError("convergence-failed");
    }
    const result = await coordinator.topicsDiagnosticsConvergenceFinish();
    if (!result.ok) throw new TopicsDiagnosticsError("convergence-failed");
    return { converged: result.converged, summary: result.summary };
  } finally {
    await coordinator.topicsDiagnosticsConvergenceCancel();
  }
}

async function runCase(
  config: TopicsDiagnosticsConfig,
  caseConfig: TopicsDiagnosticsCase,
  createHarnessForCase: NonNullable<
    TopicsDiagnosticsDependencies["createHarness"]
  >,
): Promise<CaseReport> {
  let harness: TopicsDiagnosticsHarness;
  try {
    harness = await createHarnessForCase(config, caseConfig);
  } catch {
    throw new TopicsDiagnosticsError("harness-initialization-failed");
  }
  const sessions = harness.sessions;
  const phases: PhaseReport[] = [];
  const selected = new Set(config.scenarios);
  const representative = sessions[0];
  try {
    const concurrentCreation = selected.has("create-topics");
    const createName = concurrentCreation
      ? "concurrent-topic-creation"
      : "setup-topics";
    phases.push(
      await phase(createName, harness, async () => {
        if (!concurrentCreation) {
          for (let index = 0; index < caseConfig.topics; index++) {
            const outcome = await representative.topicsDiagnosticsSend(
              "addTopic",
              {
                title: `diagnostic-topic-${index + 1}`,
                agentName: "Topics Diagnostics",
              },
            );
            if (!outcome.ok) {
              throw new TopicsDiagnosticsError("phase-operation-failed");
            }
          }
          return submitted(caseConfig.topics);
        }
        const operations = Array.from(
          { length: caseConfig.topics },
          (_entry, index) =>
            sessions[index % sessions.length].topicsDiagnosticsSend(
              "addTopic",
              {
                title: `diagnostic-topic-${index + 1}`,
                agentName: "Topics Diagnostics",
              },
              { idle: false },
            ),
        );
        return await submittedOutcomes(operations);
      }, async () => {
        await assertSharedCardinality(representative, {
          topics: caseConfig.topics,
          comments: 0,
          links: 0,
        });
      }),
    );

    if (selected.has("noops")) {
      phases.push(
        await phase("repeated-noop-writes", harness, async () => {
          const outcomes = await Promise.all(Array.from(
            { length: caseConfig.topics },
            (_entry, index) =>
              sessions[index % sessions.length]
                .topicsDiagnosticsNoop(index, { idle: false }),
          ));
          if (outcomes.some((outcome) => !outcome.ok)) {
            throw new TopicsDiagnosticsError("phase-operation-failed");
          }
          const totals = outcomes.reduce<PhaseOperations>((total, outcome) => ({
            submitted: total.submitted + outcome.submitted,
            directAccepted: total.directAccepted + outcome.directAccepted,
            directRejected: total.directRejected + outcome.directRejected,
          }), { submitted: 0, directAccepted: 0, directRejected: 0 });
          return { ...totals, expectedQueuedEventCount: outcomes.length };
        }),
      );
    }

    if (selected.has("titles")) {
      phases.push(
        await phase("live-title-typing", harness, async () => {
          const operations = Array.from(
            { length: caseConfig.topics },
            (_entry, topicIndex) =>
              Array.from(
                { length: config.typingSteps },
                (_ignored, step) =>
                  sessions[(topicIndex + step) % sessions.length]
                    .topicsDiagnosticsSet(
                      ["topics", topicIndex, "title"],
                      `diagnostic-title-${topicIndex + 1}-${step + 1}`,
                      { idle: false },
                    ),
              ),
          ).flat();
          return await setOutcomes(operations);
        }),
      );
    }
    if (selected.has("comments")) {
      phases.push(
        await phase("concurrent-comments", harness, async () => {
          const operations = sessions.flatMap((session, index) =>
            Array.from(
              { length: config.rounds },
              (_entry, round) =>
                session.topicsDiagnosticsSend([
                  "topics",
                  (index + round) % caseConfig.topics,
                  "addComment",
                ], {
                  body: `diagnostic-comment-${index + 1}-${round + 1}`,
                  agentName: "Topics Diagnostics",
                }, { idle: false }),
            )
          );
          return await submittedOutcomes(operations);
        }, async () => {
          await assertSharedCardinality(representative, {
            topics: caseConfig.topics,
            comments: sessions.length * config.rounds,
            links: 0,
          });
        }),
      );
    }
    if (selected.has("links")) {
      phases.push(
        await phase("concurrent-links", harness, async () => {
          const operations = sessions.flatMap((session, index) =>
            Array.from(
              { length: config.rounds },
              (_entry, round) =>
                session.topicsDiagnosticsSend([
                  "topics",
                  (index + round) % caseConfig.topics,
                  "addLink",
                ], {
                  kind: "web",
                  url: `https://example.invalid/diagnostic/${index + 1}/${
                    round + 1
                  }`,
                  label: "diagnostic-link",
                  agentName: "Topics Diagnostics",
                }, { idle: false }),
            )
          );
          return await submittedOutcomes(operations);
        }, async () => {
          await assertSharedCardinality(representative, {
            topics: caseConfig.topics,
            comments: selected.has("comments")
              ? sessions.length * config.rounds
              : 0,
            links: sessions.length * config.rounds,
          });
        }),
      );
    }
    if (selected.has("bodies")) {
      phases.push(
        await phase("concurrent-body-saves", harness, async () => {
          const operations = sessions.flatMap((session, index) =>
            Array.from(
              { length: config.rounds },
              (_entry, round) =>
                session.topicsDiagnosticsSend([
                  "topics",
                  (index + round) % caseConfig.topics,
                  "setBody",
                ], {
                  body: `diagnostic-body-${index + 1}-${round + 1}`,
                  agentName: "Topics Diagnostics",
                }, { idle: false }),
            )
          );
          return await submittedOutcomes(operations);
        }),
      );
    }
    if (selected.has("root-oscillation")) {
      const oscillationPhase = await phase(
        "alternating-whole-root-oscillation",
        harness,
        async () => {
          const attemptedStates: number[] = [];
          const outcomes: TopicsDiagnosticsOperationOutcome[] = [];
          for (let round = 0; round < config.rounds; round++) {
            for (const state of [1, 0]) {
              attemptedStates.push(state);
              const writers = sessions.slice(0, 2);
              const preparations = await Promise.all(
                writers.map((session) =>
                  session.topicsDiagnosticsPrepareReversedRoot({ idle: false })
                ),
              );
              if (preparations.some((outcome) => !outcome.ok)) {
                throw new TopicsDiagnosticsError("phase-operation-failed");
              }
              const pairOutcomes = await Promise.all(
                writers.map((session) =>
                  session.topicsDiagnosticsCommitPreparedRoot()
                ),
              );
              if (
                !pairOutcomes.some((outcome) => outcome.ok) ||
                !pairOutcomes.some((outcome) => !outcome.ok)
              ) {
                throw new TopicsDiagnosticsError("root-oscillation-failed");
              }
              outcomes.push(...pairOutcomes);
              await harness.diagnosticsBarrier();
            }
          }
          const directAccepted = outcomes.filter((outcome) =>
            outcome.ok
          ).length;
          return {
            submitted: outcomes.length,
            directAccepted,
            directRejected: outcomes.length - directAccepted,
            expectedQueuedEventCount: 0,
            rootOscillation: rootOscillationMetadata(attemptedStates),
          };
        },
        async () => {
          await Promise.all(
            sessions.map((session) =>
              assertSharedCardinality(session, {
                topics: caseConfig.topics,
                comments: selected.has("comments")
                  ? sessions.length * config.rounds
                  : 0,
                links: selected.has("links")
                  ? sessions.length * config.rounds
                  : 0,
              })
            ),
          );
        },
      );
      const rootPatchCount =
        oscillationPhase.memoryTelemetry.patchesByPathShape["value-root"] ?? 0;
      if (
        oscillationPhase.operations.directAccepted < config.rounds * 2 ||
        oscillationPhase.operations.directRejected === 0 ||
        rootPatchCount < config.rounds * 2 ||
        oscillationPhase.memoryTelemetry.conflictCount === 0 ||
        oscillationPhase.churn.commitConflicts === 0 ||
        oscillationPhase.churn.commitReverts === 0 ||
        ((oscillationPhase.rootOscillation?.twoStepEligibleCount ?? 0) > 0 &&
          oscillationPhase.rootOscillation?.twoStepRepeatRatio !== 1)
      ) {
        throw new TopicsDiagnosticsError("root-oscillation-failed");
      }
      phases.push(oscillationPhase);
    }
    if (selected.has("crossrefs")) {
      phases.push(
        await phase("cross-reference-fanout", harness, async () => {
          const operations = Array.from(
            { length: caseConfig.topics - 1 },
            (_entry, index) => {
              const sourceIndex = index + 1;
              return sessions[index % sessions.length]
                .topicsDiagnosticsCreateCrossref(sourceIndex, 0, {
                  idle: false,
                });
            },
          );
          return await submittedOutcomes(operations);
        }, async () => {
          const validation = await Promise.all(
            sessions.map((session) =>
              session.topicsDiagnosticsValidateCrossrefs(caseConfig.topics)
            ),
          );
          if (validation.some((outcome) => !outcome.ok)) {
            throw new TopicsDiagnosticsError("phase-verification-failed");
          }
        }),
      );
    }

    await harness.diagnosticsBarrier();
    const convergence = await collectConvergence(sessions);
    if (!convergence.converged) {
      throw new TopicsDiagnosticsError("convergence-failed");
    }
    return {
      case: caseConfig,
      phases,
      convergence,
    };
  } finally {
    await harness.dispose();
  }
}

export interface TopicsDiagnosticsReport {
  kind: string;
  config: TopicsDiagnosticsReportConfig;
  elapsedMs: number;
  results: readonly ({ ok: true; result: CaseReport } | {
    ok: false;
    case: TopicsDiagnosticsCase;
    error: TopicsDiagnosticsErrorCode;
  })[];
}

export async function runTopicsDiagnostics(
  args: readonly string[],
  dependencies: TopicsDiagnosticsDependencies = {},
): Promise<TopicsDiagnosticsReport> {
  let config: TopicsDiagnosticsConfig;
  let cases: TopicsDiagnosticsCase[];
  try {
    config = configFromArgs(args);
    cases = casesFromArgs(args, config);
  } catch {
    throw new TopicsDiagnosticsError("invalid-configuration");
  }
  const startedAt = performance.now();
  const createHarnessForCase = dependencies.createHarness ??
    createTopicsDiagnosticsHarness;
  const results: ({ ok: true; result: CaseReport } | {
    ok: false;
    case: TopicsDiagnosticsCase;
    error: TopicsDiagnosticsErrorCode;
  })[] = [];
  for (const caseConfig of cases) {
    console.error(
      `[topics diagnose] ${caseConfig.topics} topics x ${caseConfig.users} users`,
    );
    try {
      results.push({
        ok: true,
        result: await runCase(config, caseConfig, createHarnessForCase),
      });
    } catch (error) {
      results.push({
        ok: false,
        case: caseConfig,
        error: reportSafeErrorCode(error),
      });
    }
  }
  return {
    kind: "topics-workload-diagnostics",
    config: {
      profile: config.profile,
      topicCounts: config.topicCounts,
      userCounts: config.userCounts,
      rounds: config.rounds,
      typingSteps: config.typingSteps,
      sessionsPerUser: config.sessionsPerUser,
      wsDelayMs: config.wsDelayMs,
      scenarios: config.scenarios,
    },
    elapsedMs: performance.now() - startedAt,
    results,
  };
}

export interface TopicsDiagnosticsCliDependencies {
  error?: (message: string) => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  run?: (args: readonly string[]) => Promise<TopicsDiagnosticsReport>;
}

export async function runTopicsDiagnosticsCli(
  args: readonly string[],
  dependencies: TopicsDiagnosticsCliDependencies = {},
): Promise<void> {
  const exit = dependencies.exit ?? Deno.exit;
  const run = dependencies.run ?? runTopicsDiagnostics;
  let report: TopicsDiagnosticsReport;
  try {
    report = await run(args);
  } catch (error) {
    (dependencies.error ?? console.error)(reportSafeErrorCode(error));
    exit(1);
    return;
  }
  (dependencies.log ?? console.log)(JSON.stringify(report, null, 2));
  if (report.results.some((result) => !result.ok)) exit(1);
}

if (import.meta.main) await runTopicsDiagnosticsCli(Deno.args);
