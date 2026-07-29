import * as MemoryServer from "@commonfabric/memory/v2/server";
import {
  applyServerPrimaryExecutionEnvConfig,
  applyServerPrimaryExecutionGraphRetirementEnvConfig,
} from "@commonfabric/memory/v2";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import * as FS from "@std/fs";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import { identity } from "@/lib/identity.ts";
import type { Runtime } from "@commonfabric/runner";
import {
  type ExecutionPoolMetricsSnapshot,
  SharedExecutionPool,
} from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  setServerExecutionControlMetricsProvider,
  setServerExecutionFeedMetricsProvider,
  setServerExecutionPoolMetricsProvider,
} from "@/lib/server-execution-observability.ts";

const memoryAudience = identity.did();

// Session.open verification is shared with the standalone server. Toolshed
// requires the signed invocation to carry its audience DID and the challenge
// issued to this WebSocket connection.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

// The store URL is derived in memory-store-url.ts (DB_PATH single-file mode or
// MEMORY_DIR directory mode). Log which mode is active for this server.
if (env.DB_PATH) {
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

export { memoryEngineStoreUrl };
await FS.ensureDir(memoryEngineStoreUrl);

// FW5 (FB10): apply the F5 per-space doc-set admission dial from
// EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES (comma-
// separated space DIDs, or `*`) at server construction, so the W2.9
// measurement protocol is executable against a deployed toolshed. The parser
// lives in @commonfabric/memory next to the dial; see the
// `serverPrimaryExecutionGraphRetirement` entry in
// docs/development/EXPERIMENTAL_OPTIONS.md.
applyServerPrimaryExecutionGraphRetirementEnvConfig(Deno.env.get);

// FW6: install the server-primary ADVERTISEMENT dials from the env at server
// construction, not as a side effect of the later `initializeRuntime()` —
// the advertisement must not depend on whether (or when) a runner Runtime is
// constructed in this process, and must survive its disposal. Unset env
// leaves the dials at their defaults (everything advertised false).
applyServerPrimaryExecutionEnvConfig(Deno.env.get);

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
  sessionOpenAuth: {
    audience: memoryAudience,
  },
  acl: {
    mode: env.MEMORY_ACL_MODE,
    serviceDids: env.MEMORY_SERVICE_DIDS
      .split(",")
      .map((did) => did.trim())
      .filter((did) => did.length > 0),
  },
});
let executionPool: SharedExecutionPool | null = null;

export function serverExecutionPoolMetrics():
  | ExecutionPoolMetricsSnapshot
  | null {
  return executionPool?.metrics() ?? null;
}

setServerExecutionPoolMetricsProvider(serverExecutionPoolMetrics);
setServerExecutionControlMetricsProvider(() => memoryServer.executionStats);
setServerExecutionFeedMetricsProvider(() => memoryServer.feedStats);

