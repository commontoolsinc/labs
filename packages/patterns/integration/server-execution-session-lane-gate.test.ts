/**
 * C2.9 — the PerSession measurement gate (context-lattice §7 C2 gate,
 * binding the session-lane milestone the way C1.9 bound user lanes).
 *
 * Gate text (context-lattice-execution.md §7, C2): "a PerSession derivation
 * settles under its own session's lane grant regardless of which principal's
 * commit caused the recompute; a foreign session's client never matches the
 * claim and its state is never readable from the lane". The lunch-poll
 * placement guard and the ≥3-lane latency budget are C2.10's split gate —
 * deliberately NOT asserted here (R7 fence-cause counts and a rough
 * settlement latency are logged in passing as C2.10 inputs).
 *
 * This suite self-hosts the full production loop in one process — a real
 * memory-v2 Server (file-backed SQLite store), the real SharedExecutionPool
 * with a REAL Deno executor Worker serving space + user + THREE session
 * lanes, and one real client Runtime per session over the loopback
 * transport — because the session dials are deliberately programmatic-only
 * (EXPERIMENTAL_OPTIONS.md): the gate fixture flips
 * `serverPrimaryExecutionClaimRankConfig` to `session` and both rank
 * candidate dials on together, and nothing else in the deployment can.
 *
 * What this file binds, clause by clause:
 *  - §7 (a): bob's SPACE commit (the shared `board` input) invalidates
 *    alice-s1's session-scoped `tally`; the recompute is claimed at
 *    session rank and settles as an accepted server commit under
 *    `session:<alice>:<s1>` — the foreign-caused recompute running under
 *    the LANE's own grant (design §3: causal origin is irrelevant to lane
 *    authority).
 *  - §7 (b), claim plane: s2 and bob never even RECEIVE s1's claim (C2.6
 *    delivery narrowing asserted at the wire tap), and every claim stored
 *    on their replicas names their OWN chain (client chain-scoped
 *    acceptance, §2) — zero foreign-lane claimed overlays by construction.
 *  - §7 (b), state plane: s1's session-scoped rows are never readable
 *    through s2's or bob's replicas (client convergence sees only their own
 *    instances) and the closed store shows the same doc id isolated per
 *    session scope key — C1.9's isolated-rows discipline at session rank.
 *  - §4 cost note / A25: per-lane recompute activity (accepted server
 *    commits per scope key — the C1.9 mechanism, which is rank-generic) is
 *    recorded next to the Worker's aggregate schedulerRuns, so the
 *    session-lane shadow-recompute cost is measured, not discovered.
 *  - C2.7's owed real-Worker session e2e: the Worker actually opens,
 *    hydrates, and serves session lanes (C2.7 landed the mechanism against
 *    a scripted FakeWorker wire; this is the first REAL `executor-worker.ts`
 *    run at session rank). That includes the template-rank guard C2.7 fixed
 *    without a discriminating test (`emitTemplateCandidatesForLane`): s2's
 *    and bob's lanes open AFTER both a user-rank template (`doubled`) and a
 *    session-rank template (`tally`) were recorded, so late-lane synthesis
 *    runs with cross-rank bait present — the sweep asserts no candidate
 *    ever pairs a user-rank action with a session lane (or vice versa).
 *    Verified discriminating by mutation: disabling the Worker's rank guard
 *    reds the gate (see the sweep's comment for the observed failure shape).
 *  - CA3 (review blocker 3, the owed C2.9 leg): `tally` reads the PerUser
 *    `myScore` under a live session grant; the settled values (19/29/…)
 *    include the real user instance, so a broader-in-chain phantom default
 *    (or its claimed-commit conflict storm) fails the value assertions.
 *  - CA5, gate half: the wire tap on s2's and bob's transports shows ZERO
 *    frames carrying s1's session scope key after the server lane authors
 *    s1's session-scoped rows — the push-side confidentiality of
 *    server-lane-authored session writes at the client boundary. The
 *    zero-touch-WORK half (F6 counters against a real server-session-lane
 *    write source) binds tighter at memory level:
 *    packages/memory/test/v2-feed-cohort-test.ts, "F6 CA5" fixture.
 *
 * Determinism: barrier-driven (accepted-commit barriers per (doc, scope
 * key), monotonic server counters), no fixed sleeps; every Worker-spawning
 * test runs inside the FW7 `withExecutorTeardownBarrier`.
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
  decodeMemoryBoundary,
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionClaimRankConfig,
  sessionExecutionContextKey,
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
// The router fixtures pin the executor ROUTER seam itself (the CA9 rank
// filter and the session-rank classification), which is runner-internal —
// hence the direct src import, exactly as C1.9 pins its seam.
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
  // negotiates it, so session lanes may open (C2.3's own-session admission)
  // and the principal-wide cohort predicate admits user lanes.
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
  "session-lane-tally",
  "main.tsx",
);
const BARRIER_TIMEOUT_MS = 30_000;

/** Everything a wire frame may say about an instance's identity: the values
 * of every `scopeKey` (resolved instance keys on upserts/removes/entities)
 * and every claim-shaped `contextKey` in a decoded server→client message.
 * Collected recursively so new message shapes cannot dodge the sweep. */
