/**
 * C1.9 — the two-principal PerUser measurement gate (context-lattice §7 C1
 * gate, closing the C1 milestone).
 *
 * Gate text (context-lattice-execution.md §7): "a PerUser derivation is
 * served for two principals with isolated rows and zero client derived wire
 * writes; flag-off parity holds."
 *
 * This suite self-hosts the full production loop in one process — a real
 * memory-v2 Server (file-backed SQLite store), the real SharedExecutionPool
 * with a real Deno executor Worker, and one real client Runtime per
 * principal over the loopback transport (the executor-claim-e2e.test.ts
 * self-hosting pattern) — because both user-lane dials are deliberately
 * programmatic-only (EXPERIMENTAL_OPTIONS.md): the gate fixture flips
 * `serverPrimaryExecutionClaimRankConfig` to `user` and
 * `serverPrimaryExecutionUserRankCandidates` on together, and nothing else
 * in the deployment can.
 *
 * Amendments carried by this work order:
 *  - A13: the tolerated lane-drain fence causes are defined ONCE in the
 *    measurement harness (TOLERATED_LEASE_FENCE_CAUSES, each named, counted,
 *    with a retirement criterion); this drain-free fixture also asserts the
 *    two drain causes at hard zero, which is exactly their retirement
 *    criterion's shape.
 *  - A18: both principals are real generated `did:key` identities —
 *    colon-bearing — driven end-to-end against the real engine; the SQLite
 *    rows must show the canonical percent-encoded `user:did%3Akey%3A...`
 *    scope keys.
 *  - A25: the gate records per-lane authority activity plus the Worker's
 *    aggregate schedulerRuns so the §4 per-lane shadow-recompute cost is
 *    measured, not discovered. (The executor metrics channel exposes only
 *    aggregate schedulerRuns today; per-lane run counts are derived from
 *    per-scope accepted server commits.)
 *  - A2: a mid-run WRITE revocation fixture — the lane drains and its claims
 *    are revoked before the ACL response releases, and no post-revocation
 *    row lands under the revoked principal's scope.
 *
 * The C1.5b recorded risk (sponsor-lane overlap) is covered inside the main
 * gate: alice's session is deterministically the demand sponsor, so her user
 * lane is a lane registered for the SPONSOR's own principal; the space lane
 * must keep serving space-scoped rows (declared `space` keys unclobbered)
 * while her scoped frames attribute to the user lane instance.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
// Built into the Deno runtime (no fetch, no new dependency): read-only
// row-isolation inspection of the server's closed store file.
// deno-lint-ignore no-external-import
import { DatabaseSync } from "node:sqlite";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionClaimRankConfig,
  setServerPrimaryExecutionClaimRankConfig,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import { Runtime } from "@commonfabric/runner";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { SharedExecutionPool } from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  TOLERATED_LEASE_FENCE_CAUSES,
  unexpectedLeaseFenceRejects,
} from "./server-execution-measurement.ts";
// The blocker fixture pins the executor ROUTER seam itself (the exact seam
// the §4 widening-pair fix must change), which is runner-internal — hence the
// direct src import from this test.
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../../runner/src/executor/action-transaction-router.ts";
import type { CandidateClaim } from "../../runner/src/executor/deno-space-executor.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  // The C1.7 subcapability: context-scoped claim delivery. Every gate session
  // negotiates it, so the principal-wide cohort predicate admits user lanes.
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const FLAGS_OFF = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const FIXTURE_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "user-lane-score",
  "main.tsx",
);
const BARRIER_TIMEOUT_MS = 30_000;

/** Loopback client sessions against the in-process server, authenticated as
 * the storage signer's principal. `supportsExecutionDemand` opts the runner
 * into publishing connection-owned root demand from each client session, so
 * the pool aggregates demand per PRINCIPAL exactly as deployed (C1.8). */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsExecutionDemand = true;

  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onCommit?: (commit: ClientCommit) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
      protocolFlags: this.flags,
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    if (this.onCommit !== undefined) {
      const transact = session.transact.bind(session);
      session.transact = (commit) => {
        this.onCommit!(structuredClone(commit));
        return transact(commit);
      };
    }
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<StorageOptions, "memoryHost" | "spaceHostMap">,
    onCommit?: (commit: ClientCommit) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://user-lane-gate") },
      new LoopbackSessionFactory(server, flags, onCommit),
    );
  }
}

/** Bounded poll over a monotonic condition (server counters, replica
 * convergence). No fixed sleeps: the deadline only bounds the wait, progress
 * is driven by the observed state itself. */
const waitForCondition = async (
  name: string,
  condition: () => boolean | Promise<boolean>,
  detail?: () => unknown,
): Promise<void> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `${name} timed out${
          detail === undefined ? "" : `: ${JSON.stringify(detail())}`
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const awaitBarrier = async <T>(
  barrier: Promise<T>,
  name: string,
  detail?: () => unknown,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${name} timed out${
                  detail === undefined ? "" : `: ${JSON.stringify(detail())}`
                }`,
              ),
            ),
          BARRIER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Deterministic teardown barrier for every test that spawns the real Deno
 * executor Worker (the self-hosted production loop).
 *
 * Without it, terminating the executor Worker races the Deno event loop's
 * own resolution check: after `pool.close()` tears the Worker down, the
 * test's next lone `await` on a just-completing async op (historically the
 * final temp-dir `Deno.remove`) can park exactly as the runtime decides the
 * loop is drained, and the run dies AFTER the suite summary with
 * `error: Promise resolution is still pending but the event loop has already
 * resolved` — the in-flight test is silently missing from the summary count.
 * Measured before the barrier: 2/10 full-file runs failed, 5/10 for the A2
 * revocation leg alone (its ACL churn hits the window hardest). This is a
 * runtime-level race with Worker termination, not a fixture resource leak:
 * a pending no-op timer held across the test keeps the event loop refed
 * through the window, and the same runs pass with zero timer ticks fired
 * (the guarded awaits all resolve in well under the interval). The timer is
 * cleared synchronously at test end, so `--trace-leaks` sanitizers stay
 * green.
 */
