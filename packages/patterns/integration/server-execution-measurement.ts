import { env, type Page, waitFor } from "@commonfabric/integration";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import type {
  ExecutionRoutingDiagnostics,
  ExecutionRoutingDiagnosticsQuery,
} from "@commonfabric/runner/shared";
import { assert, assertEquals } from "@std/assert";
import {
  isRoutingMeasurementBaselineReady,
  isRoutingMeasurementResultReady,
  routingMeasurementProblemActions,
} from "../server-execution-measurement-helpers.ts";

const MEASUREMENT_REQUIRED = Deno.env.get(
  "CF_VERIFY_SERVER_EXECUTION_PLACEMENT",
) === "1";

type PlacementCounters = Readonly<{
  schedulerRuns: number;
  shadowActionTransactions: number;
  authoritativeActionTransactions: number;
}>;

type PoolCounters = Readonly<{
  activeLanes: number;
  activeWorkers: number;
  activeDemands: number;
  states: Readonly<
    Record<
      "waiting" | "excluded" | "starting" | "live" | "draining" | "backoff",
      number
    >
  >;
  demandSnapshots: number;
  workerStartAttempts: number;
  workerStartAborts: number;
  workersStarted: number;
  workersStopped: number;
  workerStartFailures: number;
  crashes: number;
  placement: PlacementCounters;
}>;

type ControlCounters = Readonly<{
  claimsIssued: number;
  claimsIssuedByContextKey: Readonly<Record<string, number>>;
  claimsRevoked: number;
  claimedActionConflicts: number;
  acceptedActionAttempts: number;
  settlementsCommitted: number;
  settlementsNoOp: number;
  settlementsFailed: number;
  settlementsUnserved: number;
  leaseFenceRejects: number;
  leaseFenceRejectCauses: Readonly<Record<string, number>>;
  actionFirewallRejects: number;
}>;

/**
 * A13 measurement-guard contract: the by-design lease-fence reject causes a
 * measured workload may produce, each named, counted, and carrying an
 * explicit retirement criterion (mirroring register row R7 of
 * context-lattice-execution.md). EVERY other cause is a defect and stays
 * hard-zero. Tests assert through {@link unexpectedLeaseFenceRejects} so the
 * tolerated set has exactly one definition; a cause retires by deleting its
 * entry, which immediately returns it to the hard-zero set.
 */
export type ToleratedLeaseFenceCause = Readonly<{
  cause: string;
  /** Why the cause is by-design rather than a defect. */
  reason: string;
  /** The named condition under which the cause returns to hard-zero. */
  retirement: string;
}>;

// R7 RETIRED (C2.10, 2026-07-18): `claim-context-mismatch` — a space-lane
// claim on an action whose runtime context floor evaluates above the claim's
// context — was tolerated here from 2026-07-15 (register row R7, "temporary
// by construction") until C2 shipped session lanes. Its return to hard-zero
// is the named C2 acceptance criterion (context-lattice-execution.md §7 C2 /
// §8 R7): session-context runs now have a lane to route to, so any mismatch
// is a placement defect again. The entry was deleted per this registry's
// contract ("a cause retires by deleting its entry"); the retirement is
// pinned by the guard-contract test in
// server-execution-lunch-poll-placement-gate.test.ts.
export const TOLERATED_LEASE_FENCE_CAUSES: readonly ToleratedLeaseFenceCause[] =
  [
    {
      cause: "lane-generation-stale",
      // C1.3: a host-side lane drain (anchor-session loss, ACL fence, cohort
      // fence) bumps the lane generation BEFORE sweeping claims, so an
      // in-flight claimed commit bound to the previous generation fences
      // instead of landing after its authority ended. The fence is the drain
      // working as designed, not a defect.
      reason: "an in-flight claimed commit raced a by-design lane drain " +
        "(C1.3 generation fence precedes the claim sweep)",
      retirement: "hard-zero on measurement windows with no lane drain: a " +
        "fixture that performs no re-anchor, revocation, or cohort fence " +
        "must assert zero for this cause explicitly",
    },
    {
      cause: "claim-not-live",
      // C1.3/C1.8: host drains sweep (revoke) lane claims; a claimed run
      // already committed toward a swept claim settles against a claim that
      // is no longer live. Same drain design as above, observed on the claim
      // rather than the generation.
      reason: "a claimed run settled against a claim swept by a by-design " +
        "lane drain (C1.8 re-anchor / ACL reconciliation)",
      retirement: "hard-zero on drain-free measurement windows (same " +
        "condition as lane-generation-stale); drain-race coverage moves to " +
        "the owed C1.10 engine-level TOCTOU fixture",
    },
  ];

