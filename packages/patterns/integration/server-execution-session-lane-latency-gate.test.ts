/**
 * C2.10 — the ≥3-lane settlement latency gate (CA11's split, latency half).
 *
 * Why a separate latency gate: the adversarial panel's CA11 corrected the
 * "reuse W2.9's parity bar" default — a correctness bar alone is
 * structurally blind to the latency regime session lanes create (many
 * concurrent lanes on one space, one shared Worker). C2.10 therefore splits
 * the gate: the parity/placement bar lives in
 * server-execution-lunch-poll-placement-gate.test.ts and THIS file is the
 * latency acceptance. CA11 also demands the SPACE lane's settlement latency
 * specifically (the shared lane must not starve behind session-lane load —
 * the OQ3/default-#3 relief-valve concern), so every measured round times
 * the space lane's own settlement beside the full (all-lane) settlement.
 *
 * What an in-process gate can honestly measure: a loopback harness cannot
 * stand in for the browser-workload ms budget — pretending otherwise would
 * "verify" a budget three orders of magnitude away from the deployment it
 * governs. The split adopted for C2.10:
 *
 *  - HERE (deterministic, default-run): a GENEROUS structural ceiling that
 *    catches structural regressions — lane-serialization storms, claim
 *    churn, a wedged lane — as a relative bound derived from this same
 *    harness's own measured single-lane baseline (multiplier
 *    {@link STRUCTURAL_CEILING_MULTIPLIER}, chosen from measured headroom:
 *    the 2026-07-18 build measured single-lane full-settlement p50 ≈ 15 ms
 *    and 3-lane full-settlement p95 ≈ 36 ms — a ratio ≈ 2.4x — so 10x flags
 *    a structural change, not noise; an absolute floor
 *    {@link STRUCTURAL_CEILING_FLOOR_MS} keeps a very fast baseline from
 *    making the ceiling brittle on slow CI). Both legs' full distributions
 *    are logged for the OQ5 record.
 *  - AT THE LIVE MEASUREMENT (W2.9-style, the F5 protocol's machinery): the
 *    owner ms budget against the browser baseline. PROVISIONAL BUDGET,
 *    owner ratification pending (proposed by the C2.10 build session,
 *    2026-07-18, from docs/history/development/performance/
 *    server-execution-feed-baseline-2026-07-16.md): settlement p50 <=
 *    878 ms (single-lane flag-on baseline avg 764 ms + 15%) and p95 <=
 *    2170 ms (2x the flag-off baseline p95 1085 ms). Logged here as
 *    provenance, deliberately NOT asserted in-process.
 *
 * OQ5 linkage: the fixed >=3-lane floor cannot see the hundreds-of-lanes
 * regime; the recorded numbers (lanes, settlements, p50/p95 per leg) are
 * the INPUT to the Worker-per-lane-group topology decision, and the live
 * measurement owns the scaling series (3/10/30 lanes per CA11).
 *
 * Harness shape: the C2.9 session-lane gate's self-hosted loop, verbatim in
 * structure — real memory-v2 Server (file-backed SQLite), the real
 * SharedExecutionPool with a REAL Deno executor Worker, one client Runtime
 * per session over loopback, session dial + both rank-candidate dials on —
 * with the session-lane-tally fixture (every lattice rank, no map/ifElse
 * chains, so settlement timing is the variable under test, not write-surface
 * coverage). A never-started "driver" client performs the foreign board
 * writes, so both legs measure FOREIGN-caused recompute settlement (§7 (a)'s
 * shape — the C2.9 gate's ~69 ms 3-lane figure is the recorded lower bound)
 * and the lane population is exactly the started sessions.
 *
 * Determinism: fixed round counts, accepted-commit barriers per (doc, scope
 * key) — one poll loop per round records when each lane's settlement count
 * advanced (no fixed sleeps; the deadline only bounds the wait).
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  resetServerPrimaryExecutionClaimRankConfig,
  setServerPrimaryExecutionClaimRankConfig,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { SharedExecutionPool } from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  type GateClient,
  openGateClient,
  percentile,
  SESSION_LANE_GATE_FLAGS as FLAGS,
  setGateField,
  waitForCondition,
  waitForConditionsTimed,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const FIXTURE_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "session-lane-tally",
  "main.tsx",
);

/** Measured rounds per leg. Small and fixed on purpose: the gate is a
 * structural tripwire, not a benchmark; with n=12 the p95 is the max —
 * exactly the conservatism a generous ceiling wants. */
const BASELINE_ROUNDS = 12;
const THREE_LANE_ROUNDS = 12;