const withExecutorTeardownBarrier = async <T>(
  fn: () => Promise<T>,
): Promise<T> => {
  const keepAlive = setInterval(() => {
    // Never expected to fire (tests finish or time out first); the pending
    // timer itself is the barrier.
  }, 60_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
};

type GateClient = {
  identity: Identity;
  did: string;
  laneKey: string;
  storage: LoopbackStorageManager;
  runtime: Runtime;
  commits: ClientCommit[];
};

const openClient = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
  serverPrimary: boolean,
): Promise<GateClient> => {
  const identity = await Identity.generate({ implementation: "noble" });
  const commits: ClientCommit[] = [];
  const storage = LoopbackStorageManager.connectTo(
    server,
    flags,
    { as: identity },
    (commit) => commits.push(commit),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      ...(serverPrimary ? { serverPrimaryExecution: true } : {}),
    },
  });
  return {
    identity,
    did: identity.did(),
    laneKey: userExecutionContextKey(identity.did()),
    storage,
    runtime,
    commits,
  };
};

type FixtureResult = {
  resultId: string;
  boardId: string;
  myScoreId: string;
  doubledId: string;
  boardTotalId: string;
};

/** Compile + run the fixture on `creator`, returning the shared doc ids the
 * assertions address. The result doc is space-scoped; `myScore`/`doubled`
 * resolve per principal into user-scoped instances OF THE SAME ids. */
const seedFixture = async (
  creator: GateClient,
  space: MemorySpace,
): Promise<
  FixtureResult & { resultLink: ReturnType<typeof linkOf> }
> => {
  const program = await creator.runtime.harness.resolve(
    new FileSystemProgramResolver(FIXTURE_PATH, PATTERNS_ROOT),
  );
  const compiled = await creator.runtime.patternManager.compilePattern(
    program,
    { space },
  );
  const tx = creator.runtime.edit();
  const result = creator.runtime.getCell<Record<string, unknown>>(
    space,
    "user-lane-gate-result",
    undefined,
    tx,
  );
  const handle = creator.runtime.run(tx, compiled, {}, result);
  assertEquals((await tx.commit()).error, undefined);
  await handle.pull();
  await creator.runtime.settled();
  await creator.storage.synced();
  const link = (name: string) =>
    handle.key(name).resolveAsCell().getAsNormalizedFullLink();
  return {
    resultId: result.sourceURI,
    resultLink: result.getAsNormalizedFullLink(),
    boardId: link("board").id,
    myScoreId: link("myScore").id,
    doubledId: link("doubled").id,
    boardTotalId: link("boardTotal").id,
  };
};

const linkOf = (cell: { getAsNormalizedFullLink(): unknown }) =>
  cell.getAsNormalizedFullLink();

/** Commits that write DERIVED docs onto the wire — the §7 criterion is that
 * a claimed PerUser action produces ZERO of these from either client. Input
 * writes (user intent) always go upstream and are excluded by id. */
const derivedWireWrites = (
  commits: readonly ClientCommit[],
  derivedIds: readonly string[],
): ClientCommit[] =>
  commits.filter((commit) =>
    commit.operations.some((operation) =>
      derivedIds.includes((operation as { id?: string }).id ?? "")
    )
  );

const scopeRows = (
  databasePath: string,
  id: string,
): Array<{ scope_key: string; seq: number; data: string | null }> => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(
      `SELECT scope_key, seq, data FROM revision WHERE id = ? ORDER BY seq`,
    ).all(id) as Array<{ scope_key: string; seq: number; data: string | null }>;
  } finally {
    database.close();
  }
};

/** Latest `value` stored for (id, scope_key), replayed from the revision
 * rows: `set` ops carry the whole document, `patch` ops add/replace the
 * `/value` pointer. Row data is the engine's `fvj1:`-prefixed JSON. */
const latestScopedValue = (
  rows: ReadonlyArray<{ scope_key: string; seq: number; data: string | null }>,
  scopeKey: string,
): unknown => {
  let value: unknown = undefined;
  for (const row of rows) {
    if (row.scope_key !== scopeKey || row.data === null) continue;
    const raw = row.data.startsWith("fvj1:") ? row.data.slice(5) : row.data;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      parsed !== null && typeof parsed === "object" &&
      "value" in (parsed as Record<string, unknown>)
    ) {
      value = (parsed as { value: unknown }).value;
    } else if (Array.isArray(parsed)) {
      for (const operation of parsed as Array<Record<string, unknown>>) {
        if (
          (operation.op !== "add" && operation.op !== "replace") ||
          typeof operation.path !== "string" ||
          operation.path !== "/value" &&
            !operation.path.startsWith("/value/")
        ) {
          continue;
        }
        if (operation.path === "/value") {
          value = operation.value;
          continue;
        }
        // Apply the nested pointer under /value (add/replace only — enough
        // for this fixture's scalar and object documents).
        const segments = operation.path.slice("/value/".length).split("/");
        if (value === null || typeof value !== "object") value = {};
        let target = value as Record<string, unknown>;
        for (const segment of segments.slice(0, -1)) {
          const next = target[segment];
          if (next === null || typeof next !== "object") {
            target[segment] = {};
          }
          target = target[segment] as Record<string, unknown>;
        }
        target[segments[segments.length - 1]] = operation.value;
      }
    }
  }
  return value;
};

/** The fixture's scalar fields live either as the document root value or as
 * a field of the piece argument document — accept both shapes. */
const scopedScalar = (
  rows: ReadonlyArray<{ scope_key: string; seq: number; data: string | null }>,
  scopeKey: string,
  field: string,
): unknown => {
  const value = latestScopedValue(rows, scopeKey);
  return value !== null && typeof value === "object" &&
      field in (value as Record<string, unknown>)
    ? (value as Record<string, unknown>)[field]
    : value;
};

