import {
  type BrowserProcessMetrics,
  CdpWorkerProfiler,
  deltaRendererProcessCpu,
  env,
  type Page,
  parseCpuBenchmarkEventCount,
  type RendererProcessCpuDelta,
  summarizeCPUProfile,
  waitFor,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { type ActionClaimKey } from "@commonfabric/memory/v2";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type {
  ExecutionRoutingDiagnostics,
  ExecutionRoutingDiagnosticsQuery,
} from "@commonfabric/runner/shared";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  collectBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import {
  assertAuthoritativePreflightSettlement,
  assertExactRoutingPhase,
  type DiscoveredRolloutAction,
  discoverScopedWritingAction,
} from "./server-primary-rollout-profile-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const SERVER_EXECUTION_ENABLED = experimentalOptionsFromEnv(Deno.env.get)
  .serverPrimaryExecution === true;
const CPU_BENCH = Deno.env.get("CF_SERVER_EXECUTION_CPU_BENCH") === "1";
// The expensive CPU measurement is intentionally opt-in. Its workload parser rejects
// partial, padded, fractional, and out-of-range values instead of silently
// turning a mistyped benchmark into a short green run.
const CPU_EVENTS = CPU_BENCH
  ? parseCpuBenchmarkEventCount(
    Deno.env.get("CF_SERVER_EXECUTION_CPU_EVENTS"),
  )
  : 4;
const AUTHORITY_PREFLIGHT_EVENTS = 2;
const WARMUP_EVENTS_PER_BLOCK = CPU_BENCH ? 25 : 1;
const PROFILE_DIR = Deno.env.get("CF_CPUPROFILE_DIR");
const TIMEOUT = 60_000;
const MEASURED_OBSERVER_TIMEOUT = CPU_BENCH
  ? Math.max(TIMEOUT, CPU_EVENTS * 500)
  : TIMEOUT;
const CPU_FLOOR_US = 100_000;

const PHASES = [
  "authoritative-1",
  "authoritative-2",
  "authoritative-3",
  "authoritative-4",
] as const;

type ActionTraceEntry = {
  actionId: string;
  actualWrites: Array<{ entityId: string; path: string[] }>;
};

type ServerExecutionCounters = {
  claimsIssued: number;
  acceptedActionAttempts: number;
  schedulerRuns: number;
  actionTransactions: {
    shadow: number;
    authoritative: number;
  };
  asyncRequests: number;
  settlements: {
    committed: number;
    noOp: number;
    failed: number;
    unserved: number;
  };
};

type PhaseResult = {
  label: string;
  events: number;
  lazyActionRuns: number;
  clientDerivedSuppressed: number;
  clientDerivedUpstreamCommits: number;
  serverExecutionBoundary: "claimed-settlement";
  serverExecution: Omit<ServerExecutionCounters, "claimsIssued"> & {
    claimsIssued: {
      total: number;
      duringPhase: number;
    };
  };
  routing: ExecutionRoutingDiagnostics;
  browserProcessCpu?: {
    before: BrowserProcessMetrics;
    after: BrowserProcessMetrics;
    rendererDelta: RendererProcessCpuDelta;
  };
};

async function serverExecutionPoolIsQuiescent(): Promise<boolean> {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  assert(response.ok, `execution health returned ${response.status}`);
  const health = await response.json() as {
    serverExecutionPool?: {
      activeLanes?: number;
      activeWorkers?: number;
      activeDemands?: number;
    } | null;
  };
  const pool = health.serverExecutionPool;
  assert(
    pool !== undefined && pool !== null,
    "server execution pool unavailable",
  );
  return pool.activeLanes === 0 && pool.activeWorkers === 0 &&
    pool.activeDemands === 0;
}

async function readServerExecutionCounters(): Promise<ServerExecutionCounters> {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  assert(response.ok, `execution health returned ${response.status}`);
  const health = await response.json() as {
    serverExecutionPool?: {
      executionPlacement?: {
        schedulerRuns?: number;
        actionTransactions?: { shadow?: number; authoritative?: number };
        asyncRequests?: number;
      };
    } | null;
    serverExecutionControl?: {
      claimsIssued?: number;
      acceptedActionAttempts?: number;
      settlementsCommitted?: number;
      settlementsNoOp?: number;
      settlementsFailed?: number;
      settlementsUnserved?: number;
    } | null;
  };
  const placement = health.serverExecutionPool?.executionPlacement;
  const control = health.serverExecutionControl;
  assert(placement !== undefined, "server execution placement is unavailable");
  assert(
    control !== undefined && control !== null,
    "server execution control is unavailable",
  );
  const counter = (value: number | undefined, label: string): number => {
    assert(
      Number.isSafeInteger(value) && Number(value) >= 0,
      `invalid ${label} counter`,
    );
    return Number(value);
  };
  return {
    claimsIssued: counter(control.claimsIssued, "claims issued"),
    acceptedActionAttempts: counter(
      control.acceptedActionAttempts,
      "accepted action attempts",
    ),
    schedulerRuns: counter(placement.schedulerRuns, "server scheduler runs"),
    actionTransactions: {
      shadow: counter(
        placement.actionTransactions?.shadow,
        "server shadow action transactions",
      ),
      authoritative: counter(
        placement.actionTransactions?.authoritative,
        "server authoritative action transactions",
      ),
    },
    asyncRequests: counter(
      placement.asyncRequests,
      "server async requests",
    ),
    settlements: {
      committed: counter(
        control.settlementsCommitted,
        "committed settlements",
      ),
      noOp: counter(control.settlementsNoOp, "no-op settlements"),
      failed: counter(control.settlementsFailed, "failed settlements"),
      unserved: counter(control.settlementsUnserved, "unserved settlements"),
    },
  };
}

function serverExecutionDelta(
  before: ServerExecutionCounters,
  after: ServerExecutionCounters,
): ServerExecutionCounters {
  const delta = (next: number, previous: number, label: string): number => {
    assert(next >= previous, `${label} counter moved backwards`);
    return next - previous;
  };
  return {
    claimsIssued: delta(
      after.claimsIssued,
      before.claimsIssued,
      "claims issued",
    ),
    acceptedActionAttempts: delta(
      after.acceptedActionAttempts,
      before.acceptedActionAttempts,
      "accepted action attempts",
    ),
    schedulerRuns: delta(
      after.schedulerRuns,
      before.schedulerRuns,
      "server scheduler runs",
    ),
    actionTransactions: {
      shadow: delta(
        after.actionTransactions.shadow,
        before.actionTransactions.shadow,
        "server shadow action transactions",
      ),
      authoritative: delta(
        after.actionTransactions.authoritative,
        before.actionTransactions.authoritative,
        "server authoritative action transactions",
      ),
    },
    asyncRequests: delta(
      after.asyncRequests,
      before.asyncRequests,
      "server async requests",
    ),
    settlements: {
      committed: delta(
        after.settlements.committed,
        before.settlements.committed,
        "committed settlements",
      ),
      noOp: delta(
        after.settlements.noOp,
        before.settlements.noOp,
        "no-op settlements",
      ),
      failed: delta(
        after.settlements.failed,
        before.settlements.failed,
        "failed settlements",
      ),
      unserved: delta(
        after.settlements.unserved,
        before.settlements.unserved,
        "unserved settlements",
      ),
    },
  };
}

type BrowserRuntime = {
  allSynced(): Promise<void>;
  getActionRunTrace(): Promise<ActionTraceEntry[]>;
  getExecutionRoutingDiagnostics(
    query: ExecutionRoutingDiagnosticsQuery,
  ): Promise<ExecutionRoutingDiagnostics>;
  getGraphSnapshot(): Promise<{
    nodes: Array<{ id: string; stats?: { runCount: number } }>;
  }>;
  setActionRunTraceEnabled(enabled: boolean): Promise<void>;
};

async function resetActionTrace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: { rt?: BrowserRuntime };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime action trace is unavailable");
    await rt.setActionRunTraceEnabled(false);
    await rt.setActionRunTraceEnabled(true);
  });
}