/**
 * The A13 guard: lease-fence rejects not covered by the tolerated registry.
 * Measurement gates assert this is zero and report the full cause map on
 * failure.
 */
export function unexpectedLeaseFenceRejects(
  causes: Readonly<Record<string, number>>,
): number {
  return Object.entries(causes).reduce(
    (total, [cause, count]) =>
      TOLERATED_LEASE_FENCE_CAUSES.some((entry) => entry.cause === cause)
        ? total
        : total + count,
    0,
  );
}

export type ServerExecutionMeasurement = Readonly<{
  label: string;
  enabled: boolean;
  startedAt: number;
  pool: PoolCounters | null;
  control: ControlCounters | null;
  clientRouting?: readonly ServerExecutionRoutingMeasurement[];
}>;

type ExecutionRoutingProbe = (
  query: ExecutionRoutingDiagnosticsQuery,
) => Promise<ExecutionRoutingDiagnostics>;

export type ServerExecutionRoutingMeasurement = Readonly<{
  /** Distinguishes principals in a multi-client measurement; the C1.9 gate
   * runs one probe per principal. Optional for the single-client callers. */
  label?: string;
  query: ExecutionRoutingDiagnosticsQuery;
  read: ExecutionRoutingProbe;
}>;

type HealthStats = {
  timestamp?: number;
  serverExecutionPool?: {
    activeLanes?: number;
    activeWorkers?: number;
    activeDemands?: number;
    states?: Partial<PoolCounters["states"]>;
    demandSnapshots?: number;
    workerStartAttempts?: number;
    workerStartAborts?: number;
    workersStarted?: number;
    workersStopped?: number;
    workerStartFailures?: number;
    crashes?: number;
    executionPlacement?: {
      schedulerRuns?: number;
      actionTransactions?: {
        shadow?: number;
        authoritative?: number;
      };
    };
  } | null;
  serverExecutionControl?: {
    claimsIssued?: number;
    claimsIssuedByContextKey?: Record<string, number>;
    claimsRevoked?: number;
    claimedActionConflicts?: number;
    acceptedActionAttempts?: number;
    settlementsCommitted?: number;
    settlementsNoOp?: number;
    settlementsFailed?: number;
    settlementsUnserved?: number;
    leaseFenceRejects?: number;
    leaseFenceRejectCauses?: Record<string, number>;
    actionFirewallRejects?: number;
  } | null;
};

const counter = (value: unknown, label: string): number => {
  assert(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `invalid ${label} counter: ${String(value)}`,
  );
  return Number(value);
};