const setMyScore = async (
  client: GateClient,
  resultLink: unknown,
  value: number,
): Promise<void> => {
  const tx = client.runtime.edit();
  client.runtime
    // deno-lint-ignore no-explicit-any
    .getCellFromLink(resultLink as any)
    .withTx(tx)
    .key("myScore")
    .set(value);
  assertEquals((await tx.commit()).error, undefined);
};

const readCellNumber = async (
  client: GateClient,
  resultLink: unknown,
  key: string,
): Promise<unknown> => {
  // deno-lint-ignore no-explicit-any
  const cell = client.runtime.getCellFromLink(resultLink as any).key(key);
  return await cell.pull();
};

/**
 * BLOCKER history and current state (C1.9/C1.9b, 2026-07-16):
 *
 * FIXED (1) — the §4 widening-pair servability blocker. A real transformed
 * PerUser derivation emits the §4 output-widening WRITE PAIR (broad space
 * instance as a scope-naming redirect link + the VALUE at the acting
 * principal's user scope) while its transformer certificate declares the
 * output envelope ONCE, at the broad space address. The runner seams now
 * admit exactly that pair under a user-rank lane, mirroring the C1.2 engine
 * contract in v2/scope-naming-link.ts: `classifyStaticActionServability`
 * collapses the two instances to the one logical direct output,
 * `dynamicActionTransactionUnservableReason` covers both legs from the
 * certificate's broad direct output (plus the engine's broad-value-write
 * backstop on lane-acting commits), and the executor router presents
 * claimed commits with the lane-widened certificate the engine's
 * scope-sensitive coverage accepts (A7 lockstep). Pinned by "user-lane
 * servability blocker" below (now default-run green) and the §4 unit
 * suites in runner/test/scheduler-servability.test.ts and
 * runner/test/executor-action-router.test.ts.
 *
 * FIXED (2) — the user-lane replica-hydration conflict storm behind it.
 * With the pair admitted, the sponsor's user-rank claim was issued but the
 * claimed run never settled: the Worker's demand pulls register SPACE-lane
 * watches only, so durable user-scoped instance rows predating the lane
 * were absent from the Worker replica; the claimed lane run read defaults,
 * asserted seq-0 reads against durable rows, and every authoritative
 * attempt conflicted (measured: 2,244 claimed conflicts in 30s, zero
 * settlements). The executor router now reports each routed action's
 * lane-instanced document set (`onLaneSurface`), and the Worker syncs
 * exactly those documents under the lane's acting context before its
 * claimed runs (`hydrateExecutionLane`, executor-worker.ts) — the C1.4b
 * lane read seam then delivers and tracks the instance rows. Pinned by the
 * sponsor-lane end-to-end test below: a user-rank claim is issued, the
 * claimed lane run settles, and the derived row lands under the
 * principal's user scope key with the broad instance kept a link.
 *
 * FIXED (3) — NON-sponsor per-lane serving (C1.9c). The Worker's action
 * router now emits one user-rank candidate per OPEN lane whose demand covers
 * the piece (lane-keyed candidates), one live claim PER LANE coexists across
 * disjoint chains (lane-keyed `(action, contextKey)` claim maps), and a
 * per-lane host wake recomputes each claimed PerUser action under its own
 * lane's acting context (`scheduleLaneRerun`, executor-worker.ts). Both
 * principals' lanes open, are claimed at user rank, and land isolated rows
 * under their own `user:<did>` scope keys — the whole two-principal gate is
 * GREEN under the flag (verified: user-rank claims for both principals,
 * zero derived wire writes, per-lane A25 record, sponsor-overlap
 * unclobbered, zero lease-fence rejects).
 *
 * RESOLVED (FW7, 2026-07-17) — the teardown flake that kept this family
 * env-gated (CF_RUN_USER_LANE_GATE, Fable review FB14). The residual
 * "Promise resolution is still pending but the event loop has already
 * resolved" at shutdown was root-caused to a runtime-level race between
 * executor `Worker.terminate()` and the Deno event loop's resolution check
 * (not a fixture leak): the test's final await could park on a
 * just-completing op exactly as the loop declared itself drained. Every
 * Worker-spawning test now runs inside `withExecutorTeardownBarrier` (see
 * its doc comment for the measured failure rates and evidence), and the
 * whole family — including the A2 security fixture — runs and asserts on
 * every automatic integration run, with no env gate.
 */

Deno.test({
  name:
    "C1.9 gate: PerUser derivation served for two principals with isolated rows and zero client derived wire writes",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      setServerPrimaryExecutionClaimRankConfig("user");
      const storeDir = await Deno.makeTempDir({ prefix: "user-lane-gate-" });
      try {
        await runTwoPrincipalGate(storeDir);
      } finally {
        resetServerPrimaryExecutionClaimRankConfig();
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
  },
});