const collectWireScopeAndContextKeys = (
  value: unknown,
  into: string[],
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectWireScopeAndContextKeys(entry, into);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "scopeKey" || key === "contextKey") &&
      typeof entry === "string"
    ) {
      into.push(entry);
    }
    collectWireScopeAndContextKeys(entry, into);
  }
};

/** Loopback client sessions against the in-process server, authenticated as
 * the storage signer's principal. `supportsExecutionDemand` opts the runner
 * into publishing connection-owned root demand from each client session, so
 * the pool derives per-SESSION lane demand exactly as deployed (C2.7).
 * The factory also records the mounted session's id (the gate needs each
 * client's canonical `session:<did>:<sid>` lane key) and taps every
 * server→client wire message for the §7 (b) / CA5 confidentiality sweeps. */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsExecutionDemand = true;

  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onCommit?: (commit: ClientCommit) => void,
    private readonly onSessionId?: (sessionId: string) => void,
    private readonly onServerMessage?: (message: unknown) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const inner = MemoryClient.loopback(this.server);
    const tap = this.onServerMessage;
    const transport: typeof inner = tap === undefined ? inner : {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (next: (payload: string) => void) => {
        inner.setReceiver((payload) => {
          try {
            tap(decodeMemoryBoundary(payload));
          } catch {
            // A payload the boundary cannot decode is the client's problem,
            // not the sweep's; never let the tap break delivery.
          }
          next(payload);
        });
      },
      setCloseReceiver: (next: () => void) => inner.setCloseReceiver?.(next),
    };
    const client = await MemoryClient.connect({
      transport,
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
    this.onSessionId?.(
      (session as unknown as { sessionId: string }).sessionId,
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
    onSessionId?: (sessionId: string) => void,
    onServerMessage?: (message: unknown) => void,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://session-lane-gate") },
      new LoopbackSessionFactory(
        server,
        flags,
        onCommit,
        onSessionId,
        onServerMessage,
      ),
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

/**
 * Deterministic teardown barrier for every test that spawns the real Deno
 * executor Worker — the FW7 discipline, verbatim from C1.9 (see the long
 * evidence comment in server-execution-user-lane-gate.test.ts): terminating
 * the executor Worker races the Deno event loop's own resolution check, and
 * a pending no-op timer held across the test keeps the loop refed through
 * the window. Cleared synchronously at test end, so `--trace-leaks`
 * sanitizers stay green.
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
  userLaneKey: string;
  storage: LoopbackStorageManager;
  runtime: Runtime;
  commits: ClientCommit[];
  /** Every scopeKey/contextKey string any server→client message carried. */
  wireKeys: string[];
  /** Set once the space session mounts (first sync/start). */
  sessionId: () => string;
  sessionLaneKey: () => string;
};

const openClient = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
  serverPrimary: boolean,
  identity?: Identity,
): Promise<GateClient> => {
  const clientIdentity = identity ??
    await Identity.generate({ implementation: "noble" });
  const commits: ClientCommit[] = [];
  const wireKeys: string[] = [];
  let mountedSessionId: string | undefined;
  const storage = LoopbackStorageManager.connectTo(
    server,
    flags,
    { as: clientIdentity },
    (commit) => commits.push(commit),
    (sessionId) => {
      mountedSessionId = sessionId;
    },
    (message) => collectWireScopeAndContextKeys(message, wireKeys),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      ...(serverPrimary ? { serverPrimaryExecution: true } : {}),
    },
  });
  const sessionId = () => {
    assertExists(mountedSessionId, "the gate client never mounted a session");
    return mountedSessionId;
  };
  return {
    identity: clientIdentity,
    did: clientIdentity.did(),
    userLaneKey: userExecutionContextKey(clientIdentity.did()),
    storage,
    runtime,
    commits,
    wireKeys,
    sessionId,
    sessionLaneKey: () =>
      sessionExecutionContextKey(clientIdentity.did(), sessionId()),
  };
};

/** The §2 own-chain acceptance set, as concrete key strings: everything a
 * client may legitimately see an instance or claim attributed to. */
const ownChainKeys = (client: GateClient): Set<string> =>
  new Set(["space", client.userLaneKey, client.sessionLaneKey()]);

/** Wire keys OUTSIDE the client's own chain. §7 (b) and CA5 demand this is
 * empty: no frame delivered to a session may name another session's (or
 * another principal's) resolved instance or claim. */
const foreignWireKeys = (client: GateClient): string[] => {
  const allowed = ownChainKeys(client);
  return client.wireKeys.filter((key) =>
    (key.startsWith("user:") || key.startsWith("session:")) &&
    !allowed.has(key)
  );
};

type FixtureResult = {
  resultId: string;
  boardId: string;
  myScoreId: string;
  myNoteId: string;
  doubledId: string;
  boardTotalId: string;
  tallyId: string;
};

/** Compile + run the fixture on `creator`, returning the shared doc ids the
 * assertions address. The result doc is space-scoped; `myNote`/`tally`
 * resolve per SESSION into session-scoped instances OF THE SAME ids, and
 * `myScore`/`doubled` per principal into user-scoped instances. */