async function disableActionTrace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: { rt?: BrowserRuntime };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime action trace is unavailable");
    await rt.setActionRunTraceEnabled(false);
  });
}

async function actionTrace(page: Page): Promise<ActionTraceEntry[]> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: { rt?: BrowserRuntime };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime action trace is unavailable");
    return await rt.getActionRunTrace();
  });
}

async function actionRunCounts(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: { rt?: BrowserRuntime };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime graph snapshot is unavailable");
    const { nodes } = await rt.getGraphSnapshot();
    const counts: Record<string, number> = {};
    for (const node of nodes) {
      if (node.stats) {
        counts[node.id] = Math.max(counts[node.id] ?? 0, node.stats.runCount);
      }
    }
    return counts;
  });
}

async function executionRoutingDiagnostics(
  page: Page,
  query: ExecutionRoutingDiagnosticsQuery,
): Promise<ExecutionRoutingDiagnostics> {
  return await page.evaluate(
    async (request: ExecutionRoutingDiagnosticsQuery) => {
      const rt = (globalThis as typeof globalThis & {
        commonfabric?: { rt?: BrowserRuntime };
      }).commonfabric?.rt;
      if (!rt) throw new Error("execution routing diagnostics are unavailable");
      return await rt.getExecutionRoutingDiagnostics(request);
    },
    { args: [query] },
  );
}

async function runtimeAllSynced(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: { rt?: BrowserRuntime };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime sync is unavailable");
    await rt.allSynced();
  });
}

const exactQuery = (key: ActionClaimKey): ExecutionRoutingDiagnosticsQuery => ({
  space: key.space as MemorySpace,
  branch: key.branch,
  pieceId: key.pieceId,
  actionId: key.actionId,
});

async function resetExactRoutingCounters(
  page: Page,
  key: ActionClaimKey,
): Promise<ExecutionRoutingDiagnostics> {
  const diagnostics = await rawResetExactRoutingCounters(page, key);
  assertExactRoutingPhase(diagnostics, {
    key,
    authoritative: true,
    events: 0,
  });
  return diagnostics;
}

async function rawResetExactRoutingCounters(
  page: Page,
  key: ActionClaimKey,
): Promise<ExecutionRoutingDiagnostics> {
  const diagnostics = await executionRoutingDiagnostics(page, {
    ...exactQuery(key),
    resetCounters: true,
  });
  assertEquals(diagnostics.snapshotRequired, false);
  assertEquals(diagnostics.truncatedActionRecords, 0);
  return diagnostics;
}