async function runTwoPrincipalGate(storeDir: string): Promise<void> {
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-user-lane-gate" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  let alice: GateClient | null = null;
  let bob: GateClient | null = null;
  let pool: SharedExecutionPool | null = null;
  let fixtureIds: FixtureResult | null = null;
  let unsubscribeAccepted = () => {};
  const events: string[] = [];
  // Per-scope accepted server commits: the A25 per-lane §4 recompute record.
  const acceptedByScope = new Map<string, number>();
  try {
    alice = await openClient(server, FLAGS, true);
    bob = await openClient(server, FLAGS, true);
    const fixture = await seedFixture(alice, space);
    fixtureIds = fixture;
    const derivedIds = [fixture.doubledId, fixture.boardTotalId];

    const barriers = {
      aliceScore: Promise.withResolvers<void>(),
      bobScore: Promise.withResolvers<void>(),
      boardTotal: Promise.withResolvers<void>(),
    };
    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        const scopeKey = (revision as { scopeKey?: string }).scopeKey ??
          "space";
        events.push(`accepted:${revision.id}@${scopeKey}`);
        if (!derivedIds.includes(revision.id)) continue;
        acceptedByScope.set(scopeKey, (acceptedByScope.get(scopeKey) ?? 0) + 1);
        if (revision.id === fixture.doubledId) {
          if (scopeKey === alice!.laneKey) barriers.aliceScore.resolve();
          if (scopeKey === bob!.laneKey) barriers.bobScore.resolve();
        }
        if (revision.id === fixture.boardTotalId && scopeKey === "space") {
          barriers.boardTotal.resolve();
        }
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
      },
      onCandidateClaim: (candidate) =>
        events.push(
          `candidate:${candidate.claimKey.contextKey}:${candidate.claimKey.actionId}`,
        ),
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
    });
    // The demand feed has no replay-on-subscribe: the pool must be listening
    // before the first client publishes demand.
    pool.start();

    // Alice starts (and thereby demands) FIRST, alone, so her session is
    // deterministically the demand SPONSOR — making her user lane the
    // C1.5b sponsor-lane-overlap case.
    const aliceRoot = alice.runtime.getCellFromLink(
      // deno-lint-ignore no-explicit-any
      fixture.resultLink as any,
    );
    assertEquals(await alice.runtime.start(aliceRoot), true);
    await waitForCondition(
      "alice demand",
      () => server.listExecutionDemands(space, "").length > 0,
      () => server.listExecutionDemands(space, ""),
    );
    await pool.idle();
    await waitForCondition(
      "pool live",
      () => pool!.metrics().activeWorkers > 0,
      () => pool!.metrics(),
    );

    // Bob attaches AFTER the sponsor lease exists: resume the shared piece.
    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(fixture.resultLink as any);
    await bobRoot.sync();
    assertEquals(await bob.runtime.start(bobRoot), true);
    await bob.runtime.settled();

    // Gate criterion (c): user-rank claims ISSUED for BOTH principals, under
    // the canonical (percent-encoded, colon-bearing DID — A18) lane keys.
    await waitForCondition(
      "user-rank claims for both principals",
      () => {
        const byKey = server.executionStats.claimsIssuedByContextKey;
        return (byKey[alice!.laneKey] ?? 0) > 0 &&
          (byKey[bob!.laneKey] ?? 0) > 0;
      },
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        lanes: [alice!.laneKey, bob!.laneKey],
        pool: {
          userLanesOpened: pool!.metrics().userLanesOpened,
          activeUserLanes: pool!.metrics().activeUserLanes,
        },
        demands: server.listExecutionDemands(space, ""),
        events: events.slice(-30),
      }),
    );
    assert(
      alice.did.includes(":") && bob.did.includes(":"),
      "gate principals must be real colon-bearing DIDs (A18)",
    );
    assert(
      alice.laneKey.includes("did%3A"),
      `canonical lane key percent-encodes the DID colons: ${alice.laneKey}`,
    );

    // Mark the claimed phase: derived wire writes after this point are the
    // gate's zero-target. (Overlay/settlement counters reset per client.)
    const claimedPhaseStart = {
      alice: alice.commits.length,
      bob: bob.commits.length,
    };
    for (const client of [alice, bob]) {
      client.storage.getExecutionRoutingDiagnostics?.({
        space,
        branch: "",
        resetCounters: true,
      });
    }

    // Drive both principals' PerUser inputs, and the shared space input.
    await setMyScore(alice, fixture.resultLink, 3);
    await setMyScore(bob, fixture.resultLink, 5);
    {
      const tx = alice.runtime.edit();
      alice.runtime
        // deno-lint-ignore no-explicit-any
        .getCellFromLink(fixture.resultLink as any)
        .withTx(tx)
        .key("board")
        .set([2, 4]);
      assertEquals((await tx.commit()).error, undefined);
    }

    await awaitBarrier(
      barriers.aliceScore.promise,
      "alice user-lane settlement",
      () => events.slice(-25),
    );
    await awaitBarrier(
      barriers.bobScore.promise,
      "bob user-lane settlement",
      () => events.slice(-25),
    );
    await awaitBarrier(
      barriers.boardTotal.promise,
      "space-lane settlement (sponsor overlap)",
      () => events.slice(-25),
    );

    // Client convergence: each principal sees exactly their own derivation.
    await waitForCondition(
      "client convergence",
      async () =>
        await readCellNumber(alice!, fixture.resultLink, "doubled") === 6 &&
        await readCellNumber(bob!, fixture.resultLink, "doubled") === 10 &&
        await readCellNumber(alice!, fixture.resultLink, "boardTotal") === 6 &&
        await readCellNumber(bob!, fixture.resultLink, "boardTotal") === 6,
      () => ({ events: events.slice(-10) }),
    );
    await alice.runtime.settled();
    await bob.runtime.settled();
    await alice.storage.synced();
    await bob.storage.synced();

    // Gate criterion (b): ZERO client derived wire writes during the claimed
    // phase, from BOTH principals; the claimed actions route to overlays.
    assertEquals(
      derivedWireWrites(
        alice.commits.slice(claimedPhaseStart.alice),
        derivedIds,
      ),
      [],
      "alice's client wrote a claimed derived doc onto the wire",
    );
    assertEquals(
      derivedWireWrites(bob.commits.slice(claimedPhaseStart.bob), derivedIds),
      [],
      "bob's client wrote a claimed derived doc onto the wire",
    );
    for (const client of [alice, bob]) {
      const diagnostics = client.storage.getExecutionRoutingDiagnostics?.({
        space,
        branch: "",
      });
      assertExists(diagnostics, "client execution routing is unavailable");
      const claimed = diagnostics.actions.filter((action) =>
        action.liveClaim !== undefined
      );
      assert(
        claimed.some((action) =>
          action.liveClaim!.contextKey === client.laneKey
        ),
        `no live user-lane claim routed on ${client.laneKey}: ${
          JSON.stringify(claimed.map((action) => action.liveClaim!.contextKey))
        }`,
      );
      for (const action of claimed) {
        assertEquals(
          action.upstreamRoutes,
          0,
          `claimed action ${action.key.actionId} routed upstream`,
        );
      }
      // The claimed derivation must reach the client THROUGH AN OVERLAY, never
      // the wire (criterion b, above, already pins zero derived wire writes and
      // the loop above pins zero fail-open upstream routes). Two overlay
      // mechanisms satisfy that, and which one wins is a race this in-process
      // harness does not fix: the client either SPECULATES — runs the claimed
      // computation locally into a claimed-overlay version — or PROJECTS the
      // server's authoritative per-lane settlement as an overlay. Steady-state
      // adoption (scheduler facade `adoptRemoteObservations`) clears a claimed
      // action's dirt from the settlement observation before the deferred local
      // dispatch runs, so against this instant loopback server projection
      // usually wins (`settlements.committed`); over a real network the local
      // speculation lands first (`claimedOverlayRoutes`). The gate asserts the
      // claim was honored as an overlay, not which mechanism raced ahead.
      assert(
        diagnostics.branchTotals.claimedOverlayRoutes > 0 ||
          diagnostics.branchTotals.settlements.committed > 0,
        "claimed actions produced neither a client-speculated overlay nor a " +
          "server-settlement projection",
      );
    }

    // Guard contract (A13): every fence cause must be enumerated, and THIS
    // fixture is drain-free — the two by-design lane-drain causes assert at
    // hard zero, which is exactly their registered retirement criterion.
    const causes = server.executionStats.leaseFenceRejectCauses;
    assertEquals(
      unexpectedLeaseFenceRejects(causes),
      0,
      `unexpected lease fence rejects: ${JSON.stringify(causes)}`,
    );
    assertEquals(causes["lane-generation-stale"] ?? 0, 0);
    assertEquals(causes["claim-not-live"] ?? 0, 0);
    assert(
      TOLERATED_LEASE_FENCE_CAUSES.every((entry) =>
        entry.retirement.length > 0
      ),
      "every tolerated fence cause must carry a retirement criterion",
    );

    // A25 record: per-lane server recompute activity + Worker aggregate.
    const metrics = pool.metrics();
    console.log(
      "user-lane gate measurement:",
      JSON.stringify({
        claimsIssuedByContextKey:
          server.executionStats.claimsIssuedByContextKey,
        perLane: Object.fromEntries(
          [...acceptedByScope.entries()].map(([scopeKey, accepted]) => [
            scopeKey,
            { acceptedDerivedCommits: accepted },
          ]),
        ),
        workerAggregate: metrics.executionPlacement,
        userLanes: {
          opened: metrics.userLanesOpened,
          active: metrics.activeUserLanes,
          reanchors: metrics.userLaneReanchors,
        },
        leaseFenceRejectCauses: causes,
      }),
    );
    assert(metrics.userLanesOpened >= 2, "both user lanes must have opened");
    assert(
      (acceptedByScope.get(alice.laneKey) ?? 0) > 0 &&
        (acceptedByScope.get(bob.laneKey) ?? 0) > 0,
      "per-lane recompute record is empty for a lane",
    );
  } finally {
    unsubscribeAccepted();
    await pool?.close();
    await alice?.runtime.dispose().catch(() => undefined);
    await bob?.runtime.dispose().catch(() => undefined);
    await alice?.storage.close().catch(() => undefined);
    await bob?.storage.close().catch(() => undefined);
    await server.close();
  }

  // Gate criterion (a), inspected DURABLY after shutdown: rows of the SAME
  // derived doc id isolated by scope_key `user:<alice>` vs `user:<bob>`; the
  // space lane's rows keep their declared `space` key (sponsor overlap:
  // alice — the demand sponsor — had a user lane open in the same Worker).
  const databasePath = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
  );
  const doubledRows = scopeRows(databasePath, fixtureIds!.doubledId);
  const doubledScopes = new Set(doubledRows.map((row) => row.scope_key));
  assert(
    doubledScopes.has(alice!.laneKey) && doubledScopes.has(bob!.laneKey),
    `doubled rows must exist under both user scope keys: ${
      JSON.stringify([...doubledScopes])
    }`,
  );
  // The user-context lift ALSO writes its broad space instance — but only as
  // the §4 scope-naming self-redirect LINK (identical across lanes by
  // construction, A7), never as a principal's value.
  assertEquals(latestScopedValue(doubledRows, alice!.laneKey), 6);
  assertEquals(latestScopedValue(doubledRows, bob!.laneKey), 10);
  const doubledBroadValue = latestScopedValue(doubledRows, "space");
  assert(
    doubledBroadValue === undefined ||
      (typeof doubledBroadValue === "object" && doubledBroadValue !== null),
    `the broad doubled instance must stay a scope-naming link, got: ${
      JSON.stringify(doubledBroadValue)
    }`,
  );
  const scoreRows = scopeRows(databasePath, fixtureIds!.myScoreId);
  assertEquals(scopedScalar(scoreRows, alice!.laneKey, "myScore"), 3);
  assertEquals(scopedScalar(scoreRows, bob!.laneKey, "myScore"), 5);
  const boardTotalRows = scopeRows(databasePath, fixtureIds!.boardTotalId);
  assert(boardTotalRows.length > 0, "space derivation left no durable row");
  assertEquals(
    new Set(boardTotalRows.map((row) => row.scope_key)),
    new Set(["space"]),
    "the space lane's declared scope keys were clobbered by a user lane",
  );
  assertEquals(latestScopedValue(boardTotalRows, "space"), 6);
}