async function readMeasurement(
  label: string,
): Promise<ServerExecutionMeasurement> {
  const enabled = experimentalOptionsFromEnv(Deno.env.get)
    .serverPrimaryExecution === true;
  const response = await fetch(new URL("/api/health/stats", env.API_URL));
  assert(response.ok, `execution health returned ${response.status}`);
  const health = await response.json() as HealthStats;
  const pool = health.serverExecutionPool === null
    ? null
    : health.serverExecutionPool === undefined
    ? undefined
    : {
      activeLanes: counter(
        health.serverExecutionPool.activeLanes,
        "active execution lanes",
      ),
      activeWorkers: counter(
        health.serverExecutionPool.activeWorkers,
        "active execution workers",
      ),
      activeDemands: counter(
        health.serverExecutionPool.activeDemands,
        "active execution demands",
      ),
      states: {
        waiting: counter(
          health.serverExecutionPool.states?.waiting,
          "waiting execution lanes",
        ),
        excluded: counter(
          health.serverExecutionPool.states?.excluded,
          "excluded execution lanes",
        ),
        starting: counter(
          health.serverExecutionPool.states?.starting,
          "starting execution lanes",
        ),
        live: counter(
          health.serverExecutionPool.states?.live,
          "live execution lanes",
        ),
        draining: counter(
          health.serverExecutionPool.states?.draining,
          "draining execution lanes",
        ),
        backoff: counter(
          health.serverExecutionPool.states?.backoff,
          "backoff execution lanes",
        ),
      },
      demandSnapshots: counter(
        health.serverExecutionPool.demandSnapshots,
        "execution demand snapshots",
      ),
      workerStartAttempts: counter(
        health.serverExecutionPool.workerStartAttempts,
        "worker start attempts",
      ),
      workerStartAborts: counter(
        health.serverExecutionPool.workerStartAborts,
        "worker start aborts",
      ),
      workersStarted: counter(
        health.serverExecutionPool.workersStarted,
        "workers started",
      ),
      workersStopped: counter(
        health.serverExecutionPool.workersStopped,
        "workers stopped",
      ),
      workerStartFailures: counter(
        health.serverExecutionPool.workerStartFailures,
        "worker start failures",
      ),
      crashes: counter(health.serverExecutionPool.crashes, "worker crashes"),
      placement: {
        schedulerRuns: counter(
          health.serverExecutionPool.executionPlacement?.schedulerRuns,
          "server scheduler runs",
        ),
        shadowActionTransactions: counter(
          health.serverExecutionPool.executionPlacement?.actionTransactions
            ?.shadow,
          "server shadow action transactions",
        ),
        authoritativeActionTransactions: counter(
          health.serverExecutionPool.executionPlacement?.actionTransactions
            ?.authoritative,
          "server authoritative action transactions",
        ),
      },
    };
  assert(pool !== undefined, "server execution pool field is unavailable");

  const rawControl = health.serverExecutionControl;
  const control = rawControl === null
    ? null
    : rawControl === undefined
    ? undefined
    : {
      claimsIssued: counter(rawControl.claimsIssued, "claims issued"),
      claimsIssuedByContextKey: {
        ...(rawControl.claimsIssuedByContextKey ?? {}),
      },
      claimsRevoked: counter(rawControl.claimsRevoked, "claims revoked"),
      claimedActionConflicts: counter(
        rawControl.claimedActionConflicts,
        "claimed action conflicts",
      ),
      acceptedActionAttempts: counter(
        rawControl.acceptedActionAttempts,
        "accepted action attempts",
      ),
      settlementsCommitted: counter(
        rawControl.settlementsCommitted,
        "committed settlements",
      ),
      settlementsNoOp: counter(
        rawControl.settlementsNoOp,
        "no-op settlements",
      ),
      settlementsFailed: counter(
        rawControl.settlementsFailed,
        "failed settlements",
      ),
      settlementsUnserved: counter(
        rawControl.settlementsUnserved,
        "unserved settlements",
      ),
      leaseFenceRejects: counter(
        rawControl.leaseFenceRejects,
        "lease fence rejects",
      ),
      leaseFenceRejectCauses: { ...(rawControl.leaseFenceRejectCauses ?? {}) },
      actionFirewallRejects: counter(
        rawControl.actionFirewallRejects,
        "action firewall rejects",
      ),
    };
  assert(
    control !== undefined,
    "server execution control field is unavailable",
  );

  if (enabled) {
    assert(pool !== null, "flag-on measurement has no server execution pool");
    assert(
      control !== null,
      "flag-on measurement has no server execution control counters",
    );
  } else {
    assertEquals(
      pool,
      null,
      "flag-off measurement unexpectedly started a server execution pool",
    );
  }

  return {
    label,
    enabled,
    startedAt: counter(health.timestamp, "health timestamp"),
    pool,
    control,
  };
}