const seedFixture = async (
  creator: GateClient,
  space: MemorySpace,
): Promise<FixtureResult & { resultLink: unknown }> => {
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
    "session-lane-gate-result",
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
    myNoteId: link("myNote").id,
    doubledId: link("doubled").id,
    boardTotalId: link("boardTotal").id,
    tallyId: link("tally").id,
  };
};

/** Commits that write DERIVED docs onto the wire — §7's criterion is that a
 * claimed action produces ZERO of these from any client during its claimed
 * phase. Input writes (user intent) always go upstream and are excluded by
 * id. */
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
 * `/value` pointer. Row data is the engine's `fvj1:`-prefixed JSON.
 * (Verbatim from C1.9 — the durable-row discipline is shared.) */
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

const setField = async (
  client: GateClient,
  resultLink: unknown,
  field: string,
  value: unknown,
): Promise<void> => {
  const tx = client.runtime.edit();
  client.runtime
    // deno-lint-ignore no-explicit-any
    .getCellFromLink(resultLink as any)
    .withTx(tx)
    .key(field)
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

Deno.test({
  name:
    "C2.9 gate: PerSession derivation settles under its own session's lane grant on a foreign-caused recompute, with foreign sessions blind to claim and state",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      setServerPrimaryExecutionClaimRankConfig("session");
      const storeDir = await Deno.makeTempDir({ prefix: "session-lane-gate-" });
      try {
        await runSessionLaneGate(storeDir);
      } finally {
        resetServerPrimaryExecutionClaimRankConfig();
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
  },
});

async function runSessionLaneGate(storeDir: string): Promise<void> {
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-lane-gate" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  let aliceS1: GateClient | null = null;
  let aliceS2: GateClient | null = null;
  let bob: GateClient | null = null;
  let pool: SharedExecutionPool | null = null;
  let fixtureIds: FixtureResult | null = null;
  let unsubscribeAccepted = () => {};
  const events: string[] = [];
  /** Every candidate the Worker emitted, as (lane contextKey, actionId) —
   * the template-rank guard sweep's evidence. */
  const candidateEvents: Array<{ contextKey: string; actionId: string }> = [];
  // Per-scope accepted server commits for the derived docs: the A25/§4
  // per-lane recompute record (the C1.9 mechanism — rank-generic, since the
  // engine stamps every claimed lane commit's resolved scope key).
  const acceptedByScope = new Map<string, number>();
  const acceptedByDocScope = new Map<string, number>();
  const docScopeKey = (id: string, scopeKey: string) => `${id}\0${scopeKey}`;
  const acceptedCount = (id: string, scopeKey: string) =>
    acceptedByDocScope.get(docScopeKey(id, scopeKey)) ?? 0;
  let laneKeys: {
    s1: string;
    s2: string;
    bobSession: string;
  } | null = null;
  // C2.10 inputs, recorded in passing (NOT gated here): the R7
  // claim-context-mismatch count and a rough foreign-caused settlement
  // latency with three session lanes live on one Worker.
  let foreignRecomputeLatencyMs = -1;
  try {
    aliceS1 = await openClient(server, FLAGS, true);
    const fixture = await seedFixture(aliceS1, space);
    fixtureIds = fixture;
    const derivedIds = [
      fixture.doubledId,
      fixture.boardTotalId,
      fixture.tallyId,
    ];

    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        const scopeKey = (revision as { scopeKey?: string }).scopeKey ??
          "space";
        events.push(`accepted:${revision.id}@${scopeKey}`);
        if (!derivedIds.includes(revision.id)) continue;
        acceptedByScope.set(scopeKey, (acceptedByScope.get(scopeKey) ?? 0) + 1);
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
    // The demand feed has no replay-on-subscribe: the pool must be listening
    // before the first client publishes demand.
    pool.start();

    // alice-s1 starts (and thereby demands) FIRST, alone, so her session is
    // deterministically the demand SPONSOR: her session lane, her user lane,
    // and the space lane all live in the sponsor's Worker (the C1.5b overlap
    // discipline extended to session rank).
    const s1Root = aliceS1.runtime.getCellFromLink(
      // deno-lint-ignore no-explicit-any
      fixture.resultLink as any,
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
    assert(
      aliceS1.did.includes(":") && s1Lane.includes("did%3A"),
      `canonical session lane keys percent-encode the DID colons (A18/CA12): ${s1Lane}`,
    );

    // Session-rank AND user-rank claims for the sponsor session, under the
    // canonical keys. (The session stage is a ladder: user rank stays
    // claimable — the `doubled` leg — while `tally` claims at session rank.)
    await waitForCondition(
      "s1 session-rank and user-rank claims",
      () => {
        const byKey = server.executionStats.claimsIssuedByContextKey;
        return (byKey[s1Lane] ?? 0) > 0 &&
          (byKey[aliceS1!.userLaneKey] ?? 0) > 0;
      },
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        lanes: [s1Lane, aliceS1!.userLaneKey],
        pool: pool!.metrics(),
        events: events.slice(-30),
      }),
    );

    // Claimed phase for s1: derived wire writes after this point are the
    // gate's zero-target for this client.
    const s1ClaimedPhaseStart = aliceS1.commits.length;
    aliceS1.storage.getExecutionRoutingDiagnostics?.({
      space,
      branch: "",
      resetCounters: true,
    });

    // Drive s1's inputs: the PerUser score, the PerSession note, the shared
    // space board. tally(s1) = (2+4) + 3 + 10 = 19 — the 3 is the CA3 leg
    // (the session lane's run must read alice's REAL user instance).
    await setField(aliceS1, fixture.resultLink, "myScore", 3);
    await setField(aliceS1, fixture.resultLink, "myNote", 10);
    await setField(aliceS1, fixture.resultLink, "board", [2, 4]);
    await waitForCondition(
      "s1 lane settlements (tally under s1, doubled under user:alice, boardTotal under space)",
      () =>
        acceptedCount(fixture.tallyId, s1Lane) > 0 &&
        acceptedCount(fixture.doubledId, aliceS1!.userLaneKey) > 0 &&
        acceptedCount(fixture.boardTotalId, "space") > 0,
      () => ({ events: events.slice(-30) }),
    );

    // s2 — a SECOND session of the SAME principal — attaches AFTER both a
    // session-rank template (tally) and a user-rank template (doubled) were
    // recorded by s1's runs: its session lane is a genuinely LATE lane, so
    // its first candidate must come from the Worker's late-lane template
    // synthesis (`emitTemplateCandidatesForLane`) with cross-rank bait
    // present — the C2.7 template-rank guard leg. No s2 input is written
    // until its claim exists, so nothing else can emit the candidate.
    aliceS2 = await openClient(server, FLAGS, true, aliceS1.identity);
    // deno-lint-ignore no-explicit-any
    const s2Root = aliceS2.runtime.getCellFromLink(fixture.resultLink as any);
    await s2Root.sync();
    assertEquals(await aliceS2.runtime.start(s2Root), true);
    const s2Lane = aliceS2.sessionLaneKey();
    assert(s2Lane !== s1Lane, "the two alice sessions must be distinct");
    await waitForCondition(
      "s2 session-rank claim from the late-lane template",
      () => (server.executionStats.claimsIssuedByContextKey[s2Lane] ?? 0) > 0,
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        s2Lane,
        pool: pool!.metrics(),
        events: events.slice(-30),
      }),
    );
    const s2ClaimedPhaseStart = aliceS2.commits.length;
    await setField(aliceS2, fixture.resultLink, "myNote", 20);
    await waitForCondition(
      "s2 lane settlement (tally under s2)",
      () => acceptedCount(fixture.tallyId, s2Lane) > 0,
      () => ({ events: events.slice(-30) }),
    );

    // bob — a FOREIGN principal — attaches last: his user and session lanes
    // are late lanes too (both template ranks synthesize onto them).
    bob = await openClient(server, FLAGS, true);
    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(fixture.resultLink as any);
    await bobRoot.sync();
    assertEquals(await bob.runtime.start(bobRoot), true);
    const bobLane = bob.sessionLaneKey();
    await waitForCondition(
      "bob session-rank and user-rank claims",
      () => {
        const byKey = server.executionStats.claimsIssuedByContextKey;
        return (byKey[bobLane] ?? 0) > 0 && (byKey[bob!.userLaneKey] ?? 0) > 0;
      },
      () => ({
        byKey: server.executionStats.claimsIssuedByContextKey,
        lanes: [bobLane, bob!.userLaneKey],
        events: events.slice(-30),
      }),
    );
    const bobClaimedPhaseStart = bob.commits.length;
    await setField(bob, fixture.resultLink, "myScore", 5);
    await setField(bob, fixture.resultLink, "myNote", 7);
    await waitForCondition(
      "bob lane settlements (tally under bob's session, doubled under user:bob)",
      () =>
        acceptedCount(fixture.tallyId, bobLane) > 0 &&
        acceptedCount(fixture.doubledId, bob!.userLaneKey) > 0,
      () => ({ events: events.slice(-30) }),
    );
    laneKeys = { s1: s1Lane, s2: s2Lane, bobSession: bobLane };

    // ------- §7 (a): the foreign-caused recompute. -------
    // BOB commits the shared SPACE input; that invalidates every session's
    // tally instance. Each recompute must be claimed at session rank and
    // settle under ITS OWN session's lane grant — s1's under s1's, though
    // alice never touched anything.
    const before = {
      s1: acceptedCount(fixture.tallyId, s1Lane),
      s2: acceptedCount(fixture.tallyId, s2Lane),
      bobSession: acceptedCount(fixture.tallyId, bobLane),
      boardTotal: acceptedCount(fixture.boardTotalId, "space"),
    };
    const foreignWriteStarted = performance.now();
    await setField(bob, fixture.resultLink, "board", [2, 4, 1]);
    await waitForCondition(
      "foreign-caused recomputes settle under every session's own lane",
      () =>
        acceptedCount(fixture.tallyId, s1Lane) > before.s1 &&
        acceptedCount(fixture.tallyId, s2Lane) > before.s2 &&
        acceptedCount(fixture.tallyId, bobLane) > before.bobSession &&
        acceptedCount(fixture.boardTotalId, "space") > before.boardTotal,
      () => ({
        before,
        counts: {
          s1: acceptedCount(fixture.tallyId, s1Lane),
          s2: acceptedCount(fixture.tallyId, s2Lane),
          bobSession: acceptedCount(fixture.tallyId, bobLane),
        },
        events: events.slice(-30),
      }),
    );
    foreignRecomputeLatencyMs = performance.now() - foreignWriteStarted;

    // Client convergence: each session sees exactly its own tally; both
    // alice sessions share ONE user-scoped doubled. The values bind CA3:
    // every tally includes the principal's REAL user-scoped myScore.
    await waitForCondition(
      "client convergence",
      async () =>
        await readCellNumber(aliceS1!, fixture.resultLink, "tally") === 20 &&
        await readCellNumber(aliceS2!, fixture.resultLink, "tally") === 30 &&
        await readCellNumber(bob!, fixture.resultLink, "tally") === 19 &&
        await readCellNumber(aliceS1!, fixture.resultLink, "doubled") === 6 &&
        await readCellNumber(aliceS2!, fixture.resultLink, "doubled") === 6 &&
        await readCellNumber(bob!, fixture.resultLink, "doubled") === 10 &&
        await readCellNumber(aliceS1!, fixture.resultLink, "boardTotal") === 7,
      () => ({
        events: events.slice(-10),
      }),
    );
    for (const client of [aliceS1, aliceS2, bob]) {
      await client.runtime.settled();
      await client.storage.synced();
    }

    // ------- §7 (b), claim plane + zero derived wire writes. -------
    assertEquals(
      derivedWireWrites(
        aliceS1.commits.slice(s1ClaimedPhaseStart),
        derivedIds,
      ),
      [],
      "s1's client wrote a claimed derived doc onto the wire",
    );
    assertEquals(
      derivedWireWrites(
        aliceS2.commits.slice(s2ClaimedPhaseStart),
        derivedIds,
      ),
      [],
      "s2's client wrote a claimed derived doc onto the wire",
    );
    assertEquals(
      derivedWireWrites(bob.commits.slice(bobClaimedPhaseStart), derivedIds),
      [],
      "bob's client wrote a claimed derived doc onto the wire",
    );
    const gateClients: Array<[string, GateClient, string]> = [
      ["s1", aliceS1, s1Lane],
      ["s2", aliceS2, s2Lane],
      ["bob", bob, bobLane],
    ];
    for (const [name, client, sessionLane] of gateClients) {
      const diagnostics = client.storage.getExecutionRoutingDiagnostics?.({
        space,
        branch: "",
      });
      assertExists(diagnostics, "client execution routing is unavailable");
      // Chain-scoped acceptance (§2): every claim this replica stores names
      // its OWN chain — never a sibling session's, never another principal's.
      const allowed = ownChainKeys(client);
      const storedContexts = diagnostics.claims.map((claim) =>
        claim.contextKey
      );
      assertEquals(
        storedContexts.filter((key) => !allowed.has(key)),
        [],
        `${name} stored a foreign-chain claim: ${
          JSON.stringify(storedContexts)
        }`,
      );
      // The session's own tally claim routed on its own session lane.
      const claimed = diagnostics.actions.filter((action) =>
        action.liveClaim !== undefined
      );
      assert(
        claimed.some((action) => action.liveClaim!.contextKey === sessionLane),
        `no live session-lane claim routed on ${name} (${sessionLane}): ${
          JSON.stringify(claimed.map((action) => action.liveClaim!.contextKey))
        }`,
      );
      for (const action of claimed) {
        assertEquals(
          action.upstreamRoutes,
          0,
          `claimed action ${action.key.actionId} routed upstream on ${name}`,
        );
      }
      // The claimed derivation reached this client through an overlay
      // (speculation or settlement projection — same race note as C1.9),
      // never the wire.
      assert(
        diagnostics.branchTotals.claimedOverlayRoutes > 0 ||
          diagnostics.branchTotals.settlements.committed > 0,
        `claimed actions on ${name} produced neither a client-speculated ` +
          "overlay nor a server-settlement projection",
      );
    }

    // ------- §7 (b) at the wire + CA5 (gate half): the confidentiality
    // sweep. After the server's session lanes authored session-scoped rows
    // for all three sessions, NO client's wire ever carried an instance or
    // claim key outside its own chain: s2 and bob never received s1's
    // `session:<alice>:<s1>` rows (the server-lane-authored write source),
    // s1 never received theirs, and bob never received anything of alice's.
    for (const [name, client] of gateClients) {
      assertEquals(
        foreignWireKeys(client),
        [],
        `${name}'s wire carried foreign-chain scope/context keys`,
      );
      // The positive control: the sweep sees the client's own session key on
      // its own wire (claims and/or scoped instance rows), so an
      // accidentally-empty tap cannot fake the zero above.
      assert(
        client.wireKeys.includes(client.sessionLaneKey()),
        `${name}'s wire never carried its own session lane key — tap broken?`,
      );
    }

    // ------- C2.7's owed template-rank guard leg. -------
    // By the time s2's and bob's lanes opened, the Worker held BOTH template
    // ranks for this piece (tally at session rank, doubled at user rank from
    // s1's runs — s2's session lane claim above proves late-lane synthesis
    // ran). The guard (`emitTemplateCandidatesForLane`'s rank filter plus
    // the router's CA9 `candidateLaneKeys` filter) keeps every candidate's
    // action on lanes of its own rank; without it, s2's/bob's session lanes
    // would receive the user-rank template as a session candidate. Verified
    // discriminating by mutation (2026-07-17): with the Worker guard's
    // `laneContextRank(template...) !== laneRank` check disabled, s2's late
    // lane synthesized `doubled`'s user-rank template as a session-lane
    // candidate, the host CLAIMED the mixed-rank pairing, and the run wedged
    // in exactly the CA9 churn the guard exists to prevent
    // (claim-authority-lost / claim-key-mismatch diagnostics; bob's claims
    // barrier timed out with the cross-rank candidate visible in `events`).
    // This sweep is the direct pin on the same evidence.
    const actionIdsByRank = {
      user: new Set<string>(),
      session: new Set<string>(),
    };
    for (const candidate of candidateEvents) {
      if (candidate.contextKey === "space") continue;
      const rank = candidate.contextKey.startsWith("user:")
        ? "user" as const
        : "session" as const;
      actionIdsByRank[rank].add(candidate.actionId);
    }
    assert(
      actionIdsByRank.session.size > 0 && actionIdsByRank.user.size > 0,
      `both scoped ranks must have produced candidates: ${
        JSON.stringify({
          user: [...actionIdsByRank.user],
          session: [...actionIdsByRank.session],
        })
      }`,
    );
    assertEquals(
      [...actionIdsByRank.session].filter((actionId) =>
        actionIdsByRank.user.has(actionId)
      ),
      [],
      `an action produced candidates at BOTH scoped ranks — the template-rank ` +
        `guard (or the CA9 router filter) admitted a cross-rank pairing: ${
          JSON.stringify(candidateEvents)
        }`,
    );
    // Every session-lane candidate names one of the three real session lanes
    // (canonical keys, never fabricated from a DID — CA9).
    const sessionLaneSet = new Set([s1Lane, s2Lane, bobLane]);
    for (const candidate of candidateEvents) {
      if (candidate.contextKey.startsWith("session:")) {
        assert(
          sessionLaneSet.has(candidate.contextKey),
          `session candidate names an unknown lane: ${candidate.contextKey}`,
        );
      }
    }

    // ------- Guard contract (A13): drain-free run, all fence causes
    // enumerated; the two by-design drain causes at hard zero. -------
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

    // ------- §4 cost note / A25 (gate criterion c): per-lane recompute
    // record beside the Worker aggregate, session lanes included. -------
    const metrics = pool.metrics();
    console.log(
      "session-lane gate measurement:",
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
        sessionLanes: {
          opened: metrics.sessionLanesOpened,
          active: metrics.activeSessionLanes,
          reopens: metrics.sessionLaneReopens,
        },
        userLanes: {
          opened: metrics.userLanesOpened,
          active: metrics.activeUserLanes,
        },
        leaseFenceRejectCauses: causes,
        // C2.10 inputs (recorded, not gated): the R7 hard-zero criterion and
        // the ≥3-lane latency budget are the next work order's.
        c210Inputs: {
          claimContextMismatchRejects: causes["claim-context-mismatch"] ?? 0,
          foreignRecomputeSettleLatencyMs: Math.round(
            foreignRecomputeLatencyMs,
          ),
          concurrentSessionLanes: metrics.activeSessionLanes,
        },
      }),
    );
    assert(
      metrics.sessionLanesOpened >= 3,
      "all three session lanes must have opened",
    );
    assertEquals(metrics.activeSessionLanes, 3);
    for (const [name, lane] of Object.entries(laneKeys)) {
      assert(
        (acceptedByScope.get(lane) ?? 0) > 0,
        `per-lane recompute record is empty for session lane ${name}`,
      );
    }
  } finally {
    unsubscribeAccepted();
    await pool?.close();
    for (const client of [aliceS1, aliceS2, bob]) {
      await client?.runtime.dispose().catch(() => undefined);
      await client?.storage.close().catch(() => undefined);
    }
    await server.close();
  }

  // ------- §7 (b), state plane, inspected DURABLY after shutdown: rows of
  // the SAME derived doc id isolated per session scope key with each
  // session's own value; the space and user lanes' declared keys survive
  // three session lanes sharing their Worker. -------
  const databasePath = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
  );
  assertExists(laneKeys);
  const tallyRows = scopeRows(databasePath, fixtureIds!.tallyId);
  const tallyScopes = new Set(tallyRows.map((row) => row.scope_key));
  for (const lane of Object.values(laneKeys)) {
    assert(
      tallyScopes.has(lane),
      `tally rows must exist under every session scope key: ${
        JSON.stringify([...tallyScopes])
      }`,
    );
  }
  // Values per session: 7+3+10 / 7+3+20 / 7+5+7. The user-scoped component
  // (3 and 5) proves the session lanes read the REAL user instances (CA3).
  assertEquals(latestScopedValue(tallyRows, laneKeys.s1), 20);
  assertEquals(latestScopedValue(tallyRows, laneKeys.s2), 30);
  assertEquals(latestScopedValue(tallyRows, laneKeys.bobSession), 19);
  // The session-scoped derivation must never land a session's value in a
  // BROAD instance: absent, or a scope-naming link envelope (an object) —
  // never a number (§4; the fixture declares tally PerSession end-to-end).
  const tallyBroadValue = latestScopedValue(tallyRows, "space");
  assert(
    tallyBroadValue === undefined ||
      (typeof tallyBroadValue === "object" && tallyBroadValue !== null),
    `the broad tally instance must stay a scope-naming link, got: ${
      JSON.stringify(tallyBroadValue)
    }`,
  );
  const noteRows = scopeRows(databasePath, fixtureIds!.myNoteId);
  assertEquals(scopedScalar(noteRows, laneKeys.s1, "myNote"), 10);
  assertEquals(scopedScalar(noteRows, laneKeys.s2, "myNote"), 20);
  assertEquals(scopedScalar(noteRows, laneKeys.bobSession, "myNote"), 7);
  const boardTotalRows = scopeRows(databasePath, fixtureIds!.boardTotalId);
  assert(boardTotalRows.length > 0, "space derivation left no durable row");
  assertEquals(
    new Set(boardTotalRows.map((row) => row.scope_key)),
    new Set(["space"]),
    "the space lane's declared scope keys were clobbered by a session lane",
  );
  assertEquals(latestScopedValue(boardTotalRows, "space"), 7);
}