// ---------------------------------------------------------------------------
// Router-level fixtures: the same seam the Worker uses, in-process and fast.
// ---------------------------------------------------------------------------

type RouterDrive = {
  candidates: CandidateClaim[];
  diagnostics: ExecutorCandidateDiagnostic[];
  did: string;
};

/** Run the fixture on an emulated client whose action transactions flow
 * through the REAL executor router with user-rank candidacy enabled, exactly
 * as the Worker routes them (C1.5a). */
const driveFixtureThroughRouter = async (): Promise<RouterDrive> => {
  const signer = await Identity.generate({ implementation: "noble" });
  const space = signer.did() as MemorySpace;
  const candidates: CandidateClaim[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    userRankCandidates: true,
    lanePrincipal: signer.did(),
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter: (input) => router(input),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  try {
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(FIXTURE_PATH, PATTERNS_ROOT),
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "user-lane-router-result",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, {}, result);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    // Re-run the PerUser derivation with real data so the routed observation
    // is a plain steady-state recompute, not the piece-creation batch.
    const tx2 = runtime.edit();
    handle.withTx(tx2).key("myScore").set(4);
    assertEquals((await tx2.commit()).error, undefined);
    await runtime.settled();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
  return { candidates, diagnostics, did: signer.did() };
};

Deno.test("user-lane control: the fixture's space derivation stays claim-ready through the real executor router", async () => {
  const { candidates } = await driveFixtureThroughRouter();
  // The space leg (boardTotal) must classify claim-ready at space rank with
  // the user dial ON — the C1.5a byte-identical space regression, pinned at
  // the very seam the §4 widening fix will edit.
  assert(
    candidates.some((candidate) =>
      candidate.claimKey.contextKey === "space" &&
      candidate.claimKey.actionId.includes("__cfLift_1")
    ),
    `no space candidate for boardTotal: ${
      JSON.stringify(candidates.map((candidate) => candidate.claimKey))
    }`,
  );
});

Deno.test(
  "user-lane servability blocker: the PerUser derivation's §4 widening pair must classify user-rank claim-ready",
  // GREEN since the C1.9b servability fix (see the file-top note): the run
  // writes the §4 pair — broad scope-naming redirect link + user-scoped
  // value — and the router now admits it under the user-rank lane instead of
  // rejecting `dynamic-write-outside-static-surface` /
  // `malformed-output-surface`. Default-run: this is the primary regression
  // pin for the fix, at the exact seam it changed.
  async () => {
    const { candidates, diagnostics, did } = await driveFixtureThroughRouter();
    const laneKey = userExecutionContextKey(did);
    assertEquals(
      diagnostics.filter((diagnostic) =>
        diagnostic.diagnosticCode === "dynamic-write-outside-static-surface" ||
        diagnostic.diagnosticCode === "malformed-output-surface"
      ),
      [],
      "the §4 widening pair still rejects at the router seam",
    );
    assert(
      candidates.some((candidate) =>
        candidate.claimKey.contextKey === laneKey &&
        candidate.claimKey.actionId.includes("__cfLift_2")
      ),
      `no user-rank candidate for the PerUser derivation: ${
        JSON.stringify({
          candidates: candidates.map((candidate) => candidate.claimKey),
          diagnostics: diagnostics.map((diagnostic) => ({
            code: diagnostic.diagnosticCode,
            actionId: diagnostic.claimKey?.actionId,
          })),
        })
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// C1.9b sponsor-lane end-to-end: the §4 servability fix carried through the
// REAL production loop for the one lane the Worker can serve today (the
// demand sponsor's). A user-rank claim is issued, the claimed lane run
// settles, the derived row lands durably under the principal's user scope
// key, and the broad instance stays a scope-naming link. This is the outcome
// the full two-principal gate above extends to non-sponsor lanes.
// ---------------------------------------------------------------------------

Deno.test("C1.9b sponsor-lane: the PerUser derivation is served end-to-end for the demand sponsor's user lane", () =>
  withExecutorTeardownBarrier(async () => {
    setServerPrimaryExecutionClaimRankConfig("user");
    const storeDir = await Deno.makeTempDir({ prefix: "user-lane-sponsor-" });
    const spaceIdentity = await Identity.generate({ implementation: "noble" });
    const space = spaceIdentity.did() as MemorySpace;
    const server = new Server({
      store: new URL(`file://${storeDir}/`),
      authorizeSessionOpen(message) {
        const value = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof value === "string" ? value : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-user-lane-sponsor" },
      protocolFlags: FLAGS,
      acl: { mode: "off", serviceDids: [space] },
    });
    let alice: GateClient | null = null;
    let pool: SharedExecutionPool | null = null;
    let fixture:
      | (FixtureResult & { resultLink: ReturnType<typeof linkOf> })
      | null = null;
    let unsubscribeAccepted = () => {};
    const events: string[] = [];
    try {
      alice = await openClient(server, FLAGS, true);
      fixture = await seedFixture(alice, space);
      const settled = Promise.withResolvers<void>();
      unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
        for (const revision of event.revisions) {
          const scopeKey = (revision as { scopeKey?: string }).scopeKey ??
            "space";
          events.push(`accepted:${revision.id}@${scopeKey}`);
          if (
            revision.id === fixture!.doubledId && scopeKey === alice!.laneKey
          ) {
            settled.resolve();
          }
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
        },
        onCandidateClaim: (candidate) =>
          events.push(
            `candidate:${candidate.claimKey.contextKey}:${candidate.claimKey.actionId}`,
          ),
        onCandidateDiagnostic: (diagnostic) =>
          events.push(
            `diagnostic:${diagnostic.diagnosticCode}:${
              diagnostic.claimKey?.actionId ?? "?"
            }`,
          ),
      });
      pool = new SharedExecutionPool({
        control: server,
        factory,
        settleTimeoutMs: 10_000,
        userLaneCandidates: true,
      });
      pool.start();
      const root = alice.runtime.getCellFromLink(
        // deno-lint-ignore no-explicit-any
        fixture.resultLink as any,
      );
      assertEquals(await alice.runtime.start(root), true);
      await waitForCondition(
        "sponsor demand",
        () => server.listExecutionDemands(space, "").length > 0,
      );
      await pool.idle();
      await waitForCondition(
        "user-rank claim for the sponsor lane",
        () =>
          (server.executionStats.claimsIssuedByContextKey[alice!.laneKey] ??
            0) >
            0,
        () => ({
          byKey: server.executionStats.claimsIssuedByContextKey,
          laneKey: alice!.laneKey,
          events: events.slice(-25),
        }),
      );

      await setMyScore(alice, fixture.resultLink, 3);
      await awaitBarrier(
        settled.promise,
        "sponsor user-lane settlement",
        () => ({
          events: events.slice(-25),
          stats: server.executionStats,
          pool: pool!.metrics(),
        }),
      );
      await waitForCondition(
        "sponsor client convergence",
        async () =>
          await readCellNumber(alice!, fixture!.resultLink, "doubled") === 6,
        () => ({ events: events.slice(-10) }),
      );
      assertEquals(
        unexpectedLeaseFenceRejects(
          server.executionStats.leaseFenceRejectCauses,
        ),
        0,
        JSON.stringify(server.executionStats.leaseFenceRejectCauses),
      );
    } finally {
      unsubscribeAccepted();
      await pool?.close();
      await alice?.runtime.dispose().catch(() => undefined);
      await alice?.storage.close().catch(() => undefined);
      await server.close();
      resetServerPrimaryExecutionClaimRankConfig();
    }

    try {
      // Durable §4 shape: the value under the sponsor's user scope key, the
      // broad instance a scope-naming link (an object envelope), never a
      // principal's value.
      const databasePath = fromFileUrl(
        resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
      );
      const doubledRows = scopeRows(databasePath, fixture!.doubledId);
      assertEquals(latestScopedValue(doubledRows, alice!.laneKey), 6);
      const broadValue = latestScopedValue(doubledRows, "space");
      assert(
        broadValue === undefined ||
          (typeof broadValue === "object" && broadValue !== null),
        `the broad doubled instance must stay a scope-naming link, got: ${
          JSON.stringify(broadValue)
        }`,
      );
    } finally {
      await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
    }
  }));