async function waitForAuthoritativePreflightSettlement(
  page: Page,
  key: ActionClaimKey,
  phase = "post-reset",
): Promise<ExecutionRoutingDiagnostics> {
  const query = exactQuery(key);
  try {
    await waitForCondition(
      page,
      async (
        _probe,
        request: ExecutionRoutingDiagnosticsQuery,
        expectedKey: ActionClaimKey,
      ) => {
        const rt = (globalThis as typeof globalThis & {
          commonfabric?: { rt?: BrowserRuntime };
        }).commonfabric?.rt;
        if (!rt) return false;
        const diagnostics = await rt.getExecutionRoutingDiagnostics(request);
        if (
          diagnostics.snapshotRequired ||
          diagnostics.truncatedActionRecords !== 0 ||
          diagnostics.claims.length !== 1 ||
          diagnostics.actions.length !== 1
        ) return false;
        const sameKey = (candidate: ActionClaimKey): boolean =>
          candidate.branch === expectedKey.branch &&
          candidate.space === expectedKey.space &&
          candidate.contextKey === expectedKey.contextKey &&
          candidate.pieceId === expectedKey.pieceId &&
          candidate.actionId === expectedKey.actionId &&
          candidate.actionKind === expectedKey.actionKind &&
          candidate.implementationFingerprint ===
            expectedKey.implementationFingerprint &&
          candidate.runtimeFingerprint === expectedKey.runtimeFingerprint;
        const action = diagnostics.actions[0];
        const claim = diagnostics.claims[0];
        const liveClaim = action.liveClaim;
        const settlement = action.lastSettlement;
        if (
          !sameKey(action.key) || !sameKey(claim) || liveClaim === undefined ||
          !sameKey(liveClaim) || settlement === undefined ||
          !sameKey(settlement.claim)
        ) return false;
        const sameIncarnation = (
          left: typeof claim,
          right: typeof claim,
        ): boolean =>
          sameKey(left) && sameKey(right) &&
          left.leaseGeneration === right.leaseGeneration &&
          left.claimGeneration === right.claimGeneration;
        if (
          !sameIncarnation(liveClaim, claim) ||
          !sameIncarnation(settlement.claim, liveClaim) ||
          (settlement.outcome !== "committed" &&
            settlement.outcome !== "no-op") ||
          action.settlements.committed + action.settlements.noOp < 1 ||
          action.settlements.failed !== 0 ||
          action.settlements.unserved !== 0 ||
          action.pendingOverlayCount !== 0 ||
          action.unresolvedBasisOverlayCount !== 0 ||
          action.pendingSettlementCount !== 0 ||
          action.nonAuthoritativeOverlayDrops !== 0
        ) return false;
        return settlement.acceptedCommitSeq === undefined ||
          diagnostics.executionAppliedSeq >= settlement.acceptedCommitSeq;
      },
      { timeout: TIMEOUT, args: [query, key] },
    );
  } catch (cause) {
    const latest = await executionRoutingDiagnostics(page, query).catch(
      (diagnosticCause) => ({
        diagnosticReadError: diagnosticCause instanceof Error
          ? diagnosticCause.message
          : String(diagnosticCause),
      }),
    );
    throw new Error(
      `timed out waiting for a ${phase} settlement under the current claim incarnation. Snapshot: ${
        JSON.stringify(latest)
      }`,
      { cause },
    );
  }
  const diagnostics = await executionRoutingDiagnostics(page, query);
  assertAuthoritativePreflightSettlement(diagnostics, key);
  return diagnostics;
}

async function waitForExactRoutingPhase(
  page: Page,
  key: ActionClaimKey,
  events: number,
): Promise<ExecutionRoutingDiagnostics> {
  const query = exactQuery(key);
  try {
    await waitForCondition(
      page,
      async (
        _probe,
        request: ExecutionRoutingDiagnosticsQuery,
        expectedKey: ActionClaimKey,
        expectedEvents: number,
      ) => {
        const rt = (globalThis as typeof globalThis & {
          commonfabric?: { rt?: BrowserRuntime };
        }).commonfabric?.rt;
        if (!rt) return false;
        const diagnostics = await rt.getExecutionRoutingDiagnostics(request);
        if (
          diagnostics.snapshotRequired ||
          diagnostics.truncatedActionRecords !== 0
        ) return false;
        const sameKey = (candidate: ActionClaimKey): boolean =>
          candidate.branch === expectedKey.branch &&
          candidate.space === expectedKey.space &&
          candidate.contextKey === expectedKey.contextKey &&
          candidate.pieceId === expectedKey.pieceId &&
          candidate.actionId === expectedKey.actionId &&
          candidate.actionKind === expectedKey.actionKind &&
          candidate.implementationFingerprint ===
            expectedKey.implementationFingerprint &&
          candidate.runtimeFingerprint === expectedKey.runtimeFingerprint;
        const actions = diagnostics.actions.filter((candidate) =>
          sameKey(candidate.key)
        );
        if (actions.length !== 1 || diagnostics.actions.length !== 1) {
          return false;
        }
        const action = actions[0];
        if (
          action.pendingOverlayCount !== 0 ||
          action.unresolvedBasisOverlayCount !== 0 ||
          action.pendingSettlementCount !== 0 ||
          action.nonAuthoritativeOverlayDrops !== 0 ||
          action.settlements.failed !== 0 ||
          action.settlements.unserved !== 0
        ) return false;
        if (
          action.lastSettlement?.acceptedCommitSeq !== undefined &&
          diagnostics.executionAppliedSeq <
            action.lastSettlement.acceptedCommitSeq
        ) return false;
        const successfulSettlements = action.settlements.committed +
          action.settlements.noOp;
        // The worker may coalesce several accepted source commits into one
        // run; exact overlay drops prove that settlement covered the batch.
        return diagnostics.claims.length === 1 &&
          diagnostics.claims.some(sameKey) &&
          action.liveClaim !== undefined &&
          sameKey(action.liveClaim) && action.upstreamRoutes === 0 &&
          action.claimedOverlayRoutes === expectedEvents &&
          (expectedEvents === 0
            ? successfulSettlements === 0
            : successfulSettlements >= 1 &&
              successfulSettlements <= expectedEvents) &&
          action.basisCoveredOverlayDrops === expectedEvents;
      },
      { timeout: TIMEOUT, args: [query, key, events] },
    );
  } catch (cause) {
    const latest = await executionRoutingDiagnostics(page, query).catch(
      (diagnosticCause) => ({
        diagnosticReadError: diagnosticCause instanceof Error
          ? diagnosticCause.message
          : String(diagnosticCause),
      }),
    );
    throw new Error(
      `timed out waiting for exact authoritative routing phase with ${events} events. Snapshot: ${
        JSON.stringify(latest)
      }`,
      { cause },
    );
  }
  const diagnostics = await executionRoutingDiagnostics(page, query);
  assertExactRoutingPhase(diagnostics, { key, authoritative: true, events });
  return diagnostics;
}