// ---------------------------------------------------------------------------
// Router-level fixtures: the same seam the Worker uses, in-process and fast.
// The session twin of C1.9's router legs: the fixture's three derivations
// classify at their forced ranks through the REAL executor router with the
// session dial on, and the CA9 rank filter keys each scoped candidate by
// open lanes OF ITS RANK only.
// ---------------------------------------------------------------------------

type RouterDrive = {
  candidates: CandidateClaim[];
  diagnostics: ExecutorCandidateDiagnostic[];
  did: string;
  sessionLane: string;
};

/** Run the fixture on an emulated client whose action transactions flow
 * through the REAL executor router with user+session candidacy enabled and
 * one open session lane plus the sponsor's user lane, exactly as the Worker
 * routes them (C2.5). */
const driveFixtureThroughRouter = async (): Promise<RouterDrive> => {
  const signer = await Identity.generate({ implementation: "noble" });
  const space = signer.did() as MemorySpace;
  const sessionLane = sessionExecutionContextKey(
    signer.did(),
    "router-session-1",
  );
  const userLane = userExecutionContextKey(signer.did());
  const candidates: CandidateClaim[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    userRankCandidates: true,
    sessionRankCandidates: true,
    lanePrincipal: signer.did(),
    openUserLaneKeys: () => [sessionLane, userLane],
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
      "session-lane-router-result",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, {}, result);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    // Re-run the derivations with real data so the routed observations are
    // plain steady-state recomputes, not the piece-creation batch.
    const tx2 = runtime.edit();
    handle.withTx(tx2).key("myScore").set(4);
    assertEquals((await tx2.commit()).error, undefined);
    await runtime.settled();
    const tx3 = runtime.edit();
    handle.withTx(tx3).key("myNote").set(9);
    assertEquals((await tx3.commit()).error, undefined);
    await runtime.settled();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
  return { candidates, diagnostics, did: signer.did(), sessionLane };
};