/** The structural ceiling: 3-lane full-settlement p95 must stay within
 * MULTIPLIER x the single-lane full-settlement p50 measured by THIS run
 * (never below FLOOR_MS, so a very fast baseline cannot make the ceiling
 * tighter than scheduler jitter on a loaded CI host). See the header for
 * how the multiplier was derived and what is deliberately NOT asserted
 * here (the browser-baseline ms budget). */
const STRUCTURAL_CEILING_MULTIPLIER = 10;
const STRUCTURAL_CEILING_FLOOR_MS = 1_500;

/** The provisional owner budget (NOT asserted in-process — see header). */
const PROVISIONAL_OWNER_BUDGET = {
  status: "provisional, owner ratification pending (proposed 2026-07-18)",
  settlementP50Ms: 878,
  settlementP95Ms: 2170,
  basis: "browser note-create baseline 2026-07-16: flag-on avg 764ms +15%; " +
    "2x flag-off p95 1085ms; evaluated at the live W2.9-style measurement",
} as const;

Deno.test({
  name:
    "C2.10 latency gate: settlement latency with 3 concurrent session lanes stays within the structural ceiling, space lane included",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      setServerPrimaryExecutionClaimRankConfig("session");
      const storeDir = await Deno.makeTempDir({
        prefix: "session-lane-latency-",
      });
      try {
        await runLatencyGate(storeDir);
      } finally {
        resetServerPrimaryExecutionClaimRankConfig();
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
  },
});

