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
  acceptedActionAttempts: number;
  settlementsCommitted: number;
  settlementsNoOp: number;
  settlementsFailed: number;
  settlementsUnserved: number;
  leaseFenceRejects: number;
  actionFirewallRejects: number;
}>;

export type ServerExecutionMeasurement = Readonly<{
  label: string;
  enabled: boolean;
  startedAt: number;
  pool: PoolCounters | null;
  control: ControlCounters | null;
  clientRouting?: Readonly<{
    query: ExecutionRoutingDiagnosticsQuery;
    read: ExecutionRoutingProbe;
  }>;
}>;

type ExecutionRoutingProbe = (
  query: ExecutionRoutingDiagnosticsQuery,
) => Promise<ExecutionRoutingDiagnostics>;

export type ServerExecutionRoutingMeasurement = Readonly<{
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
    acceptedActionAttempts?: number;
    settlementsCommitted?: number;
    settlementsNoOp?: number;
    settlementsFailed?: number;
    settlementsUnserved?: number;
    leaseFenceRejects?: number;
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
  clientRouting?: ServerExecutionRoutingMeasurement,
): Promise<ServerExecutionMeasurement | null> {
  if (!MEASUREMENT_REQUIRED) return null;
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
    if (clientRouting !== undefined) {
      try {
        await waitFor(async () =>
          isRoutingMeasurementBaselineReady(
            await clientRouting.read(clientRouting.query),
          )
        );
      } catch (error) {
        const diagnostics = await clientRouting.read(clientRouting.query);
        throw new Error(
          `server execution measurement baseline did not settle: ${
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
      const reset = await clientRouting.read({
        ...clientRouting.query,
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
    ...(enabled && clientRouting !== undefined ? { clientRouting } : {}),
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
  let settledClientRouting: ExecutionRoutingDiagnostics | undefined;
  if (before.clientRouting !== undefined) {
    try {
      await waitFor(async () => {
        const diagnostics = await before.clientRouting!.read(
          before.clientRouting!.query,
        );
        if (!isRoutingMeasurementResultReady(diagnostics)) return false;
        settledClientRouting = diagnostics;
        return true;
      });
    } catch (error) {
      const diagnostics = await before.clientRouting.read(
        before.clientRouting.query,
      );
      throw new Error(
        `server execution measurement result did not settle: ${
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
  }
  const [after, clientRouting] = await Promise.all([
    readMeasurement(before.label),
    settledClientRouting === undefined
      ? before.clientRouting?.read(before.clientRouting.query)
      : Promise.resolve(settledClientRouting),
  ]);
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
  if (clientRouting !== undefined) {
    assertEquals(clientRouting.snapshotRequired, false);
    assertEquals(clientRouting.truncatedActionRecords, 0);
  }
  const client = clientRouting === undefined ? undefined : {
    claims: clientRouting.claims.length,
    actions: clientRouting.actions.length,
    truncatedActionRecords: clientRouting.truncatedActionRecords,
    upstreamRoutes: clientRouting.branchTotals.upstreamRoutes,
    claimedOverlayRoutes: clientRouting.branchTotals.claimedOverlayRoutes,
    settlements: clientRouting.branchTotals.settlements,
    basisCoveredOverlayDrops:
      clientRouting.branchTotals.basisCoveredOverlayDrops,
    nonAuthoritativeOverlayDrops:
      clientRouting.branchTotals.nonAuthoritativeOverlayDrops,
    settlementDiagnostics: clientRouting.branchTotals.settlementDiagnostics,
    pendingOverlays: clientRouting.actions.reduce(
      (total, action) => total + action.pendingOverlayCount,
      0,
    ),
    pendingSettlements: clientRouting.actions.reduce(
      (total, action) => total + action.pendingSettlementCount,
      0,
    ),
    problemActions: routingMeasurementProblemActions(clientRouting),
  };
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
    ...(client === undefined ? {} : { client }),
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
  assertEquals(result.control.leaseFenceRejects, 0);
  assertEquals(result.control.actionFirewallRejects, 0);
  assertEquals(result.workerFailures.starts, 0);
  assertEquals(result.workerFailures.crashes, 0);
  if (client !== undefined) {
    assert(client.claimedOverlayRoutes > 0);
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