// P1 §5c step-1 serving sampler (client-passivity §0 forward step 1): a 1s
// delta line over the floor-less per-operation traversal timing, the wave
// drain/fanout split, transact ack timing, the tracked-graph gauge, and an
// event-loop-lag window. The engaged-tail attribution had to reconstruct
// these from the >100ms slow-query floor; this makes sub-floor serving work
// a first-class time series in the toolshed log. Runs in BOTH arms (it does
// not depend on server-primary execution), so flag-off runs carry the same
// series. Quiet when idle: emits only when something changed or the event
// loop stalled ≥50ms. Timers are unref'd so they never hold the process.
{
  const LOOP_LAG_TICK_MS = 100;
  const SERVING_SAMPLE_MS = 1000;
  const LAG_EMIT_FLOOR_MS = 50;
  const lagWindow = { ticks: 0, totalMs: 0, maxMs: 0 };
  let lagExpectedAt = performance.now() + LOOP_LAG_TICK_MS;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lagExpectedAt);
    lagExpectedAt = now + LOOP_LAG_TICK_MS;
    lagWindow.ticks += 1;
    lagWindow.totalMs += lag;
    if (lag > lagWindow.maxMs) lagWindow.maxMs = lag;
  }, LOOP_LAG_TICK_MS);
  Deno.unrefTimer(lagTimer);

  type OpSnapshot = Record<string, { c: number; ms: number }>;
  const snapshotOps = (): OpSnapshot => {
    const ops: OpSnapshot = {};
    for (
      const [operation, bucket] of Object.entries(
        memoryServer.feedStats.traversalByOperation,
      )
    ) {
      ops[operation] = { c: bucket.calls, ms: bucket.totalMs };
    }
    return ops;
  };
  let lastOps = snapshotOps();
  let lastDrainMs = 0;
  let lastFanoutMs = 0;
  let lastAcks = 0;
  let lastAckMs = 0;
  const samplerTimer = setInterval(() => {
    const feed = memoryServer.feedStats;
    const ops = snapshotOps();
    const opDeltas: Record<string, { c: number; ms: number }> = {};
    let opActivity = false;
    for (const [operation, current] of Object.entries(ops)) {
      const previous = lastOps[operation];
      const c = current.c - (previous?.c ?? 0);
      if (c <= 0) continue;
      opActivity = true;
      opDeltas[operation] = {
        c,
        ms: Math.round(current.ms - (previous?.ms ?? 0)),
      };
    }
    const drainMs = Math.round(feed.waveDrainWaitMs - lastDrainMs);
    const fanoutMs = Math.round(feed.waveFanoutMs - lastFanoutMs);
    const acks = feed.transactAcks - lastAcks;
    const ackMs = Math.round(feed.transactAckTotalMs - lastAckMs);
    const lagMax = Math.round(lagWindow.maxMs);
    const lagAvg = lagWindow.ticks > 0
      ? Math.round(lagWindow.totalMs / lagWindow.ticks)
      : 0;
    const active = opActivity || drainMs > 0 || fanoutMs > 0 || acks > 0 ||
      lagMax >= LAG_EMIT_FLOOR_MS;
    lastOps = ops;
    lastDrainMs = feed.waveDrainWaitMs;
    lastFanoutMs = feed.waveFanoutMs;
    lastAcks = feed.transactAcks;
    lastAckMs = feed.transactAckTotalMs;
    lagWindow.ticks = 0;
    lagWindow.totalMs = 0;
    lagWindow.maxMs = 0;
    if (!active) return;
    const gauge = memoryServer.trackedGraphGauge();
    console.debug(
      "Memory: serving:",
      `t=${Date.now()}`,
      JSON.stringify({
        lag: { max: lagMax, avg: lagAvg },
        drainMs,
        fanoutMs,
        acks,
        ackMs,
        tracked: {
          s: gauge.sessions,
          g: gauge.graphs,
          k: gauge.trackerKeys,
          e: gauge.entities,
        },
        ops: opDeltas,
      }),
    );
  }, SERVING_SAMPLE_MS);
  Deno.unrefTimer(samplerTimer);
}

/** P0 (client-passivity plan): the demand grace window's production value.
 * The browser client clears execution demand on every navigation
 * transition; without grace those blips abort in-flight Worker starts and
 * the pool converges to never-live under real navigation cadence (the
 * 2026-07-26 dead-executor finding). 10s default comfortably exceeds the
 * observed Worker cold-start; P1 calibrates it from measured data. The
 * env accepts a non-negative integer millisecond count; anything else is
 * ignored WITH a warning (never coerced), matching the canonical env
 * strictness. `0` restores the legacy immediate abort/drain. */
function nonNegativeIntMsFromEnv(name: string, defaultMs: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return defaultMs;
  if (/^\d+$/.test(raw)) return Number(raw);
  console.warn(
    `[toolshed] Ignoring ${name}=${JSON.stringify(raw)} — expected a ` +
      `non-negative integer (ms).`,
  );
  return defaultMs;
}

function demandGraceMsFromEnv(): number {
  return nonNegativeIntMsFromEnv(
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DEMAND_GRACE_MS",
    10_000,
  );
}

/** P0 companion knob: the executor Worker's init deadline. The library
 * default (30s) loses to real cold-start on a loaded dev machine — the
 * 2026-07-26 acceptance run had BOTH Worker starts fail at exactly 30s
 * with the Worker completing boot moments later (claim-ready traffic
 * right behind the timeout log). 120s default here; P1 measures the real
 * cold-start distribution and D4 calibrates. Also bounds claimed-action
 * activation (deno-space-executor uses one deadline for both). */
function workerStartupTimeoutMsFromEnv(): number {
  return nonNegativeIntMsFromEnv(
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_WORKER_STARTUP_TIMEOUT_MS",
    120_000,
  );
}

/** Start client-demand execution after runtime flags are installed, but before
 * the HTTP server accepts connections. */