// ---------------------------------------------------------------------------
// Flag-off parity (§7 gate criterion e): the same fixture with the execution
// flags off stays green and space-only — no pool, no claims, no authority —
// while the PerUser rows stay isolated per principal (scope resolution is a
// host property, not an execution-authority property).
// ---------------------------------------------------------------------------

Deno.test("C1.9 flag-off parity: two principals converge client-primary with isolated rows and zero execution authority", async () => {
  const storeDir = await Deno.makeTempDir({ prefix: "user-lane-parity-" });
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-user-lane-parity" },
    protocolFlags: FLAGS_OFF,
    acl: { mode: "off", serviceDids: [space] },
  });
  let alice: GateClient | null = null;
  let bob: GateClient | null = null;
  let fixture:
    | (FixtureResult & { resultLink: ReturnType<typeof linkOf> })
    | null = null;
  try {
    alice = await openClient(server, FLAGS_OFF, false);
    bob = await openClient(server, FLAGS_OFF, false);
    fixture = await seedFixture(alice, space);

    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(fixture.resultLink as any);
    await bobRoot.sync();
    assertEquals(await bob.runtime.start(bobRoot), true);
    await bob.runtime.settled();

    await setMyScore(alice, fixture.resultLink, 3);
    await setMyScore(bob, fixture.resultLink, 5);

    await waitForCondition(
      "flag-off client convergence",
      async () =>
        await readCellNumber(alice!, fixture!.resultLink, "doubled") === 6 &&
        await readCellNumber(bob!, fixture!.resultLink, "doubled") === 10,
    );
    // Cross-principal isolation from the CLIENT view: alice's doubled stays
    // hers even after bob's write landed.
    assertEquals(await readCellNumber(alice, fixture.resultLink, "doubled"), 6);
    await alice.runtime.settled();
    await bob.runtime.settled();
    await alice.storage.synced();
    await bob.storage.synced();

    // Space-only: zero execution authority of any kind was minted.
    assertEquals(server.executionStats.claimsIssued, 0);
    assertEquals(server.executionStats.claimsIssuedByContextKey, {});
    assertEquals(server.executionStats.leaseFenceRejects, 0);
    assertEquals(server.listExecutionDemands(space, ""), []);
  } finally {
    await alice?.runtime.dispose().catch(() => undefined);
    await bob?.runtime.dispose().catch(() => undefined);
    await alice?.storage.close().catch(() => undefined);
    await bob?.storage.close().catch(() => undefined);
    await server.close();
  }

  try {
    // Durable isolation holds identically with the flags off: same doc id,
    // one row set per principal's user scope key.
    const databasePath = fromFileUrl(
      resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
    );
    const doubledRows = scopeRows(databasePath, fixture!.doubledId);
    assertEquals(latestScopedValue(doubledRows, alice!.laneKey), 6);
    assertEquals(latestScopedValue(doubledRows, bob!.laneKey), 10);
    const scoreRows = scopeRows(databasePath, fixture!.myScoreId);
    assertEquals(scopedScalar(scoreRows, alice!.laneKey, "myScore"), 3);
    assertEquals(scopedScalar(scoreRows, bob!.laneKey, "myScore"), 5);
  } finally {
    await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// A2 — mid-run WRITE revocation. The lane LIFECYCLE legs run green today
// (lanes open independently of the blocked user-rank claims): revoking
// alice's WRITE mid-run drains her user lane, leaves bob's authority intact,
// and lands no post-revocation row under her scope. The strict
// drain-before-ACL-response ordering is pinned at the server seam by
// v2-execution-lane-lifecycle-test (C1.8); this fixture asserts the
// end-to-end outcome, and the claim-revocation leg upgrades automatically
// once the §4 servability blocker is fixed and user claims exist to revoke.
// ---------------------------------------------------------------------------

Deno.test("A2: revoking alice's WRITE mid-run drains her user lane and lands no post-revocation row under her scope", () =>
  withExecutorTeardownBarrier(async () => {
    // The same heavyweight self-hosted two-principal loop as the gate above.
    // Its ACL-enforce mid-run revocation churn hit the executor-Worker
    // teardown race hardest (5/10 solo runs before the barrier — see
    // `withExecutorTeardownBarrier`); this SECURITY fixture must assert on
    // every automatic run, so the barrier, not an env gate, keeps it
    // deterministic.
    setServerPrimaryExecutionClaimRankConfig("user");
    const storeDir = await Deno.makeTempDir({ prefix: "user-lane-revoke-" });
    const spaceIdentity = await Identity.generate({ implementation: "noble" });
    const space = spaceIdentity.did() as MemorySpace;
    const server = new Server({
      store: new URL(`file://${storeDir}/`),
      authorizeSessionOpen(message) {
        const value = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof value === "string" ? value : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-user-lane-revoke" },
      protocolFlags: FLAGS,
      acl: { mode: "enforce", serviceDids: [space] },
    });
    let owner: MemoryClient.Client | null = null;
    let alice: GateClient | null = null;
    let bob: GateClient | null = null;
    let pool: SharedExecutionPool | null = null;
    let fixture:
      | (FixtureResult & { resultLink: ReturnType<typeof linkOf> })
      | null = null;
    let aclRevocationSeq = 0;
    let aliceLaneKey = "";
    try {
      // ACL genesis by the space identity: alice and bob hold WRITE.
      owner = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: FLAGS,
      });
      const ownerSession = await owner.mount(space, {}, (
        _space,
        _session,
        context,
      ) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: space },
      }));
      alice = await openClient(server, FLAGS, true);
      bob = await openClient(server, FLAGS, true);
      aliceLaneKey = alice.laneKey;
      await ownerSession.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: {
            value: {
              [space]: "OWNER",
              [alice.did]: "WRITE",
              [bob.did]: "WRITE",
            },
          },
        }],
      });

      fixture = await seedFixture(alice, space);
      const factory = new DenoSpaceExecutorFactory({
        server,
        apiUrl: new URL("https://toolshed.example/"),
        patternApiUrl: new URL("https://toolshed.example/"),
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
          serverPrimaryExecutionUserRankCandidates: true,
        },
      });
      pool = new SharedExecutionPool({
        control: server,
        factory,
        settleTimeoutMs: 10_000,
        userLaneCandidates: true,
      });
      pool.start();
      const aliceRoot = alice.runtime.getCellFromLink(
        // deno-lint-ignore no-explicit-any
        fixture.resultLink as any,
      );
      assertEquals(await alice.runtime.start(aliceRoot), true);
      // deno-lint-ignore no-explicit-any
      const bobRoot = bob.runtime.getCellFromLink(fixture.resultLink as any);
      await bobRoot.sync();
      assertEquals(await bob.runtime.start(bobRoot), true);
      await waitForCondition(
        "both user lanes open",
        () => pool!.metrics().activeUserLanes === 2,
        () => pool!.metrics(),
      );
      await setMyScore(alice, fixture.resultLink, 3);
      await setMyScore(bob, fixture.resultLink, 5);
      await waitForCondition(
        "pre-revocation convergence",
        async () =>
          await readCellNumber(alice!, fixture!.resultLink, "doubled") === 6 &&
          await readCellNumber(bob!, fixture!.resultLink, "doubled") === 10,
      );
      await alice.storage.synced();
      await bob.storage.synced();

      // Mid-run revocation: drop alice to READ-less. The C1.8 aclTouched
      // reconciliation fences and revokes her lane before this response
      // resolves; every row committed after aclRevocationSeq must be someone
      // else's.
      const revocation = await ownerSession.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: {
            value: {
              [space]: "OWNER",
              [bob.did]: "WRITE",
            },
          },
        }],
      });
      aclRevocationSeq = revocation.seq;
      await waitForCondition(
        "alice's lane drained",
        () => pool!.metrics().activeUserLanes <= 1,
        () => pool!.metrics(),
      );

      // Alice's client can no longer land writes under her scope.
      const rejectedTx = alice.runtime.edit();
      alice.runtime
        // deno-lint-ignore no-explicit-any
        .getCellFromLink(fixture.resultLink as any)
        .withTx(rejectedTx)
        .key("myScore")
        .set(9);
      const rejected = await rejectedTx.commit();
      assert(
        rejected.error !== undefined,
        "a post-revocation write from alice unexpectedly committed",
      );

      // Bob's authority is untouched: his lane survives and his writes land.
      await setMyScore(bob, fixture.resultLink, 7);
      await waitForCondition(
        "bob still served after the revocation",
        async () =>
          await readCellNumber(bob!, fixture!.resultLink, "doubled") === 14,
      );
      await bob.storage.synced();

      // Guard contract (A13): the drain-induced causes are the ONLY tolerated
      // rejects here; anything else is a defect.
      assertEquals(
        unexpectedLeaseFenceRejects(
          server.executionStats.leaseFenceRejectCauses,
        ),
        0,
        JSON.stringify(server.executionStats.leaseFenceRejectCauses),
      );
    } finally {
      await pool?.close();
      await alice?.runtime.dispose().catch(() => undefined);
      await bob?.runtime.dispose().catch(() => undefined);
      await alice?.storage.close().catch(() => undefined);
      await bob?.storage.close().catch(() => undefined);
      await owner?.close();
      await server.close();
      resetServerPrimaryExecutionClaimRankConfig();
    }

    try {
      // Durable outcome: alice's user-scoped rows all precede the revocation
      // commit; bob's continue past it.
      const databasePath = fromFileUrl(
        resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
      );
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const aliceRowsAfter = database.prepare(
          `SELECT id, seq, commit_seq FROM revision
         WHERE scope_key = ? AND commit_seq > ?`,
        ).all(aliceLaneKey, aclRevocationSeq);
        assertEquals(
          aliceRowsAfter,
          [],
          "a post-revocation row landed under alice's scope",
        );
        const bobRowsAfter = database.prepare(
          `SELECT COUNT(*) AS rows FROM revision
         WHERE scope_key = ? AND commit_seq > ?`,
        ).get(bob!.laneKey, aclRevocationSeq) as { rows: number };
        assert(
          bobRowsAfter.rows > 0,
          "bob's post-revocation writes left no durable rows",
        );
      } finally {
        database.close();
      }
    } finally {
      await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
    }
  }));