Deno.test("session-lane router: the PerSession derivation classifies session-rank claim-ready, keyed by the open session lane only", async () => {
  const { candidates, diagnostics, sessionLane, did } =
    await driveFixtureThroughRouter();
  const userLane = userExecutionContextKey(did);
  // No rejection of the session-scoped write surface: the C2.2 widenings
  // admit the fixture's session pair (a session-rank rejection would show as
  // dynamic-non-space-write-scope / dynamic-write-outside-static-surface).
  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.diagnosticCode === "dynamic-write-outside-static-surface" ||
      diagnostic.diagnosticCode === "dynamic-non-space-write-scope" ||
      diagnostic.diagnosticCode === "malformed-output-surface"
    ),
    [],
    `the session fixture rejects at the router seam: ${
      JSON.stringify(diagnostics)
    }`,
  );
  const sessionCandidates = candidates.filter((candidate) =>
    candidate.claimKey.contextKey === sessionLane
  );
  assert(
    sessionCandidates.length > 0,
    `no session-rank candidate for the PerSession derivation: ${
      JSON.stringify(candidates.map((candidate) => candidate.claimKey))
    }`,
  );
  // CA9 rank filter at the router seam: the session-rank action's candidates
  // key by the SESSION lane only — never the open user lane — and vice
  // versa: the user-rank action (doubled) never candidates on the session
  // lane. One actionId per scoped rank, disjoint.
  const sessionActionIds = new Set(
    sessionCandidates.map((candidate) => candidate.claimKey.actionId),
  );
  const userActionIds = new Set(
    candidates.filter((candidate) => candidate.claimKey.contextKey === userLane)
      .map((candidate) => candidate.claimKey.actionId),
  );
  assert(userActionIds.size > 0, "the user-rank leg produced no candidate");
  assertEquals(
    [...sessionActionIds].filter((actionId) => userActionIds.has(actionId)),
    [],
    "an action classified at both scoped ranks through the router",
  );
});

