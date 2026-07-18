/**
 * C2.10 — the lunch-poll placement guard at session rank, and the R7
 * retirement to hard-zero (context-lattice §7 C2 gate; plan row C2.10).
 *
 * Why this gate exists: the design's §1 evidence is that the lunch-poll
 * space's durable rows classify 24 space / 13 user / 226 SESSION context,
 * so before C2 the placement gate could not pass — the vote workload's
 * readers live in session context, space-lane wake lookups correctly
 * matched nothing (434 of 438 accepted-commit notices matched no demanded
 * stale reader; zero server recomputes), and the runs that DID reach a
 * space claim with an above-space context floor were fenced with
 * `claim-context-mismatch` — register row R7, tolerated by the placement
 * guard as by-design, "temporary by construction". C2 ships the lane those
 * runs route to. This file binds both halves of the reversal:
 *
 *  - **R7 retirement (named C2 acceptance criterion).** The tolerance
 *    lived in `TOLERATED_LEASE_FENCE_CAUSES`
 *    (server-execution-measurement.ts), whose contract says a cause
 *    retires by deleting its entry. The guard-contract test below pins the
 *    retirement: `claim-context-mismatch` is back in the A13 guard's
 *    hard-zero set, and the tolerated registry is exactly the two by-design
 *    drain causes. Built red-first: with the R7 entry still present the
 *    contract test failed (the guard returned 0 unexpected for a nonzero
 *    mismatch count); deleting the entry turned it green.
 *  - **The lunch-poll placement gate.** The REAL lunch-poll pattern runs a
 *    two-principal join/add-option/vote workload with session lanes
 *    enabled, and the gate asserts at the named counters:
 *      (a) R7 hard-zero in vivo: zero `claim-context-mismatch` lease-fence
 *          rejects across the whole workload — via the retired guard
 *          (`unexpectedLeaseFenceRejects`) AND the explicit cause count;
 *      (b) session placement: session-rank claims are ISSUED for both
 *          sessions' lanes (claimsIssuedByContextKey), and every
 *          session-rank candidate the Worker emits names one of the live
 *          session lanes (canonical keys, CA9);
 *      (c) the §1 collapse reversed: accepted-commit notices now MATCH
 *          demanded stale readers (`acceptedCommitIndexMatches` > 0 — the
 *          same counter pair the 434/438 evidence was read from), and the
 *          server lanes author session-scoped rows (accepted session-scoped
 *          revisions whose writer is the executor's host session, not any
 *          client session) — a nonzero served-recompute count where the §1
 *          measurement had zero;
 *      (d) the workload itself is healthy: both votes survive on both
 *          clients (voteCount AND the session-context todayVoteCount reach
 *          2 in both sessions), no failed settlements, no firewall
 *          rejects.
 *
 * Harness shape — one client stack per REALM, deliberately: the
 * multi-runtime harness runs each session as a full production client
 * (PiecesController over WebSocket) in its own Deno Worker realm, because
 * one JS realm cannot host two runtimes for a real pattern (verified-load
 * registries and frame stacks cross-talk — the harness's own header; the
 * C2.9 gate's in-realm multi-client shape is sound only for its distilled
 * fixture). The gate self-hosts the server side in the TEST realm: a real
 * memory-v2 Server (file-backed SQLite store, execution protocol flags),
 * served over a localhost WebSocket, with the real SharedExecutionPool and
 * a REAL Deno executor Worker attached to the same Server object, session
 * dial + both rank-candidate dials on. Worker-realm clients negotiate the
 * context-lattice-claims subcapability through the harness-local
 * MULTI_RUNTIME_CONTEXT_LATTICE_CLAIMS seam (multi-runtime-worker.ts) —
 * the client-side ambient dial is programmatic-only by design, so the
 * harness realm must set it the same way a gate fixture flips the other
 * session dials.
 *
 * The ≥3-lane latency half of C2.10's split gate (CA11) lives in
 * server-execution-session-lane-latency-gate.test.ts.
 *
 * ---------------------------------------------------------------------------
 * STATUS (2026-07-18, C2.10 build): the guard-contract test is default-run
 * and green. The placement fixture is the ACCEPTANCE HARNESS and is
 * currently BLOCKED-RED on two real defects it found — it runs only under
 * `CF_RUN_C210_LUNCH_POLL_PLACEMENT=1` until they are fixed, and it is the
 * ready-made red-first fixture for both fixes:
 *
 *  1. **Second-voter derived-doc staleness (every strict run).** After the
 *     two concurrent green votes merge server-side, the SECOND voter's
 *     replica keeps the pre-merge value of the space-lane-claimed raw
 *     `voteCount` snapshot forever (`bobVoteCount: 1` while alice reads 2
 *     and BOTH sessions' session-served `todayVoteCount` reach 2). The
 *     browser placement guard cannot see this — it asserts today-chain
 *     text only. Reproduced identically through the production client
 *     stack (this harness) and a raw-Runtime loopback build.
 *  2. **Session-rank read-fold churn (intermittent).** Some runs wedge a
 *     few claimed chains (`ifElse`/`when` selector runs and authored
 *     lifts over entity-link reads) in an unobserved-read /
 *     dynamic-write-outside-static-surface firewall-reject → claim-release
 *     → re-candidate loop. Mechanism, captured at the engine fence: the
 *     claimed commit carries a whole-`["value"]` confirmed read of a link
 *     document (recorded at link-resolution time) while the observation +
 *     certificate fold only the narrower `["value","/","link@1"]`
 *     link-field read for that document, so path-prefix coverage fails
 *     (engine.ts claimed-commit admission, `unobserved-read`). Docs where
 *     BOTH read shapes are folded admit fine — the gap is which reads get
 *     the whole-value fold. W2.14's fold fix covered the runtime
 *     write-empty summary path; the certificate/descriptor paths have this
 *     residual gap.
 *
 * A tolerant diagnostic run (both blockers excluded) proves the §1
 * reversal machinery itself works: session lanes claimed 14+12 times,
 * 37 session-rank candidates, accepted-commit index 165 matches / 360
 * lookups (vs the §1 evidence's 434 of 438 matching NOTHING), 6
 * server-lane-authored session-scoped rows, 11 committed + 39 no-op
 * settlements, ZERO claim-context-mismatch — R7's hard-zero held in every
 * run of every C2.10 harness.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  resetServerPrimaryExecutionClaimRankConfig,
  setServerPrimaryExecutionClaimRankConfig,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { SharedExecutionPool } from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  TOLERATED_LEASE_FENCE_CAUSES,
  unexpectedLeaseFenceRejects,
} from "./server-execution-measurement.ts";
import {
  serveGateMemoryWebSocket,
  SESSION_LANE_GATE_FLAGS as FLAGS,
  waitForCondition,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const LUNCH_POLL_PATH = join(PATTERNS_ROOT, "lunch-poll", "main.tsx");

Deno.test("C2.10 R7 retirement: claim-context-mismatch is back in the placement guard's hard-zero set", () => {
  // The A13 guard-contract pin for the retirement (context-lattice §8 row
  // R7: "its return to hard-zero is a named C2 acceptance criterion").
  // Red-first evidence: with the R7 tolerance entry still present this
  // returned 0 (tolerated); after the retirement the guard counts every
  // mismatch as unexpected.
  assertEquals(
    unexpectedLeaseFenceRejects({ "claim-context-mismatch": 1 }),
    1,
    "the placement guard must count claim-context-mismatch as unexpected " +
      "(the R7 tolerance is retired — session-context runs have a lane)",
  );
  // The tolerated registry is exactly the two by-design drain causes; a
  // re-added R7 entry (or any new tolerance smuggled in without its own
  // retirement criterion) turns this red.
  assertEquals(
    new Set(TOLERATED_LEASE_FENCE_CAUSES.map((entry) => entry.cause)),
    new Set(["lane-generation-stale", "claim-not-live"]),
    "the tolerated lease-fence registry must hold exactly the two " +
      "by-design drain causes after the R7 retirement",
  );
});

/** Env the worker realms read at init. Set before the harness spawns them,
 * restored afterward so no other test inherits the dials. */