export async function beginServerExecutionMeasurement(
  label: string,
  clientRouting?:
    | ServerExecutionRoutingMeasurement
    | readonly ServerExecutionRoutingMeasurement[],
): Promise<ServerExecutionMeasurement | null> {
  if (!MEASUREMENT_REQUIRED) return null;
  // One probe per measured client runtime; the C1.9 two-principal gate passes
  // one per principal and every assertion below runs per probe.
  const routingProbes = clientRouting === undefined
    ? []
    : Array.isArray(clientRouting)
    ? clientRouting as readonly ServerExecutionRoutingMeasurement[]
    : [clientRouting as ServerExecutionRoutingMeasurement];
  const enabled = experimentalOptionsFromEnv(Deno.env.get)
    .serverPrimaryExecution === true;
  if (enabled) {
    await waitFor(async () => {
      const measurement = await readMeasurement(label);
      return measurement.pool !== null &&
        measurement.control !== null &&
        measurement.pool.activeWorkers > 0 &&
        measurement.pool.states.live > 0 &&
        measurement.pool.workersStarted > 0 &&
        measurement.control.claimsIssued > 0 &&
        measurement.control.acceptedActionAttempts > 0 &&
        measurement.control.settlementsCommitted +
              measurement.control.settlementsNoOp > 0;
    });
    for (const probe of routingProbes) {
      try {
        await waitFor(async () =>
          isRoutingMeasurementBaselineReady(await probe.read(probe.query))
        );
      } catch (error) {
        const diagnostics = await probe.read(probe.query);
        throw new Error(
          `server execution measurement baseline (${
            probe.label ?? "client"
          }) did not settle: ${
            JSON.stringify({
              claims: diagnostics.claims.length,
              actions: diagnostics.actions.length,
              snapshotRequired: diagnostics.snapshotRequired,
              truncatedActionRecords: diagnostics.truncatedActionRecords,
              problemActions: routingMeasurementProblemActions(diagnostics),
            })
          }`,
          { cause: error },
        );
      }
      const reset = await probe.read({
        ...probe.query,
        resetCounters: true,
      });
      assert(
        isRoutingMeasurementBaselineReady(reset),
        "routing state changed while resetting the measurement baseline",
      );
    }
  }
  return {
    ...await readMeasurement(label),
    ...(enabled && routingProbes.length > 0
      ? { clientRouting: routingProbes }
      : {}),
  };
}

const delta = (after: number, before: number, label: string): number => {
  assert(after >= before, `${label} counter moved backwards`);
  return after - before;
};