type LazyObserverResult = { ok: true } | { ok: false; error: string };
type LazyObserverState = {
  promise: Promise<LazyObserverResult>;
  cancel(): void;
};

async function armLazyFinalObserver(
  page: Page,
  expectedText: string,
  timeout = TIMEOUT,
): Promise<void> {
  const target = await page.waitForSelector("#rollout-doubled", {
    strategy: "pierce",
    timeout,
  });
  await target.evaluate((element: Element, text: string, timeout: number) => {
    const scope = globalThis as typeof globalThis & {
      __serverPrimaryLazyObserver?: LazyObserverState;
    };
    scope.__serverPrimaryLazyObserver?.cancel();
    let finish!: (result: LazyObserverResult) => void;
    let finished = false;
    const promise = new Promise<LazyObserverResult>((resolve) => {
      finish = resolve;
    });
    const complete = (result: LazyObserverResult) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      finish(result);
    };
    const check = () => {
      const value = element.textContent;
      if (value?.includes(text)) complete({ ok: true });
    };
    const observer = new MutationObserver(check);
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const timer = setTimeout(
      () =>
        complete({
          ok: false,
          error: `lazy observer did not see ${
            JSON.stringify(text)
          } within ${timeout}ms`,
        }),
      timeout,
    );
    scope.__serverPrimaryLazyObserver = {
      promise,
      cancel: () => complete({ ok: false, error: "lazy observer cancelled" }),
    };
    check();
  }, { args: [expectedText, timeout] });
}

async function awaitLazyFinalObserver(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const scope = globalThis as typeof globalThis & {
      __serverPrimaryLazyObserver?: LazyObserverState;
    };
    const state = scope.__serverPrimaryLazyObserver;
    if (!state) return { ok: false, error: "lazy observer was not armed" };
    const result = await state.promise;
    delete scope.__serverPrimaryLazyObserver;
    return result;
  });
  if (!result.ok) throw new Error(result.error);
}

async function cancelLazyFinalObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __serverPrimaryLazyObserver?: LazyObserverState;
    };
    scope.__serverPrimaryLazyObserver?.cancel();
    delete scope.__serverPrimaryLazyObserver;
  }).catch(() => {});
}

async function lazySyncedIdleBarrier(page: Page): Promise<void> {
  await runtimeAllSynced(page);
  await waitForRuntimeIdle(page, { timeout: TIMEOUT });
  await runtimeAllSynced(page);
}

const rendererIds = (metrics: BrowserProcessMetrics): number[] =>
  metrics.processes.filter((process) => process.type === "renderer")
    .map((process) => process.id).sort((left, right) => left - right);

const assertRendererCountersContinue = (
  previous: BrowserProcessMetrics,
  current: BrowserProcessMetrics,
): void => {
  const previousRenderers = new Map(
    previous.processes.filter((process) => process.type === "renderer").map(
      (process) => [process.id, process.cpuTimeSeconds],
    ),
  );
  assertEquals(rendererIds(current), rendererIds(previous));
  for (
    const process of current.processes.filter((entry) =>
      entry.type === "renderer"
    )
  ) {
    const previousCpu = previousRenderers.get(process.id);
    assert(previousCpu !== undefined);
    assert(
      process.cpuTimeSeconds >= previousCpu,
      `renderer ${process.id} CPU counter reset between phases`,
    );
  }
};