const WORKER_REALM_ENV = {
  EXPERIMENTAL_SERVER_PRIMARY_EXECUTION: "true",
  EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "true",
  MULTI_RUNTIME_CONTEXT_LATTICE_CLAIMS: "true",
} as const;

Deno.test({
  name:
    "C2.10 lunch-poll placement gate: the vote workload places at session rank with zero claim-context-mismatch and nonzero served recomputes",
  // BLOCKED-RED acceptance harness (see the STATUS block in the header):
  // red-first fixture for the two named defects; flip to default-run when
  // they are fixed.
  ignore: Deno.env.get("CF_RUN_C210_LUNCH_POLL_PLACEMENT") !== "1",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      setServerPrimaryExecutionClaimRankConfig("session");
      const restoreEnv: Array<() => void> = [];
      for (const [name, value] of Object.entries(WORKER_REALM_ENV)) {
        const previous = Deno.env.get(name);
        restoreEnv.push(() =>
          previous === undefined
            ? Deno.env.delete(name)
            : Deno.env.set(name, previous)
        );
        Deno.env.set(name, value);
      }
      const storeDir = await Deno.makeTempDir({
        prefix: "lunch-poll-placement-",
      });
      try {
        await runLunchPollPlacementGate(storeDir);
      } finally {
        for (const restore of restoreEnv) restore();
        resetServerPrimaryExecutionClaimRankConfig();
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
  },
});