export async function finishServerExecutionMeasurement(
  before: ServerExecutionMeasurement | null,
): Promise<void> {
  if (before === null) return;
  const routingProbes = before.clientRouting ?? [];
  const settledRouting: ExecutionRoutingDiagnostics[] = [];
  for (const probe of routingProbes) {
    let settled: ExecutionRoutingDiagnostics | undefined;
    try {
      await waitFor(async () => {
        const diagnostics = await probe.read(probe.query);
        if (!isRoutingMeasurementResultReady(diagnostics)) return false;
        settled = diagnostics;
        return true;
      });
    } catch (error) {
      const diagnostics = await probe.read(probe.query);
      throw new Error(
        `server execution measurement result (${
          probe.label ?? "client"
        }) did not settle: ${
          JSON.stringify({
            claims: diagnostics.claims.length,
            actions: diagnostics.actions.length,
            snapshotRequired: diagnostics.snapshotRequired,
            truncatedActionRecords: diagnostics.truncatedActionRecords,
            problemActions: routingMeasurementProblemActions(diagnostics),
          })
        }`,
        { cause: error },
      );
    }
    settledRouting.push(settled!);
  }
  const after = await readMeasurement(before.label);
  assertEquals(after.enabled, before.enabled, "execution mode changed mid-run");

  if (!after.enabled) {
    assertEquals(after.pool, null);
    if (before.control !== null && after.control !== null) {
      assertEquals(
        after.control,
        before.control,
        "flag-off workload changed server execution control counters",
      );
    }
    console.log(
      `server execution measurement (${before.label}):`,
      JSON.stringify({
        mode: "off",
        elapsedMs: after.startedAt - before.startedAt,
        pool: null,
      }),
    );
    return;
  }

  assert(before.pool !== null && after.pool !== null);
  assert(before.control !== null && after.control !== null);
  for (const diagnostics of settledRouting) {
    assertEquals(diagnostics.snapshotRequired, false);
  }
  const clients = settledRouting.map((diagnostics, index) => ({
    label: routingProbes[index].label ?? "client",
    claims: diagnostics.claims.length,
    actions: diagnostics.actions.length,
    truncatedActionRecords: diagnostics.truncatedActionRecords,
    upstreamRoutes: diagnostics.branchTotals.upstreamRoutes,
    claimedOverlayRoutes: diagnostics.branchTotals.claimedOverlayRoutes,
    settlements: diagnostics.branchTotals.settlements,
    basisCoveredOverlayDrops: diagnostics.branchTotals.basisCoveredOverlayDrops,
    nonAuthoritativeOverlayDrops:
      diagnostics.branchTotals.nonAuthoritativeOverlayDrops,
    settlementDiagnostics: diagnostics.branchTotals.settlementDiagnostics,
    pendingOverlays: diagnostics.actions.reduce(
      (total, action) => total + action.pendingOverlayCount,
      0,
    ),
    pendingSettlements: diagnostics.actions.reduce(
      (total, action) => total + action.pendingSettlementCount,
      0,
    ),
    problemActions: routingMeasurementProblemActions(diagnostics),
  }));
  const result = {
    mode: "authoritative-server" as const,
    elapsedMs: after.startedAt - before.startedAt,
    pool: {
      before: {
        activeLanes: before.pool.activeLanes,
        activeWorkers: before.pool.activeWorkers,
        activeDemands: before.pool.activeDemands,
        states: before.pool.states,
      },
      after: {
        activeLanes: after.pool.activeLanes,
        activeWorkers: after.pool.activeWorkers,
        activeDemands: after.pool.activeDemands,
        states: after.pool.states,
      },
      demandSnapshots: delta(
        after.pool.demandSnapshots,
        before.pool.demandSnapshots,
        "execution demand snapshots",
      ),
      workerStartAttempts: delta(
        after.pool.workerStartAttempts,
        before.pool.workerStartAttempts,
        "worker start attempts",
      ),
      workerStartAborts: delta(
        after.pool.workerStartAborts,
        before.pool.workerStartAborts,
        "worker start aborts",
      ),
      workersStarted: delta(
        after.pool.workersStarted,
        before.pool.workersStarted,
        "workers started",
      ),
      workersStopped: delta(
        after.pool.workersStopped,
        before.pool.workersStopped,
        "workers stopped",
      ),
    },
    claimsIssued: delta(
      after.control.claimsIssued,
      before.control.claimsIssued,
      "claims issued",
    ),
    // Issuance per context key (C1.9 gate criterion c): user-rank enablement
    // must show `user:<did>` keys here for every measured principal, while
    // space-only runs stay {space: n}.
    claimsIssuedByContextKey: ((): Record<string, number> => {
      const grewByKey: Record<string, number> = {};
      for (
        const [contextKey, count] of Object.entries(
          after.control.claimsIssuedByContextKey,
        )
      ) {
        const grew = count -
          (before.control.claimsIssuedByContextKey[contextKey] ?? 0);
        if (grew > 0) grewByKey[contextKey] = grew;
      }
      return grewByKey;
    })(),
    claimsRevoked: delta(
      after.control.claimsRevoked,
      before.control.claimsRevoked,
      "claims revoked",
    ),
    claimedActionConflicts: delta(
      after.control.claimedActionConflicts,
      before.control.claimedActionConflicts,
      "claimed action conflicts",
    ),
    placement: {
      schedulerRuns: delta(
        after.pool.placement.schedulerRuns,
        before.pool.placement.schedulerRuns,
        "server scheduler runs",
      ),
      shadowActionTransactions: delta(
        after.pool.placement.shadowActionTransactions,
        before.pool.placement.shadowActionTransactions,
        "server shadow action transactions",
      ),
      authoritativeActionTransactions: delta(
        after.pool.placement.authoritativeActionTransactions,
        before.pool.placement.authoritativeActionTransactions,
        "server authoritative action transactions",
      ),
    },
    control: {
      acceptedActionAttempts: delta(
        after.control.acceptedActionAttempts,
        before.control.acceptedActionAttempts,
        "accepted action attempts",
      ),
      settlementsCommitted: delta(
        after.control.settlementsCommitted,
        before.control.settlementsCommitted,
        "committed settlements",
      ),
      settlementsNoOp: delta(
        after.control.settlementsNoOp,
        before.control.settlementsNoOp,
        "no-op settlements",
      ),
      settlementsFailed: delta(
        after.control.settlementsFailed,
        before.control.settlementsFailed,
        "failed settlements",
      ),
      settlementsUnserved: delta(
        after.control.settlementsUnserved,
        before.control.settlementsUnserved,
        "unserved settlements",
      ),
      leaseFenceRejects: delta(
        after.control.leaseFenceRejects,
        before.control.leaseFenceRejects,
        "lease fence rejects",
      ),
      leaseFenceRejectCauses: ((): Record<string, number> => {
        const causes: Record<string, number> = {};
        for (
          const [cause, count] of Object.entries(
            after.control.leaseFenceRejectCauses,
          )
        ) {
          const grew = count -
            (before.control.leaseFenceRejectCauses[cause] ?? 0);
          if (grew > 0) causes[cause] = grew;
        }
        return causes;
      })(),
      actionFirewallRejects: delta(
        after.control.actionFirewallRejects,
        before.control.actionFirewallRejects,
        "action firewall rejects",
      ),
    },
    workerFailures: {
      starts: delta(
        after.pool.workerStartFailures,
        before.pool.workerStartFailures,
        "worker start failures",
      ),
      crashes: delta(
        after.pool.crashes,
        before.pool.crashes,
        "worker crashes",
      ),
    },
    ...(clients.length === 0
      ? {}
      : clients.length === 1
      ? { client: clients[0] }
      : { clients }),
  };

  console.log(
    `server execution measurement (${before.label}):`,
    JSON.stringify(result),
  );

  assert(after.pool.workersStarted > 0, "server execution started no worker");
  assert(after.control.claimsIssued > 0, "server execution issued no claims");
  assert(
    result.placement.authoritativeActionTransactions > 0,
    "measured workload performed no authoritative server transaction",
  );
  assert(
    result.control.acceptedActionAttempts > 0,
    "measured workload accepted no claimed server action attempt",
  );
  assert(
    result.control.settlementsCommitted + result.control.settlementsNoOp > 0,
    "measured workload published no successful server settlement",
  );
  assertEquals(result.control.settlementsFailed, 0);
  // A13 guard contract: lease-fence rejects are hard-zero except the causes
  // named in TOLERATED_LEASE_FENCE_CAUSES, each of which is by-design,
  // counted, and carries its own retirement criterion back to hard-zero.
  assertEquals(
    unexpectedLeaseFenceRejects(result.control.leaseFenceRejectCauses),
    0,
    `unexpected lease fence rejects by cause: ${
      JSON.stringify(result.control.leaseFenceRejectCauses)
    }`,
  );
  assertEquals(result.control.actionFirewallRejects, 0);
  assertEquals(result.workerFailures.starts, 0);
  assertEquals(result.workerFailures.crashes, 0);
  for (const client of clients) {
    assert(client.claimedOverlayRoutes > 0, `${client.label} routed nothing`);
    assert(client.settlements.committed + client.settlements.noOp > 0);
    assert(client.basisCoveredOverlayDrops > 0);
    assertEquals(client.settlements.failed, 0);
    assertEquals(client.nonAuthoritativeOverlayDrops, 0);
    assertEquals(client.pendingOverlays, 0);
    assertEquals(client.pendingSettlements, 0);
  }
}

/** Read one browser runtime's bounded execution-routing state. */
export function browserExecutionRoutingProbe(
  page: Page,
): ExecutionRoutingProbe {
  return async (query) =>
    await page.evaluate(
      async (request: ExecutionRoutingDiagnosticsQuery) => {
        const runtime = (globalThis as typeof globalThis & {
          commonfabric?: {
            rt?: {
              getExecutionRoutingDiagnostics(
                query: ExecutionRoutingDiagnosticsQuery,
              ): Promise<ExecutionRoutingDiagnostics>;
            };
          };
        }).commonfabric?.rt;
        if (runtime === undefined) {
          throw new Error("browser execution routing is unavailable");
        }
        return await runtime.getExecutionRoutingDiagnostics(request);
      },
      { args: [query] },
    );
}