async function runLatencyGate(storeDir: string): Promise<void> {
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-lane-latency" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  let aliceS1: GateClient | null = null;
  let aliceS2: GateClient | null = null;
  let bob: GateClient | null = null;
  let driver: GateClient | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};
  const events: string[] = [];
  const acceptedByDocScope = new Map<string, number>();
  const docScopeKey = (id: string, scopeKey: string) => `${id}\0${scopeKey}`;
  const acceptedCount = (id: string, scopeKey: string) =>
    acceptedByDocScope.get(docScopeKey(id, scopeKey)) ?? 0;
  try {
    aliceS1 = await openGateClient(server, FLAGS, true);

    // Seed the fixture (the C2.9 seeding, inlined): compile + run + settle.
    const program = await aliceS1.runtime.harness.resolve(
      new FileSystemProgramResolver(FIXTURE_PATH, PATTERNS_ROOT),
    );
    const compiled = await aliceS1.runtime.patternManager.compilePattern(
      program,
      { space },
    );
    const tx = aliceS1.runtime.edit();
    const result = aliceS1.runtime.getCell<Record<string, unknown>>(
      space,
      "session-lane-latency-result",
      undefined,
      tx,
    );
    const handle = aliceS1.runtime.run(tx, compiled, {}, result);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await aliceS1.runtime.settled();
    await aliceS1.storage.synced();
    const resultLink = result.getAsNormalizedFullLink();
    const link = (name: string) =>
      handle.key(name).resolveAsCell().getAsNormalizedFullLink();
    const boardTotalId = (link("boardTotal") as { id: string }).id;
    const tallyId = (link("tally") as { id: string }).id;

    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        const scopeKey = (revision as { scopeKey?: string }).scopeKey ??
          "space";
        if (revision.id !== boardTotalId && revision.id !== tallyId) continue;
        const key = docScopeKey(revision.id, scopeKey);
        acceptedByDocScope.set(key, (acceptedByDocScope.get(key) ?? 0) + 1);
      }
    });

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
        serverPrimaryExecutionUserRankCandidates: true,
        serverPrimaryExecutionSessionRankCandidates: true,
      },
      onCandidateDiagnostic: (diagnostic) =>
        events.push(
          `diagnostic:${diagnostic.diagnosticCode}:${
            diagnostic.claimKey?.contextKey ?? "?"
          }`,
        ),
    });
    pool = new SharedExecutionPool({
      control: server,
      factory,
      settleTimeoutMs: 10_000,
      userLaneCandidates: true,
      sessionLaneCandidates: true,
    });
    pool.start();

    // The sponsor session starts first, alone (the C1.5b/C2.9 discipline).
    const s1Root = aliceS1.runtime.getCellFromLink(
      // deno-lint-ignore no-explicit-any
      resultLink as any,
    );
    assertEquals(await aliceS1.runtime.start(s1Root), true);
    await waitForCondition(
      "alice-s1 demand",
      () => server.listExecutionDemands(space, "").length > 0,
      () => server.listExecutionDemands(space, ""),
    );
    await pool.idle();
    await waitForCondition(
      "pool live",
      () => pool!.metrics().activeWorkers > 0,
      () => pool!.metrics(),
    );
    const s1Lane = aliceS1.sessionLaneKey();
    await waitForCondition(
      "s1 session-rank claim",
      () => (server.executionStats.claimsIssuedByContextKey[s1Lane] ?? 0) > 0,
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        events: events.slice(-20),
      }),
    );

    // The driver: a client that NEVER starts the piece — no demand, no lane,
    // no local actions; a pure foreign writer of the shared board input.
    driver = await openGateClient(server, FLAGS, true);
    const driverRoot = driver.runtime.getCellFromLink(
      // deno-lint-ignore no-explicit-any
      resultLink as any,
    );
    await driverRoot.sync();

    // Warm the single-lane leg: s1's own inputs settle its tally once, then
    // one un-timed driver round exercises the foreign wake path end to end
    // (template synthesis, lane hydration, first claimed run) before any
    // timed round.
    let boardValue = 0;
    await setGateField(aliceS1, resultLink, "myScore", 3);
    await setGateField(aliceS1, resultLink, "myNote", 10);
    const driveRound = async (
      label: string,
      lanes: ReadonlyMap<string, string>,
    ): Promise<Map<string, number>> => {
      const before = new Map<string, number>();
      for (const [name, scopeKey] of lanes) {
        const id = name === "space" ? boardTotalId : tallyId;
        before.set(name, acceptedCount(id, scopeKey));
      }
      boardValue += 1;
      const conditions = new Map<string, () => boolean>();
      for (const [name, scopeKey] of lanes) {
        const id = name === "space" ? boardTotalId : tallyId;
        conditions.set(
          name,
          () => acceptedCount(id, scopeKey) > before.get(name)!,
        );
      }
      await setGateField(driver!, resultLink, "board", [boardValue]);
      return await waitForConditionsTimed(label, conditions, () => ({
        events: events.slice(-20),
        counts: Object.fromEntries(
          [...lanes.entries()].map(([name, scopeKey]) => [
            name,
            acceptedCount(name === "space" ? boardTotalId : tallyId, scopeKey),
          ]),
        ),
      }));
    };
    const singleLaneSet = new Map([["space", "space"], ["s1", s1Lane]]);
    await driveRound("single-lane warmup", singleLaneSet);

    // ------- Leg A: single-lane baseline (the harness's own reference). ---
    const baselineFull: number[] = [];
    const baselineSpace: number[] = [];
    for (let round = 0; round < BASELINE_ROUNDS; round++) {
      const timed = await driveRound(
        `baseline round ${round}`,
        singleLaneSet,
      );
      baselineFull.push(Math.max(...timed.values()));
      baselineSpace.push(timed.get("space")!);
    }

    // Attach the second and third session lanes (a sibling session of the
    // same principal and a foreign principal — the C2.9 population).
    aliceS2 = await openGateClient(server, FLAGS, true, aliceS1.identity);
    // deno-lint-ignore no-explicit-any
    const s2Root = aliceS2.runtime.getCellFromLink(resultLink as any);
    await s2Root.sync();
    assertEquals(await aliceS2.runtime.start(s2Root), true);
    const s2Lane = aliceS2.sessionLaneKey();
    assert(s2Lane !== s1Lane, "the two alice sessions must be distinct");
    await waitForCondition(
      "s2 session-rank claim",
      () => (server.executionStats.claimsIssuedByContextKey[s2Lane] ?? 0) > 0,
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        events: events.slice(-20),
      }),
    );
    await setGateField(aliceS2, resultLink, "myNote", 20);

    bob = await openGateClient(server, FLAGS, true);
    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(resultLink as any);
    await bobRoot.sync();
    assertEquals(await bob.runtime.start(bobRoot), true);
    const bobLane = bob.sessionLaneKey();
    await waitForCondition(
      "bob session-rank claim",
      () => (server.executionStats.claimsIssuedByContextKey[bobLane] ?? 0) > 0,
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        events: events.slice(-20),
      }),
    );
    await setGateField(bob, resultLink, "myScore", 5);
    await setGateField(bob, resultLink, "myNote", 7);

    const threeLaneSet = new Map([
      ["space", "space"],
      ["s1", s1Lane],
      ["s2", s2Lane],
      ["bob", bobLane],
    ]);
    // Warm the widened population on the foreign path once, un-timed (late
    // lanes settle their first foreign-caused rounds here).
    await driveRound("three-lane warmup", threeLaneSet);
    const metricsAtMeasure = pool.metrics();
    assertEquals(
      metricsAtMeasure.activeSessionLanes,
      3,
      "the measured population must be exactly three live session lanes",
    );

    // ------- Leg B: >=3 concurrent session lanes on one space. -------
    const threeLaneFull: number[] = [];
    const threeLaneSpace: number[] = [];
    const threeLanePerLane = new Map<string, number[]>(
      [...threeLaneSet.keys()].map((name) => [name, []]),
    );
    for (let round = 0; round < THREE_LANE_ROUNDS; round++) {
      const timed = await driveRound(
        `three-lane round ${round}`,
        threeLaneSet,
      );
      threeLaneFull.push(Math.max(...timed.values()));
      threeLaneSpace.push(timed.get("space")!);
      for (const [name, elapsed] of timed) {
        threeLanePerLane.get(name)!.push(elapsed);
      }
    }

    // ------- The structural gate. -------
    const baselineFullP50 = percentile(baselineFull, 0.5);
    const ceiling = Math.max(
      STRUCTURAL_CEILING_MULTIPLIER * baselineFullP50,
      STRUCTURAL_CEILING_FLOOR_MS,
    );
    const measurement = {
      lanes: {
        sessionLanes: 3,
        population: [...threeLaneSet.keys()],
      },
      rounds: {
        baseline: BASELINE_ROUNDS,
        threeLane: THREE_LANE_ROUNDS,
      },
      settlementsPerRound: threeLaneSet.size,
      baselineMs: {
        fullP50: round1(baselineFullP50),
        fullP95: round1(percentile(baselineFull, 0.95)),
        spaceP50: round1(percentile(baselineSpace, 0.5)),
        spaceP95: round1(percentile(baselineSpace, 0.95)),
        samples: baselineFull.map(round1),
      },
      threeLaneMs: {
        fullP50: round1(percentile(threeLaneFull, 0.5)),
        fullP95: round1(percentile(threeLaneFull, 0.95)),
        spaceP50: round1(percentile(threeLaneSpace, 0.5)),
        spaceP95: round1(percentile(threeLaneSpace, 0.95)),
        perLaneP95: Object.fromEntries(
          [...threeLanePerLane.entries()].map(([name, samples]) => [
            name,
            round1(percentile(samples, 0.95)),
          ]),
        ),
        samples: threeLaneFull.map(round1),
      },
      structuralCeiling: {
        multiplier: STRUCTURAL_CEILING_MULTIPLIER,
        floorMs: STRUCTURAL_CEILING_FLOOR_MS,
        ceilingMs: round1(ceiling),
      },
      provisionalOwnerBudget: PROVISIONAL_OWNER_BUDGET,
      claimsIssuedByContextKey: server.executionStats.claimsIssuedByContextKey,
      leaseFenceRejectCauses: server.executionStats.leaseFenceRejectCauses,
    };
    console.log(
      "c210 latency gate measurement:",
      JSON.stringify(measurement),
    );

    assert(
      percentile(threeLaneFull, 0.95) <= ceiling,
      `3-lane full-settlement p95 ${
        round1(percentile(threeLaneFull, 0.95))
      }ms exceeds the structural ceiling ${
        round1(ceiling)
      }ms (${STRUCTURAL_CEILING_MULTIPLIER}x single-lane p50 ${
        round1(baselineFullP50)
      }ms, floor ${STRUCTURAL_CEILING_FLOOR_MS}ms)`,
    );
    // CA11: the SPACE lane's settlement latency specifically — the shared
    // lane must not starve behind three session lanes' load.
    assert(
      percentile(threeLaneSpace, 0.95) <= ceiling,
      `space-lane settlement p95 ${
        round1(percentile(threeLaneSpace, 0.95))
      }ms exceeds the structural ceiling ${round1(ceiling)}ms under ` +
        "session-lane load (CA11's space-lane starvation leg)",
    );
    // Health bar for the measured window: every round settled every lane
    // (the barriers enforce it) with zero unexpected lease-fence rejects —
    // the R7-retired hard-zero set — and zero failed settlements.
    const causes = server.executionStats.leaseFenceRejectCauses;
    assertEquals(
      causes["claim-context-mismatch"] ?? 0,
      0,
      `R7 regressed inside the latency window: ${JSON.stringify(causes)}`,
    );
    assertEquals(server.executionStats.settlementsFailed, 0);
  } finally {
    unsubscribeAccepted();
    await pool?.close();
    for (const client of [aliceS1, aliceS2, bob, driver]) {
      await client?.runtime.dispose().catch(() => undefined);
      await client?.storage.close().catch(() => undefined);
    }
    await server.close();
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