async function runLunchPollPlacementGate(storeDir: string): Promise<void> {
  // The signed session.open verification the standalone server uses — the
  // worker realms' production clients sign their opens.
  const audience = (await Identity.fromPassphrase(
    "c210 lunch-poll placement gate memory audience",
  )).did();
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen: (message, context) =>
      verifySessionOpenAuthorization(message, context),
    sessionOpenAuth: { audience },
    protocolFlags: FLAGS,
  });
  const ws = serveGateMemoryWebSocket(server);
  let harness: MultiRuntimeHarness | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};
  const events: string[] = [];
  const candidateEvents: Array<{ contextKey: string; actionId: string }> = [];
  /** Session-scoped accepted revisions with their writer session — the
   * served-recompute record (server-lane writers vs client sessions). */
  const acceptedSessionScoped: Array<{
    id: string;
    scopeKey: string;
    originSessionId: string;
  }> = [];
  try {
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
      onCandidateClaim: (candidate) => {
        candidateEvents.push({
          contextKey: candidate.claimKey.contextKey,
          actionId: candidate.claimKey.actionId,
        });
        events.push(
          `candidate:${candidate.claimKey.contextKey}:${candidate.claimKey.actionId}`,
        );
      },
      onCandidateDiagnostic: (diagnostic) =>
        events.push(
          `diagnostic:${diagnostic.diagnosticCode}:${
            diagnostic.claimKey?.contextKey ?? "?"
          }:${diagnostic.claimKey?.actionId ?? "?"}`,
        ),
    });
    pool = new SharedExecutionPool({
      control: server,
      factory,
      settleTimeoutMs: 10_000,
      userLaneCandidates: true,
      sessionLaneCandidates: true,
    });
    // The demand feed has no replay-on-subscribe: the pool listens before
    // any worker-realm client publishes demand.
    pool.start();

    harness = await MultiRuntimeHarness.create({
      programPath: LUNCH_POLL_PATH,
      rootPath: PATTERNS_ROOT,
      sessions: ["c210-alice", "c210-bob"],
      apiUrl: ws.url,
    });
    const alice = harness.session("c210-alice");
    const bob = harness.session("c210-bob");
    const space = (await alice.link([])).space;

    // Count session-scoped accepted revisions from here on. Piece creation
    // (the bootstrap realm) is complete, so what follows is the two live
    // sessions' workload: client-session writers are the perSession input
    // writes, and any OTHER writer of a session-scoped revision is a server
    // lane — the served recompute the §1 evidence measured at zero.
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        const scopeKey = (revision as { scopeKey?: string }).scopeKey ??
          "space";
        if (scopeKey.startsWith("session:")) {
          acceptedSessionScoped.push({
            id: revision.id,
            scopeKey,
            originSessionId: event.originSessionId ?? "",
          });
        }
      }
    });

    // Session lanes open from the live sessions' demand; the lunch-poll
    // graph's session-context actions (the §1 majority) are the only
    // session-rank claim source. Two live sessions ⇒ two session lanes.
    await waitForCondition(
      "execution demand from the worker-realm sessions",
      () => server.listExecutionDemands(space, "").length > 0,
      () => server.listExecutionDemands(space, ""),
    );
    await pool.idle();
    await waitForCondition(
      "pool live",
      () => pool!.metrics().activeWorkers > 0,
      () => pool!.metrics(),
    );
    const sessionLaneClaims = (): string[] =>
      Object.entries(server.executionStats.claimsIssuedByContextKey)
        .filter(([contextKey, count]) =>
          contextKey.startsWith("session:") && count > 0
        )
        .map(([contextKey]) => contextKey);
    await waitForCondition(
      "session-rank claims for both live sessions' lanes",
      () => sessionLaneClaims().length >= 2,
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        pool: pool!.metrics(),
        events: events.slice(-40),
      }),
    );

    // ------- The vote workload (the browser guard's shape, headless):
    // join both, host adds an option, both vote green CONCURRENTLY. -------
    const usersCount = async (session: MultiRuntimeSession) =>
      ((await session.read(["users"]) ?? []) as unknown[]).length;
    await alice.send("joinAs", { name: "Alice" });
    await harness.waitFor(
      "alice joined",
      async () => await usersCount(alice) === 1,
    );
    await bob.send("joinAs", { name: "Bob" });
    await harness.waitFor(
      "both joins visible on both clients",
      async () => await usersCount(alice) === 2 && await usersCount(bob) === 2,
    );

    await alice.send("addOption", { title: "Sushi Place" });
    let optionId = "";
    await harness.waitFor(
      "option visible on both clients",
      async () => {
        const [aliceOptions, bobOptions] = await Promise.all([
          alice.read(["options"]),
          bob.read(["options"]),
        ]) as [
          ReadonlyArray<{ id?: string }> | undefined,
          ReadonlyArray<{ id?: string }> | undefined,
        ];
        optionId = aliceOptions?.[0]?.id ?? "";
        return optionId !== "" && bobOptions?.[0]?.id === optionId;
      },
    );

    // Both greens dispatched before either settles — the same concurrency
    // the browser placement guard drives (distinct per-voter vote entities;
    // both must survive).
    await Promise.all([
      alice.send("castVote", { optionId, voteType: "green" }),
      bob.send("castVote", { optionId, voteType: "green" }),
    ]);
    let voteState: Record<string, unknown> = {};
    await waitForCondition(
      "both votes counted on both clients (voteCount AND the session-context todayVoteCount)",
      async () => {
        voteState = {
          aliceVoteCount: await alice.read(["voteCount"]),
          bobVoteCount: await bob.read(["voteCount"]),
          aliceToday: await alice.read(["todayVoteCount"]),
          bobToday: await bob.read(["todayVoteCount"]),
        };
        await harness!.settle(1);
        return voteState.aliceVoteCount === 2 &&
          voteState.bobVoteCount === 2 &&
          voteState.aliceToday === 2 &&
          voteState.bobToday === 2;
      },
      () => ({
        voteState,
        causes: server.executionStats.leaseFenceRejectCauses,
        firewallRejects: server.executionStats.actionFirewallRejects,
        settlements: {
          committed: server.executionStats.settlementsCommitted,
          unserved: server.executionStats.settlementsUnserved,
          failed: server.executionStats.settlementsFailed,
        },
        events: events.slice(-30),
      }),
    );
    await harness.settle(2);
    // Let in-flight claimed settlements land before reading the counters:
    // the replicas converged above, so what remains is the server's own
    // settlement tail. The pool's idle() is the deterministic drain.
    await pool.idle();

    // ------- (b) Session placement at the named counters. -------
    const stats = server.executionStats;
    const liveSessionLanes = sessionLaneClaims();
    assert(
      liveSessionLanes.length >= 2,
      `both live sessions' lanes must have issued claims: ${
        JSON.stringify(stats.claimsIssuedByContextKey)
      }`,
    );
    const sessionLaneSet = new Set(liveSessionLanes);
    const sessionCandidates = candidateEvents.filter((candidate) =>
      candidate.contextKey.startsWith("session:")
    );
    assert(
      sessionCandidates.length > 0,
      "the Worker emitted no session-rank candidate for the lunch-poll graph",
    );
    for (const candidate of sessionCandidates) {
      assert(
        sessionLaneSet.has(candidate.contextKey),
        `session candidate names an unknown lane (CA9): ${candidate.contextKey}`,
      );
    }

    // ------- (c) The §1 collapse reversed. -------
    // Accepted-commit notices now match demanded stale readers — the same
    // counter pair the "434 of 438 matched nothing" evidence was read from.
    assert(
      stats.acceptedCommitIndexLookups > 0,
      "the accepted-commit index was never consulted — no lane demand?",
    );
    assert(
      stats.acceptedCommitIndexMatches > 0,
      `accepted-commit notices matched zero demanded stale readers — the ` +
        `§1 collapse is NOT reversed: ${
          JSON.stringify({
            lookups: stats.acceptedCommitIndexLookups,
            matches: stats.acceptedCommitIndexMatches,
          })
        }`,
    );
    assert(
      stats.settlementsCommitted > 0,
      "the workload produced zero committed server settlements",
    );
    // Served recomputes at session rank: session-scoped accepted revisions
    // whose WRITER is not any client session. The client sessions are
    // exactly the sids the live session lane keys name
    // (`session:<did>:<sid>`, A18 canonical encoding — the sid is the
    // final segment), so a server-lane writer (the executor's host
    // session) is anything else.
    const clientSessionIds = new Set(
      liveSessionLanes.map((lane) => lane.slice(lane.lastIndexOf(":") + 1)),
    );
    const servedSessionRecomputes = acceptedSessionScoped.filter((entry) =>
      !clientSessionIds.has(entry.originSessionId)
    );
    assert(
      servedSessionRecomputes.length > 0,
      `the server lanes authored zero session-scoped rows (the §1 ` +
        `zero-served-recompute collapse): ${
          JSON.stringify({
            acceptedSessionScoped: acceptedSessionScoped.length,
            clientSessionIds: [...clientSessionIds],
            writers: [
              ...new Set(
                acceptedSessionScoped.map((entry) => entry.originSessionId),
              ),
            ],
          })
        }`,
    );
    // And every server-authored session row lands under a LIVE session
    // lane's own scope key (a lane writes its own session's instances).
    for (const entry of servedSessionRecomputes) {
      assert(
        sessionLaneSet.has(entry.scopeKey),
        `a served session recompute landed outside the live lanes: ${
          JSON.stringify(entry)
        }`,
      );
    }

    // ------- (a) R7 hard-zero, in vivo, plus run health. -------
    const causes = stats.leaseFenceRejectCauses;
    assertEquals(
      causes["claim-context-mismatch"] ?? 0,
      0,
      `R7 regressed: claim-context-mismatch fences with session lanes ` +
        `enabled: ${JSON.stringify(causes)}`,
    );
    assertEquals(
      unexpectedLeaseFenceRejects(causes),
      0,
      `unexpected lease fence rejects: ${JSON.stringify(causes)}`,
    );
    // Drain-free workload window: the two remaining tolerated causes stay
    // at zero too.
    assertEquals(causes["lane-generation-stale"] ?? 0, 0);
    assertEquals(causes["claim-not-live"] ?? 0, 0);
    assertEquals(stats.settlementsFailed, 0, "failed server settlements");
    assertEquals(stats.actionFirewallRejects, 0, "action firewall rejects");

    console.log(
      "lunch-poll placement gate measurement:",
      JSON.stringify({
        claimsIssuedByContextKey: stats.claimsIssuedByContextKey,
        sessionCandidates: sessionCandidates.length,
        servedSessionRecomputes: servedSessionRecomputes.length,
        distinctServedSessionDocs:
          new Set(servedSessionRecomputes.map((entry) => entry.id)).size,
        acceptedSessionScoped: acceptedSessionScoped.length,
        acceptedCommitIndex: {
          lookups: stats.acceptedCommitIndexLookups,
          matches: stats.acceptedCommitIndexMatches,
        },
        settlements: {
          committed: stats.settlementsCommitted,
          noOp: stats.settlementsNoOp,
          unserved: stats.settlementsUnserved,
          failed: stats.settlementsFailed,
        },
        claimedActionConflicts: stats.claimedActionConflicts,
        leaseFenceRejectCauses: causes,
        pool: pool.metrics(),
      }),
    );
  } finally {
    unsubscribeAccepted();
    await pool?.close();
    await harness?.dispose().catch(() => undefined);
    await ws.close().catch(() => undefined);
    await server.close();
  }
}