(SERVER_EXECUTION_ENABLED ? describe : describe.ignore)(
  "server-primary browser rollout measurement",
  () => {
    const actorShell = new ShellIntegration();
    const lazyShell = new ShellIntegration();
    actorShell.bindLifecycle();
    lazyShell.bindLifecycle();

    let actorIdentity: Identity;
    let lazyIdentity: Identity;
    let creator: PiecesController;
    let space: MemorySpace;
    let pieceId: string;
    let executionPieceId: string;
    let doubledEntityId: string;
    let resultSinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      // Empty-demand publication acknowledges before asynchronous pool drain
      // finishes. Fence prior serial integration tests before taking any
      // process-global placement baseline or creating this test's own demand.
      await waitFor(serverExecutionPoolIsQuiescent, { timeout: TIMEOUT });
      [actorIdentity, lazyIdentity] = await Promise.all([
        Identity.generate({ implementation: "noble" }),
        Identity.generate({ implementation: "noble" }),
      ]);
      creator = await initializePiecesController({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: actorIdentity,
      });
      space = creator.manager().getSpace();
      await creator.ensureDefaultPattern();
      const sourcePath = join(
        import.meta.dirname!,
        "fixtures",
        "server-primary-rollout.tsx",
      );
      const program = await creator.manager().runtime.harness.resolve(
        new FileSystemProgramResolver(
          sourcePath,
          join(import.meta.dirname!, ".."),
        ),
      );
      const piece = await creator.create(program, { start: true });
      pieceId = piece.id;
      const rootLink = piece.getCell().getAsNormalizedFullLink();
      executionPieceId = `${rootLink.scope}:${rootLink.id}`;
      const result = creator.manager().getResult(piece.getCell());
      doubledEntityId = result.key("doubled").resolveAsCell()
        .getAsNormalizedFullLink().id;
      resultSinkCancel = result.sink(() => {});
    });

    afterAll(async () => {
      resultSinkCancel?.();
      await creator?.dispose();
    });

    it("records repeated authoritative server execution phases", async () => {
      const actorPage = actorShell.page();
      const lazyPage = lazyShell.page();
      const view = { spaceName: SPACE_NAME, pieceId };
      await Promise.all([
        actorShell.goto({
          frontendUrl: FRONTEND_URL,
          view,
          identity: actorIdentity,
        }),
        lazyShell.goto({
          frontendUrl: FRONTEND_URL,
          view,
          identity: lazyIdentity,
        }),
      ]);
      await Promise.all([
        waitForRuntimeIdle(actorPage, { timeout: TIMEOUT }),
        waitForRuntimeIdle(lazyPage, { timeout: TIMEOUT }),
      ]);
      await Promise.all([
        waitForText(actorPage, "#rollout-doubled", "doubled:0"),
        waitForText(lazyPage, "#rollout-doubled", "doubled:0"),
      ]);

      let expectedCount = 0;
      const clickActorAndWait = async (): Promise<void> => {
        expectedCount += 1;
        await clickCfButton(actorPage, "#rollout-increment");
        await waitForText(
          actorPage,
          "#rollout-doubled",
          `doubled:${expectedCount * 2}`,
          { timeout: TIMEOUT },
        );
        await waitForRuntimeIdle(actorPage, { timeout: TIMEOUT });
        await runtimeAllSynced(actorPage);
      };

      const scopedQuery: ExecutionRoutingDiagnosticsQuery = {
        space,
        branch: "",
        pieceId: executionPieceId,
      };

      const discoverExactAction = async (): Promise<{
        discovered: DiscoveredRolloutAction;
        trace: ActionTraceEntry[];
      }> => {
        await resetActionTrace(actorPage);
        let lastEvidence: unknown;
        for (let attempt = 0; attempt < 12; attempt++) {
          await clickActorAndWait();
          await waitForCondition(
            actorPage,
            async (
              _probe,
              request: ExecutionRoutingDiagnosticsQuery,
              resultEntityId: string,
            ) => {
              const rt = (globalThis as typeof globalThis & {
                commonfabric?: { rt?: BrowserRuntime };
              }).commonfabric?.rt;
              if (!rt) return false;
              const [trace, diagnostics] = await Promise.all([
                rt.getActionRunTrace(),
                rt.getExecutionRoutingDiagnostics(request),
              ]);
              const writingIds = new Set(
                trace.filter((entry) =>
                  entry.actualWrites.some((write) =>
                    write.entityId === resultEntityId
                  )
                ).map((entry) => entry.actionId),
              );
              const claims = diagnostics.claims.filter((claim) =>
                writingIds.has(claim.actionId)
              );
              if (claims.length !== 1) return false;
              const claim = claims[0];
              const actions = diagnostics.actions.filter((action) => {
                const candidate = action.key;
                return candidate.branch === claim.branch &&
                  candidate.space === claim.space &&
                  candidate.contextKey === claim.contextKey &&
                  candidate.pieceId === claim.pieceId &&
                  candidate.actionId === claim.actionId &&
                  candidate.actionKind === claim.actionKind &&
                  candidate.implementationFingerprint ===
                    claim.implementationFingerprint &&
                  candidate.runtimeFingerprint === claim.runtimeFingerprint;
              });
              return !diagnostics.snapshotRequired && claims.length === 1 &&
                actions.length === 1;
            },
            { timeout: 5_000, args: [scopedQuery, doubledEntityId] },
          ).catch(() => {});
          const [trace, diagnostics] = await Promise.all([
            actionTrace(actorPage),
            executionRoutingDiagnostics(actorPage, scopedQuery),
          ]);
          try {
            const discovered = discoverScopedWritingAction(
              trace,
              diagnostics,
              doubledEntityId,
            );
            // Claim publication is only route readiness. Wait until that exact
            // claim incarnation has also settled successfully before measuring
            // it, so discovery cannot race ahead of durable scheduler evidence.
            await waitForAuthoritativePreflightSettlement(
              actorPage,
              discovered.key,
              "initial discovery",
            );
            // A route-ready activation commonly settles no-op after the actor
            // has already written the same result. Drive one changing event
            // under the installed claim and require its accepted commit before
            // measurement, so discovery has a durable writer observation
            // rather than only process-local evidence.
            await rawResetExactRoutingCounters(actorPage, discovered.key);
            await clickActorAndWait();
            const durableReadiness = await waitForExactRoutingPhase(
              actorPage,
              discovered.key,
              1,
            );
            const durableSettlement = durableReadiness.actions[0]
              ?.lastSettlement;
            assert(durableSettlement !== undefined);
            assertEquals(durableSettlement.outcome, "committed");
            assertEquals(durableReadiness.actions[0].settlements.committed, 1);
            assertEquals(durableReadiness.actions[0].settlements.noOp, 0);
            assert(durableSettlement.acceptedCommitSeq !== undefined);
            assert(
              durableReadiness.executionAppliedSeq >=
                durableSettlement.acceptedCommitSeq,
            );
            await waitForText(
              lazyPage,
              "#rollout-doubled",
              `doubled:${expectedCount * 2}`,
              { timeout: TIMEOUT },
            );
            await lazySyncedIdleBarrier(lazyPage);
            return { discovered, trace };
          } catch (cause) {
            lastEvidence = {
              attempt: attempt + 1,
              trace,
              diagnostics,
              error: cause instanceof Error ? cause.message : String(cause),
            };
          }
        }
        throw new Error(
          `could not discover exactly one claimed actor writer: ${
            JSON.stringify(lastEvidence)
          }`,
        );
      };

      const { discovered, trace: discoveryTrace } = await discoverExactAction()
        .finally(() => disableActionTrace(actorPage));
      const actionKey = discovered.key;
      assertEquals(actionKey.pieceId, executionPieceId);

      const preflightAuthority = async (): Promise<void> => {
        // Event 1 must prove fresh authority, not reuse an activation
        // settlement or route retained from the previous block.
        await rawResetExactRoutingCounters(actorPage, actionKey);
        const finalCount = expectedCount + AUTHORITY_PREFLIGHT_EVENTS;
        await armLazyFinalObserver(
          lazyPage,
          `doubled:${finalCount * 2}`,
        );
        try {
          // Event 1 invalidates the exact action and must expose a successful
          // post-reset settlement under the current live claim. This setup
          // traffic is deliberately discarded before event 2.
          await clickActorAndWait();
          await waitForAuthoritativePreflightSettlement(actorPage, actionKey);
          await resetExactRoutingCounters(
            actorPage,
            actionKey,
          );

          // Event 2 must take exactly the route that the following block will
          // measure. This is an authority preflight, never a warmup/CPU sample.
          await clickActorAndWait();
          await waitForExactRoutingPhase(
            actorPage,
            actionKey,
            1,
          );
          await awaitLazyFinalObserver(lazyPage);
          await lazySyncedIdleBarrier(lazyPage);
          await resetExactRoutingCounters(
            actorPage,
            actionKey,
          );
        } catch (cause) {
          await cancelLazyFinalObserver(lazyPage);
          throw cause;
        }
      };

      const runWarmupBlock = async (): Promise<void> => {
        await preflightAuthority();
        const finalCount = expectedCount + WARMUP_EVENTS_PER_BLOCK;
        await armLazyFinalObserver(
          lazyPage,
          `doubled:${finalCount * 2}`,
        );
        try {
          for (let index = 0; index < WARMUP_EVENTS_PER_BLOCK; index++) {
            await clickActorAndWait();
          }
          await waitForExactRoutingPhase(
            actorPage,
            actionKey,
            WARMUP_EVENTS_PER_BLOCK,
          );
          await awaitLazyFinalObserver(lazyPage);
          await lazySyncedIdleBarrier(lazyPage);
        } catch (cause) {
          await cancelLazyFinalObserver(lazyPage);
          throw cause;
        }
      };

      // Repeated unmeasured warmup moves discovery, compilation, and initial
      // rendering out of the measured authoritative phases. Each block's two
      // authority-preflight events remain separate.
      for (let index = 0; index < 2; index++) {
        await runWarmupBlock();
      }

      let processMonitor: CdpWorkerProfiler | undefined;
      if (CPU_BENCH) {
        // This connection never attaches to a worker. The authoritative sample
        // uses only browser-level SystemInfo counters, never Profiler.start.
        processMonitor = await CdpWorkerProfiler.connect(
          lazyShell.wsEndpoint(),
          { attachWorkers: false },
        );
      }
      let rendererTopology: number[] | undefined;
      let previousProcessAfter: BrowserProcessMetrics | undefined;

      const runPhase = async (
        label: string,
      ): Promise<PhaseResult> => {
        await preflightAuthority();
        const serverExecutionBefore = await readServerExecutionCounters();
        const lazyActionRunsBefore = await actionRunCounts(lazyPage);
        const loadBefore = await collectBrowserLoadSummary(
          actorPage,
          `${label}-before`,
        );
        const finalCount = expectedCount + CPU_EVENTS;
        await armLazyFinalObserver(
          lazyPage,
          `doubled:${finalCount * 2}`,
          MEASURED_OBSERVER_TIMEOUT,
        );

        // Authoritative lazy-browser CPU bracket. The event batch never polls
        // or settles the lazy client; one final observer and synced-idle-synced
        // barrier below intentionally close all feed, overlay, and render work.
        const processCpuBefore = processMonitor
          ? await processMonitor.readBrowserProcessMetrics()
          : undefined;
        for (let index = 0; index < CPU_EVENTS; index++) {
          await clickActorAndWait();
        }
        const routing = await waitForExactRoutingPhase(
          actorPage,
          actionKey,
          CPU_EVENTS,
        );

        // Authority must settle before touching the lazy client. Then include
        // its one final render observation and convergence barrier in the CPU
        // bracket before reading process-after.
        await awaitLazyFinalObserver(lazyPage);
        await lazySyncedIdleBarrier(lazyPage);
        const processCpuAfter = processMonitor
          ? await processMonitor.readBrowserProcessMetrics()
          : undefined;

        let browserProcessCpu: PhaseResult["browserProcessCpu"];
        if (processCpuBefore && processCpuAfter) {
          if (previousProcessAfter) {
            assertRendererCountersContinue(
              previousProcessAfter,
              processCpuBefore,
            );
          }
          const phaseTopology = rendererIds(processCpuBefore);
          assert(phaseTopology.length > 0, "lazy browser exposed no renderers");
          if (rendererTopology === undefined) rendererTopology = phaseTopology;
          else assertEquals(phaseTopology, rendererTopology);
          let rendererDelta: RendererProcessCpuDelta;
          try {
            rendererDelta = deltaRendererProcessCpu(
              processCpuBefore,
              processCpuAfter,
            );
          } catch (cause) {
            if (PROFILE_DIR) {
              await Deno.mkdir(PROFILE_DIR, { recursive: true });
              await Deno.writeTextFile(
                join(PROFILE_DIR, "server-primary-rollout-cpu-error.json"),
                JSON.stringify(
                  {
                    capturedAt: new Date().toISOString(),
                    label,
                    before: processCpuBefore,
                    after: processCpuAfter,
                    routing,
                    error: cause instanceof Error
                      ? {
                        name: cause.name,
                        message: cause.message,
                        stack: cause.stack,
                      }
                      : String(cause),
                  },
                  null,
                  2,
                ),
              );
            }
            throw cause;
          }
          assert(
            rendererDelta.totalCpuTimeUs >= CPU_FLOOR_US,
            `${label} renderer CPU ${rendererDelta.totalCpuTimeUs}us was below the ${CPU_FLOOR_US}us noise floor`,
          );
          browserProcessCpu = {
            before: processCpuBefore,
            after: processCpuAfter,
            rendererDelta,
          };
          previousProcessAfter = processCpuAfter;
        }

        const lazyActionRunsAfter = await actionRunCounts(lazyPage);
        const beforeRunCount = lazyActionRunsBefore[actionKey.actionId] ?? 0;
        const afterRunCount = lazyActionRunsAfter[actionKey.actionId] ?? 0;
        assert(
          afterRunCount >= beforeRunCount,
          `lazy action ${actionKey.actionId} run count decreased`,
        );
        const loadAfter = await collectBrowserLoadSummary(
          actorPage,
          `${label}-after`,
        );
        const serverExecutionAfter = await readServerExecutionCounters();
        assert(
          serverExecutionAfter.claimsIssued > 0,
          `${label} observed no server-issued execution claim`,
        );
        const serverExecutionCounters = serverExecutionDelta(
          serverExecutionBefore,
          serverExecutionAfter,
        );
        assert(
          serverExecutionCounters.actionTransactions.authoritative > 0,
          `${label} observed no authoritative server action transaction`,
        );
        assert(
          serverExecutionCounters.acceptedActionAttempts > 0,
          `${label} observed no accepted server action attempt`,
        );
        assert(
          serverExecutionCounters.settlements.committed +
              serverExecutionCounters.settlements.noOp > 0,
          `${label} observed no successful server settlement`,
        );
        assertEquals(serverExecutionCounters.settlements.failed, 0);
        assertEquals(serverExecutionCounters.settlements.unserved, 0);
        const { claimsIssued, ...serverExecutionWithoutClaims } =
          serverExecutionCounters;
        const serverExecution: PhaseResult["serverExecution"] = {
          ...serverExecutionWithoutClaims,
          claimsIssued: {
            total: serverExecutionAfter.claimsIssued,
            duringPhase: claimsIssued,
          },
        };
        return {
          label,
          events: CPU_EVENTS,
          lazyActionRuns: afterRunCount - beforeRunCount,
          clientDerivedSuppressed: loadAfter.churn.clientDerivedSuppressed -
            loadBefore.churn.clientDerivedSuppressed,
          clientDerivedUpstreamCommits:
            loadAfter.churn.clientDerivedUpstreamCommits -
            loadBefore.churn.clientDerivedUpstreamCommits,
          serverExecutionBoundary: "claimed-settlement",
          serverExecution,
          routing,
          ...(browserProcessCpu ? { browserProcessCpu } : {}),
        };
      };

      const phases: PhaseResult[] = [];
      try {
        for (const label of PHASES) {
          phases.push(await runPhase(label));
        }
        console.log(
          `server-primary execution placement phases: ${
            JSON.stringify({
              deploymentMode: "server-primary",
              serverScope: "toolshed-process",
              baseline: "zero-lane-quiescence",
              phases: phases.map((phase) => ({
                label: phase.label,
                events: phase.events,
                client: {
                  exactLazySchedulerRuns: phase.lazyActionRuns,
                  actionTransactions: {
                    suppressed: phase.clientDerivedSuppressed,
                    upstream: phase.clientDerivedUpstreamCommits,
                  },
                },
                server: {
                  boundary: phase.serverExecutionBoundary,
                  ...phase.serverExecution,
                },
              })),
            })
          }`,
        );

        if (CPU_BENCH) {
          const cpuPerEvent = phases.map((phase) => {
            const total = phase.browserProcessCpu?.rendererDelta.totalCpuTimeUs;
            assert(total !== undefined, `${phase.label} omitted renderer CPU`);
            return total / phase.events;
          });
          const cpuPhases = phases.map((phase) => ({
            label: phase.label,
            rendererCpuUs: phase.browserProcessCpu?.rendererDelta
              .totalCpuTimeUs,
            renderers: phase.browserProcessCpu?.rendererDelta.renderers,
            lazyActionRuns: phase.lazyActionRuns,
            clientDerivedSuppressed: phase.clientDerivedSuppressed,
            clientDerivedUpstreamCommits: phase.clientDerivedUpstreamCommits,
            serverExecutionBoundary: phase.serverExecutionBoundary,
            serverExecution: phase.serverExecution,
          }));
          console.log(
            `authoritative lazy-browser CPU phases: ${
              JSON.stringify({ cpuPerEvent, phases: cpuPhases })
            }`,
          );
          if (PROFILE_DIR) {
            await Deno.mkdir(PROFILE_DIR, { recursive: true });
            await Deno.writeTextFile(
              join(PROFILE_DIR, "server-primary-rollout-cpu-phases.json"),
              JSON.stringify(
                {
                  capturedAt: new Date().toISOString(),
                  deploymentMode: "server-primary",
                  measuredEventsPerPhase: CPU_EVENTS,
                  cpuPerEvent,
                  phases: cpuPhases,
                },
                null,
                2,
              ),
            );
          }
        }

        if (PROFILE_DIR) {
          await Deno.mkdir(PROFILE_DIR, { recursive: true });
          await Deno.writeTextFile(
            join(PROFILE_DIR, "server-primary-rollout-summary.json"),
            JSON.stringify(
              {
                capturedAt: new Date().toISOString(),
                space: SPACE_NAME,
                actionKey,
                discoveryClaim: discovered.claim,
                discoveryWrites: discoveryTrace.filter((entry) =>
                  entry.actionId === actionKey.actionId
                ).flatMap((entry) => entry.actualWrites),
                authorityPreflightEventsPerBlock: AUTHORITY_PREFLIGHT_EVENTS,
                warmupEventsPerBlock: WARMUP_EVENTS_PER_BLOCK,
                measuredEventsPerPhase: CPU_EVENTS,
                phases,
              },
              null,
              2,
            ),
          );
        }

        // Optional sampling is deliberately after all authoritative SystemInfo
        // phases. It is diagnostic only: attaching a worker profiler cannot
        // influence the measurements above.
        if (CPU_BENCH && PROFILE_DIR) {
          const diagnosticEvents = Math.min(CPU_EVENTS, 100);
          let sampler: CdpWorkerProfiler | undefined;
          try {
            await preflightAuthority();
            const finalCount = expectedCount + diagnosticEvents;
            await armLazyFinalObserver(
              lazyPage,
              `doubled:${finalCount * 2}`,
            );
            sampler = await CdpWorkerProfiler.connect(
              lazyShell.wsEndpoint(),
            );
            await sampler.waitForWorker("worker-runtime");
            await sampler.start("worker-runtime");
            for (let index = 0; index < diagnosticEvents; index++) {
              await clickActorAndWait();
            }
            const routing = await waitForExactRoutingPhase(
              actorPage,
              actionKey,
              diagnosticEvents,
            );
            const profile = await sampler.stop();
            await awaitLazyFinalObserver(lazyPage);
            await lazySyncedIdleBarrier(lazyPage);
            await Deno.writeTextFile(
              join(
                PROFILE_DIR,
                "diagnostic-authoritative-non-gating.cpuprofile",
              ),
              JSON.stringify(profile),
            );
            await Deno.writeTextFile(
              join(PROFILE_DIR, "diagnostic-authoritative-non-gating.json"),
              JSON.stringify(
                {
                  capturedAt: new Date().toISOString(),
                  explicitlyNonGating: true,
                  events: diagnosticEvents,
                  routing,
                  cpu: summarizeCPUProfile(profile),
                },
                null,
                2,
              ),
            );
          } catch (cause) {
            const error = cause instanceof Error
              ? { name: cause.name, message: cause.message, stack: cause.stack }
              : { message: String(cause) };
            console.warn(
              `non-gating worker CPU diagnostic failed: ${
                JSON.stringify(error)
              }`,
            );
            await cancelLazyFinalObserver(lazyPage);
            await Deno.writeTextFile(
              join(
                PROFILE_DIR,
                "diagnostic-authoritative-non-gating-failure.json",
              ),
              JSON.stringify(
                {
                  capturedAt: new Date().toISOString(),
                  explicitlyNonGating: true,
                  error,
                },
                null,
                2,
              ),
            ).catch(() => {});
          } finally {
            sampler?.close();
          }
        }
      } finally {
        processMonitor?.close();
        await cancelLazyFinalObserver(lazyPage);
      }
    });
  },
);