Deno.test("session-lane router control: the fixture's space derivation stays claim-ready at space rank with the session dial on", async () => {
  const { candidates } = await driveFixtureThroughRouter();
  assert(
    candidates.some((candidate) => candidate.claimKey.contextKey === "space"),
    `no space candidate with the session dial on: ${
      JSON.stringify(candidates.map((candidate) => candidate.claimKey))
    }`,
  );
});

// ---------------------------------------------------------------------------
// Flag-off parity: the same fixture with the execution flags off stays green
// and client-primary — no pool, no claims, no authority — while the
// session-scoped rows stay isolated per session (scope resolution is a host
// property, not an execution-authority property). This is the fixture's own
// sanity bar; C2.10 owns the split parity/latency gate.
// ---------------------------------------------------------------------------

Deno.test("session-lane flag-off parity: two sessions and a foreign principal converge client-primary with isolated session rows and zero execution authority", async () => {
  const storeDir = await Deno.makeTempDir({ prefix: "session-lane-parity-" });
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-lane-parity" },
    protocolFlags: FLAGS_OFF,
    acl: { mode: "off", serviceDids: [space] },
  });
  let aliceS1: GateClient | null = null;
  let aliceS2: GateClient | null = null;
  let bob: GateClient | null = null;
  let fixture: (FixtureResult & { resultLink: unknown }) | null = null;
  let laneKeys: { s1: string; s2: string; bobSession: string } | null = null;
  try {
    aliceS1 = await openClient(server, FLAGS_OFF, false);
    aliceS2 = await openClient(server, FLAGS_OFF, false, aliceS1.identity);
    bob = await openClient(server, FLAGS_OFF, false);
    fixture = await seedFixture(aliceS1, space);

    for (const client of [aliceS2, bob]) {
      // deno-lint-ignore no-explicit-any
      const root = client.runtime.getCellFromLink(fixture.resultLink as any);
      await root.sync();
      assertEquals(await client.runtime.start(root), true);
      await client.runtime.settled();
    }

    await setField(aliceS1, fixture.resultLink, "myScore", 3);
    await setField(aliceS1, fixture.resultLink, "myNote", 10);
    await setField(aliceS1, fixture.resultLink, "board", [2, 4]);
    await setField(aliceS2, fixture.resultLink, "myNote", 20);
    await setField(bob, fixture.resultLink, "myScore", 5);
    await setField(bob, fixture.resultLink, "myNote", 7);

    await waitForCondition(
      "flag-off client convergence",
      async () =>
        await readCellNumber(aliceS1!, fixture!.resultLink, "tally") === 19 &&
        await readCellNumber(aliceS2!, fixture!.resultLink, "tally") === 29 &&
        await readCellNumber(bob!, fixture!.resultLink, "tally") === 18,
    );
    // Cross-session isolation from the CLIENT view: s1's tally stays its own
    // after s2's and bob's writes landed.
    assertEquals(
      await readCellNumber(aliceS1, fixture.resultLink, "tally"),
      19,
    );
    for (const client of [aliceS1, aliceS2, bob]) {
      await client.runtime.settled();
      await client.storage.synced();
    }
    laneKeys = {
      s1: aliceS1.sessionLaneKey(),
      s2: aliceS2.sessionLaneKey(),
      bobSession: bob.sessionLaneKey(),
    };

    // Space-only: zero execution authority of any kind was minted.
    assertEquals(server.executionStats.claimsIssued, 0);
    assertEquals(server.executionStats.claimsIssuedByContextKey, {});
    assertEquals(server.executionStats.leaseFenceRejects, 0);
    assertEquals(server.listExecutionDemands(space, ""), []);
  } finally {
    for (const client of [aliceS1, aliceS2, bob]) {
      await client?.runtime.dispose().catch(() => undefined);
      await client?.storage.close().catch(() => undefined);
    }
    await server.close();
  }

  try {
    // Durable isolation holds identically with the flags off: same doc id,
    // one row set per session scope key.
    const databasePath = fromFileUrl(
      resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
    );
    assertExists(laneKeys);
    const tallyRows = scopeRows(databasePath, fixture!.tallyId);
    assertEquals(latestScopedValue(tallyRows, laneKeys.s1), 19);
    assertEquals(latestScopedValue(tallyRows, laneKeys.s2), 29);
    assertEquals(latestScopedValue(tallyRows, laneKeys.bobSession), 18);
    const noteRows = scopeRows(databasePath, fixture!.myNoteId);
    assertEquals(scopedScalar(noteRows, laneKeys.s1, "myNote"), 10);
    assertEquals(scopedScalar(noteRows, laneKeys.s2, "myNote"), 20);
    assertEquals(scopedScalar(noteRows, laneKeys.bobSession, "myNote"), 7);
  } finally {
    await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
  }
});