export function startServerExecutionPool(runtime: Runtime): void {
  if (
    executionPool !== null ||
    runtime.experimental.serverPrimaryExecution !== true
  ) return;
  // P0-R3c: the executor replica's cold-refresh debounce defaults ON for
  // server-primary deployments. The dial lives in the WORKER realm
  // (v2-host-provider reads it lazily; Workers inherit this process's
  // env — the same channel CF_LOG_TIMING rides), so defaulting it here —
  // before any Worker spawns — makes server-primary imply the debounce
  // while `...=0` still restores the legacy refresh-every-wave behavior.
  const coldRefreshEnv =
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COLD_REFRESH_COOLDOWN_MAX_MS";
  if (Deno.env.get(coldRefreshEnv) === undefined) {
    Deno.env.set(coldRefreshEnv, "2000");
  }
  // P0-R3e: same worker-realm-env pattern for the piece linger — a
  // structurally removed piece keeps its live graph warm for the window
  // (authority fenced immediately), so ordinary navigation churn does not
  // re-pay the measured 7-33s piece instantiation. `...=0` restores the
  // legacy immediate stop.
  const pieceLingerEnv =
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_PIECE_LINGER_MS";
  if (Deno.env.get(pieceLingerEnv) === undefined) {
    Deno.env.set(pieceLingerEnv, "30000");
  }
  // P1 step-1: covered growth pulls default ON for server-primary
  // deployments (same worker-realm env channel). A closure-growth cold
  // refresh asks the server to omit docs the session's tracked surface
  // already covers and merges the delta — the confirm run measured the
  // uncovered pull as the dominant serving cost (graph.query.demand
  // 20.6s/run, zero skips, 1.2s single-call stalls). `...=0` restores
  // legacy full pulls.
  const coveredPullEnv =
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COVERED_GROWTH_PULL";
  if (Deno.env.get(coveredPullEnv) === undefined) {
    Deno.env.set(coveredPullEnv, "1");
  }
  executionPool = new SharedExecutionPool({
    control: memoryServer,
    demandGraceMs: demandGraceMsFromEnv(),
    // C1.8: user-lane lifecycle engages only with the full dial triple —
    // this runner dial plus the host's issuance rank dial and the
    // context-lattice subcapability (checked live via the control).
    userLaneCandidates:
      runtime.experimental.serverPrimaryExecutionUserRankCandidates === true,
    // C2.7: session-lane lifecycle layers on the user leg (the C2.5 rank
    // ladder) plus the host's session-stage dial, checked live via the
    // control (`executionSessionLanesEnabled`).
    sessionLaneCandidates:
      runtime.experimental.serverPrimaryExecutionSessionRankCandidates ===
        true,
    factory: new DenoSpaceExecutorFactory({
      server: memoryServer,
      apiUrl: new URL(env.API_URL),
      patternApiUrl: new URL(env.API_URL),
      experimental: runtime.experimental,
      startupTimeoutMs: workerStartupTimeoutMsFromEnv(),
      // F1 claim-coverage counters are the evidence channel (surfaced under
      // /api/health/stats serverExecutionControl); the debug logs remain for
      // per-candidate detail but are no longer what a measurement greps.
      onCandidateClaim: (candidate) => {
        memoryServer.recordExecutionCandidateClaimReady(candidate.claimKey);
        console.debug(
          "Memory: Server execution candidate claim-ready",
          `t=${Date.now()}`,
          candidate.claimKey,
        );
      },
      onCandidateDiagnostic: (diagnostic) => {
        memoryServer.recordExecutionCandidateUnserved(diagnostic);
        // P0 sponsor re-anchor: authority loss on a live lane means the
        // lease's pinned sponsor died while the demand grace window kept
        // the Worker alive (before the grace window, demand-churn teardowns
        // rotated the sponsor as a side effect). The pool replaces the
        // generation — re-acquisition sponsors against the CURRENT demand
        // set — debounced pool-side (queued flag + cooldown).
        if (diagnostic.diagnosticCode === "claim-authority-lost") {
          const key = diagnostic.claimKey ?? diagnostic.claim;
          if (key !== undefined) {
            executionPool?.noteClaimAuthorityLoss(key.space, key.branch);
          }
        }
        console.debug(
          "Memory: Server execution candidate unserved",
          diagnostic,
        );
      },
      onWriterDiscovery: (discovery) =>
        console.debug(
          "Memory: Server execution writer discovery",
          discovery,
        ),
    }),
  });
  executionPool.start();
  console.log("Memory: Server execution pool started");
}

export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    await executionPool?.close();
    executionPool = null;
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
