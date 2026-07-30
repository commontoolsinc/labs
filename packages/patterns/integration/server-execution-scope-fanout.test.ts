/**
 * §5h.4 item 2 — the FAN-OUT, asserted rather than built.
 *
 * The owner's scope-discovery algorithm (client-passivity §5h.4):
 *
 * > Run it at the **declared** scope. If it **stays** there, done. If it
 * > **narrowed**, make it the user's / session's run **and start the
 * > adjacent ones.** Equivalently: the first session interested in this
 * > should run it, and if scope didn't expand, you saved the others the run.
 *
 * and, on how it is supposed to come about:
 *
 * > Don't treat it as a direct design target, that could as well be a
 * > side-effect of a higher level invariant. Maybe all that happens is that
 * > the part that sends data to the client realizes that this still needs
 * > computing. **Please add tests that ensure this is happening. If they
 * > fail, we have to debug it.**
 *
 * So this file asserts the OUTCOME and nothing about the mechanism. It never
 * asserts that a scheduler enumerated principals, that a lane opened, or
 * that a particular candidate was emitted; it asserts that each interested
 * principal ends up with ITS OWN value, admitted by the server. A red test
 * here is a finding about the higher-level invariant, not a request for
 * dedicated fan-out machinery.
 *
 * WHY A NEW FIXTURE. The two landed gates come close but neither one poses
 * the question:
 *   - C1.9 (`server-execution-user-lane-gate.test.ts`) drives a PerUser
 *     derivation that reads ONLY PerUser state, so each principal
 *     necessarily triggers its own recompute — two independent triggers, not
 *     a fan-out.
 *   - C2.9 (`server-execution-session-lane-gate.test.ts`) does have a
 *     foreign-caused-recompute leg, but every session lane there had already
 *     been claimed off its own earlier write before the shared trigger
 *     lands.
 * `fixtures/scope-fanout` puts both halves of the algorithm over ONE shared
 * input: `boardTotal` stays at space scope, `myShare` narrows to user scope
 * while still reading the shared board. One `board` write then has to
 * produce one admitted value PER interested principal.
 *
 * THE WORKLOAD, and why it is ordered the way it is. All THREE principals
 * write their PerUser `myScore` BEFORE the pool starts, so those writes are
 * ordinary client-primary commits and are NOT part of the served phase.
 * Once the executor is live the ONLY write anybody makes is alice's shared
 * `board` write:
 *   - alice triggers, and is the "first session interested";
 *   - bob is interested throughout but does nothing at all after the
 *     executor takes over — the plain "adjacent one";
 *   - carol becomes interested only AFTER the trigger has settled, with her
 *     own instance durably stale, and nothing is written after she arrives.
 *     Hers is the leg that tests the owner's own hypothesis directly: the
 *     only event is that a new session wants the piece.
 *
 * PROVENANCE IS READ SERVER-SIDE. Every "who computed this" judgement comes
 * from `AcceptedCommitEvent.originSessionId` against the set of session ids
 * each client mounts, never from a client-side commit tap — see the
 * `AcceptedRow` docblock for why.
 *
 * NOTHING HERE HARD-FAILS ON A BARRIER. Every wait is bounded and records
 * what it saw instead of throwing, so a missing fan-out is reported as
 * "bob's value was never admitted" rather than as a timeout. The positive
 * control for "we waited long enough" is the space-scoped `boardTotal`
 * landing: once the shared half of the trigger has been served, the trigger
 * has definitely reached the server.
 *
 * VERIFIED DISCRIMINATING BY MUTATION (2026-07-30, adjacent runs):
 *   - with `userLaneCandidates` off and the user-rank candidate dial
 *     removed, (1) stays GREEN and (2)/(3) go RED, with the admissions log
 *     naming each client as having covered for itself;
 *   - with bob never publishing demand, (1) stays GREEN and (2) goes RED on
 *     bob's leg alone while alice is still served.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
// Built into the Deno runtime (no fetch, no new dependency): read-only
// per-scope row inspection of the server's closed store file, exactly as the
// C1.9 gate does it.
// deno-lint-ignore no-external-import
import { DatabaseSync } from "node:sqlite";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionClaimRankConfig,
  sessionExecutionContextKey,
  setServerPrimaryExecutionClaimRankConfig,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import { Runtime } from "@commonfabric/runner";
import {
  SharedExecutionPool,
  type SpaceExecutor,
} from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  type GateClient,
  LoopbackStorageManager,
  readGateKey,
  setGateField,
  waitForCondition,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const FIXTURE_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "scope-fanout",
  "main.tsx",
);

/** Server-primary execution with the context-lattice claims subcapability
 * every client negotiates — the same bundle the C1.9/C2.9 gates run. */
const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

/** Alice's and bob's pre-executor PerUser inputs, and the one shared write
 * the served phase makes. `board` starts empty (boardTotal 0), so every
 * derived value must MOVE when the shared write lands — a stale value can
 * never be mistaken for a fresh one. */
const ALICE_SCORE = 3;
const BOB_SCORE = 5;
/** Carol seeds her input alongside the others but only becomes interested
 * AFTER the trigger has fully settled — the late-joiner leg. */
const CAROL_SCORE = 7;
const BOARD = [2, 4];
const BOARD_TOTAL = 6;
const ALICE_SHARE = BOARD_TOTAL * 100 + ALICE_SCORE; // 603
const BOB_SHARE = BOARD_TOTAL * 100 + BOB_SCORE; // 605
const CAROL_SHARE = BOARD_TOTAL * 100 + CAROL_SCORE; // 607
/** What carol's instance durably holds before she joins: computed
 * client-primary against the EMPTY board, so it is stale by exactly the
 * board total. If she ends up with this, nothing computed for her. */
const CAROL_STALE_SHARE = CAROL_SCORE; // 7

const SERVED_PHASE_TIMEOUT_MS = 45_000;
/** Extra grace given to the ADJACENT principal after the triggering
 * principal's own value has already been admitted. Generous on purpose: the
 * point of this file is that a red result means "it never happened", not
 * "it was slow". */
const FANOUT_GRACE_MS = 30_000;

/**
 * One accepted revision of a derived document, with WHO transacted it.
 *
 * Provenance is read off the server's own `AcceptedCommitEvent`
 * (`originSessionId`, stamped from the transacting session), NOT off a
 * client-side commit tap. Two client-side taps were tried first and both
 * silently read zero on a run where the clients were demonstrably producing
 * the values — wrapping `session.transact` never saw the derived commits at
 * all. A tap that cannot fail loudly is worse than no tap: it turns
 * "the client covered for the server" into a green test.
 */
type AcceptedRow = {
  readonly id: string;
  readonly scopeKey: string;
  readonly origin: string | undefined;
};

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
 * rows — `set` ops carry the whole document, `patch` ops move the `/value`
 * pointer. Verbatim from the C1.9 gate, whose store layout this reads. */
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
          if (next === null || typeof next !== "object") target[segment] = {};
          target = target[segment] as Record<string, unknown>;
        }
        target[segments[segments.length - 1]] = operation.value;
      }
    }
  }
  return value;
};

/**
 * The harness's gate client plus the set of EVERY session id it mounts.
 * That set is the provenance key: an accepted revision whose
 * `originSessionId` is in no client's set was transacted by the executor.
 * The harness's own `openGateClient` keeps only the last mounted id, which
 * is not safe to attribute against.
 */
type FanoutClient = GateClient & { readonly sessionIds: Set<string> };

const openFanoutClient = async (
  server: Server,
  identity?: Identity,
): Promise<FanoutClient> => {
  const clientIdentity = identity ??
    await Identity.generate({ implementation: "noble" });
  const commits: ClientCommit[] = [];
  const sessionIds = new Set<string>();
  let mountedSessionId: string | undefined;
  const storage = LoopbackStorageManager.connectTo(
    server,
    FLAGS,
    { as: clientIdentity },
    (commit) => commits.push(commit),
    (sessionId) => {
      sessionIds.add(sessionId);
      mountedSessionId = sessionId;
    },
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
  });
  const sessionId = () => {
    if (mountedSessionId === undefined) {
      throw new Error("the fan-out client never mounted a session");
    }
    return mountedSessionId;
  };
  return {
    identity: clientIdentity,
    did: clientIdentity.did(),
    userLaneKey: userExecutionContextKey(clientIdentity.did()),
    storage,
    runtime,
    commits,
    wireKeys: [],
    sessionId,
    sessionLaneKey: () =>
      sessionExecutionContextKey(clientIdentity.did(), sessionId()),
    sessionIds,
  };
};

/** Bounded wait that RECORDS its outcome instead of throwing, so a missing
 * fan-out surfaces as a value assertion rather than as a barrier timeout.
 * `nudge` drives the live Worker's `wake()`/`settle()` fixpoint (§2.1: the
 * pool never wakes an executor that is already live). */
const settleUntil = async (
  condition: () => boolean,
  nudge: () => Promise<void>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    if (polls % 10 === 0) await nudge();
    polls++;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
};

type PrincipalReport = {
  readonly did: string;
  readonly laneKey: string;
  /** Value this principal's own client reads after the shared trigger — the
   * DELIVERY half. */
  readonly deliveredShare: unknown;
  readonly deliveredDoubled: unknown;
  readonly deliveredBoardTotal: unknown;
  /** Post-trigger accepted revisions of the NARROWED derivation under this
   * principal's own scope key, split by who transacted them. `fromServer`
   * is the fan-out: some session that is not a client of this fixture — the
   * executor — produced this principal's value. `fromAnyClient` non-zero
   * means a client covered for it. */
  readonly shareAdmittedFromServer: number;
  readonly shareAdmittedFromAnyClient: number;
  /** Same split for the space-scoped derivation, so the stays-at-scope case
   * can also say WHO computed the one shared result. */
  readonly boardTotalAdmittedFromServer: number;
  readonly boardTotalAdmittedFromAnyClient: number;
};

type FanoutReport = {
  readonly space: MemorySpace;
  readonly alice: PrincipalReport;
  readonly bob: PrincipalReport;
  /** The late joiner: measured from the moment she becomes interested, with
   * NO trigger of any kind after that point. */
  readonly carol: PrincipalReport;
  readonly lateJoinerSettled: boolean;
  /** Did the SHARED, space-scoped half of the trigger get served? The
   * positive control for the stays-at-declared-scope case; if this is false
   * the trigger never reached the server at all and nothing else here is
   * measurable. Deliberately independent of the narrowed half, which is
   * governed by different dials. */
  readonly spaceTriggerServed: boolean;
  /** Did the TRIGGERING principal's own narrowed value land? False means a
   * serving-coverage gap upstream of the fan-out question. */
  readonly narrowedTriggerServed: boolean;
  /** Did the ADJACENT principal's narrowed value land? */
  readonly fanoutSettled: boolean;
  /** Post-trigger accepted revisions of `boardTotal`, keyed by resolved
   * scope key. The stays-at-declared-scope evidence: one space instance, no
   * per-principal duplication. */
  readonly boardTotalScopes: Record<string, number>;
  /** Durable per-scope values after shutdown. */
  readonly durable: {
    readonly shareByScope: Record<string, unknown>;
    readonly boardTotalScopes: string[];
    readonly boardTotalSpaceValue: unknown;
  };
  /** Every post-trigger accepted revision of a derived doc, with its
   * transacting session resolved to a name — the raw provenance evidence. */
  readonly admissions: string[];
  readonly stats: Record<string, unknown>;
  readonly poolMetrics: Record<string, unknown>;
  readonly events: string[];
};

async function runFanoutWorkload(): Promise<FanoutReport> {
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const storeDir = await Deno.makeTempDir({ prefix: "scope-fanout-" });
  setServerPrimaryExecutionClaimRankConfig("user");
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-scope-fanout" },
    protocolFlags: FLAGS,
    acl: { mode: "off", serviceDids: [space] },
  });
  let alice: FanoutClient | null = null;
  let bob: FanoutClient | null = null;
  let carol: FanoutClient | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeAccepted = () => {};
  const events: string[] = [];
  /** Every accepted revision of a derived doc, in order, with the session
   * that transacted it. All counting is a filter over this one log, so the
   * before/after marks are just indices into it. */
  const acceptedLog: AcceptedRow[] = [];
  /** Admissions of `id` under `scopeKey` since `mark`, optionally filtered
   * by whether a client of this fixture transacted them. */
  const admitted = (
    mark: number,
    id: string,
    scopeKey: string,
    by?: "server" | "client",
  ): number =>
    acceptedLog.slice(mark).filter((row) =>
      row.id === id && row.scopeKey === scopeKey &&
      (by === undefined ||
        (by === "client") ===
          (row.origin !== undefined && clientSessionIds().has(row.origin)))
    ).length;
  const clientSessionIds = (): Set<string> =>
    new Set([
      ...alice?.sessionIds ?? [],
      ...bob?.sessionIds ?? [],
      ...carol?.sessionIds ?? [],
    ]);
  let ids: {
    resultLink: unknown;
    boardTotalId: string;
    doubledId: string;
    myShareId: string;
  } | null = null;
  let report: Omit<FanoutReport, "durable"> | null = null;
  try {
    alice = await openFanoutClient(server);
    bob = await openFanoutClient(server);
    carol = await openFanoutClient(server);

    // ---- seed: alice compiles and runs the fixture, client-primary. ----
    const program = await alice.runtime.harness.resolve(
      new FileSystemProgramResolver(FIXTURE_PATH, PATTERNS_ROOT),
    );
    const compiled = await alice.runtime.patternManager.compilePattern(
      program,
      { space },
    );
    const tx = alice.runtime.edit();
    const result = alice.runtime.getCell<Record<string, unknown>>(
      space,
      "scope-fanout-result",
      undefined,
      tx,
    );
    const handle = alice.runtime.run(tx, compiled, {}, result);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await alice.runtime.settled();
    await alice.storage.synced();
    const linkId = (name: string) =>
      handle.key(name).resolveAsCell().getAsNormalizedFullLink().id as string;
    ids = {
      resultLink: result.getAsNormalizedFullLink(),
      boardTotalId: linkId("boardTotal"),
      doubledId: linkId("doubled"),
      myShareId: linkId("myShare"),
    };
    const derivedIds = [ids.boardTotalId, ids.doubledId, ids.myShareId];

    unsubscribeAccepted = server.subscribeAcceptedCommits(space, (event) => {
      for (const revision of event.revisions) {
        if (!derivedIds.includes(revision.id)) continue;
        acceptedLog.push({
          id: revision.id,
          scopeKey: (revision as { scopeKey?: string }).scopeKey ?? "space",
          origin: event.originSessionId,
        });
      }
    });

    // ---- PRE-EXECUTOR: every principal writes its own PerUser input. ----
    // Ordinary client-primary commits, before any server execution exists.
    // After this point bob and carol write nothing at all, ever.
    await setGateField(alice, ids.resultLink, "myScore", ALICE_SCORE);
    await alice.runtime.settled();
    await alice.storage.synced();
    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(ids.resultLink as any);
    await bobRoot.sync();
    await setGateField(bob, ids.resultLink, "myScore", BOB_SCORE);
    await bob.runtime.settled();
    await bob.storage.synced();
    // deno-lint-ignore no-explicit-any
    const carolRoot = carol.runtime.getCellFromLink(ids.resultLink as any);
    await carolRoot.sync();
    await setGateField(carol, ids.resultLink, "myScore", CAROL_SCORE);
    await carol.runtime.settled();
    await carol.storage.synced();

    // ---- the executor takes over. ----
    let liveExecutor: SpaceExecutor | undefined;
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
        events.push(`candidate:${candidate.claimKey.contextKey}`),
      onCandidateDiagnostic: (diagnostic) =>
        events.push(
          `diagnostic:${diagnostic.diagnosticCode}:${
            diagnostic.claimKey?.contextKey ?? "?"
          }`,
        ),
    });
    pool = new SharedExecutionPool({
      control: server,
      factory: {
        async start(options) {
          liveExecutor = await factory.start(options);
          return liveExecutor;
        },
      },
      settleTimeoutMs: 20_000,
      userLaneCandidates: true,
      legacyBackgroundActive: () => false,
    });
    // The demand feed has no replay-on-subscribe: the pool must be listening
    // before the first client publishes demand.
    pool.start();

    // Alice starts first, so her session is deterministically the demand
    // sponsor; bob attaches to the same piece afterwards. Both are then
    // "interested" in exactly the sense the algorithm means.
    // deno-lint-ignore no-explicit-any
    const aliceRoot = alice.runtime.getCellFromLink(ids.resultLink as any);
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
    assertEquals(await bob.runtime.start(bobRoot), true);
    await bob.runtime.settled();
    await waitForCondition(
      "both principals demand the piece",
      () => server.listExecutionDemands(space, "").length >= 2,
      () => server.listExecutionDemands(space, ""),
    );

    const nudge = async () => {
      try {
        await liveExecutor?.wake();
        await liveExecutor?.settle();
      } catch (error) {
        events.push(`nudge-error:${String(error)}`);
      }
    };
    await nudge();

    // ---- the served phase begins. ----
    // Everything the fan-out claim rests on is measured from this mark
    // forward, so no pre-executor client-primary commit can be mistaken for
    // a server result.
    const mark = acceptedLog.length;

    // THE ONE TRIGGER. A shared, space-scoped write, made by alice only.
    // It invalidates `boardTotal` (stays at space scope) and BOTH
    // principals' `myShare` instances (narrowed to user scope).
    await setGateField(alice, ids.resultLink, "board", BOARD);

    // Positive control, in two independent parts. The shared space-scoped
    // value says the trigger reached the server at all; the triggering
    // principal's own narrowed value says the narrowed half is served for
    // SOMEBODY. Keeping them apart is what lets a fan-out failure be told
    // from a serving-coverage failure. Both count SERVER admissions only —
    // a client covering for the server is not "served".
    const spaceTriggerServed = await settleUntil(
      () => admitted(mark, ids!.boardTotalId, "space", "server") > 0,
      nudge,
      SERVED_PHASE_TIMEOUT_MS,
    );
    const narrowedTriggerServed = await settleUntil(
      () => admitted(mark, ids!.myShareId, alice!.userLaneKey, "server") > 0,
      nudge,
      SERVED_PHASE_TIMEOUT_MS,
    );
    // THE FAN-OUT: the adjacent principal, who did nothing.
    const fanoutSettled = await settleUntil(
      () => admitted(mark, ids!.myShareId, bob!.userLaneKey, "server") > 0,
      nudge,
      FANOUT_GRACE_MS,
    );

    for (const client of [alice, bob]) {
      await client.runtime.settled();
      await client.storage.synced();
    }

    const principal = async (
      client: FanoutClient,
      from: number,
    ): Promise<PrincipalReport> => ({
      did: client.did,
      laneKey: client.userLaneKey,
      deliveredShare: await readGateKey(client, ids!.resultLink, "myShare"),
      deliveredDoubled: await readGateKey(client, ids!.resultLink, "doubled"),
      deliveredBoardTotal: await readGateKey(
        client,
        ids!.resultLink,
        "boardTotal",
      ),
      shareAdmittedFromServer: admitted(
        from,
        ids!.myShareId,
        client.userLaneKey,
        "server",
      ),
      shareAdmittedFromAnyClient: admitted(
        from,
        ids!.myShareId,
        client.userLaneKey,
        "client",
      ),
      boardTotalAdmittedFromServer: admitted(
        from,
        ids!.boardTotalId,
        "space",
        "server",
      ),
      boardTotalAdmittedFromAnyClient: admitted(
        from,
        ids!.boardTotalId,
        "space",
        "client",
      ),
    });
    const aliceReport = await principal(alice, mark);
    const bobReport = await principal(bob, mark);

    // ---- THE LATE JOINER. ----
    // Carol becomes interested only now, with the shared trigger long
    // settled and her own instance durably STALE (computed client-primary
    // against the empty board). Nobody writes anything after this point —
    // the only event is that a new session wants the piece. If her value
    // ends up current, "the part that sends data to the client realized
    // this still needs computing"; if it stays stale, it did not.
    const lateMark = acceptedLog.length;
    assertEquals(await carol.runtime.start(carolRoot), true);
    await waitForCondition(
      "the late joiner's demand reaches the server",
      () => server.listExecutionDemands(space, "").length >= 3,
      () => server.listExecutionDemands(space, ""),
    );
    const lateJoinerSettled = await settleUntil(
      () =>
        admitted(lateMark, ids!.myShareId, carol!.userLaneKey, "server") > 0,
      nudge,
      FANOUT_GRACE_MS,
    );
    await carol.runtime.settled();
    await carol.storage.synced();

    const nameOf = (origin: string | undefined): string =>
      origin === undefined
        ? "?"
        : alice!.sessionIds.has(origin)
        ? "alice-client"
        : bob!.sessionIds.has(origin)
        ? "bob-client"
        : carol!.sessionIds.has(origin)
        ? "carol-client"
        : "server-executor";
    const label = (id: string): string =>
      id === ids!.boardTotalId
        ? "boardTotal"
        : id === ids!.myShareId
        ? "myShare"
        : "doubled";

    report = {
      space,
      alice: aliceReport,
      bob: bobReport,
      carol: await principal(carol, lateMark),
      lateJoinerSettled,
      spaceTriggerServed,
      narrowedTriggerServed,
      fanoutSettled,
      boardTotalScopes: acceptedLog.slice(mark, lateMark).filter((row) =>
        row.id === ids!.boardTotalId
      ).reduce<Record<string, number>>((counts, row) => {
        counts[row.scopeKey] = (counts[row.scopeKey] ?? 0) + 1;
        return counts;
      }, {}),
      admissions: acceptedLog.map((row, index) =>
        `${index < mark ? "pre" : index < lateMark ? "trigger" : "late-join"}` +
        `: ${label(row.id)}@${row.scopeKey} by ${nameOf(row.origin)}`
      ),
      stats: JSON.parse(JSON.stringify(server.executionStats)),
      poolMetrics: JSON.parse(JSON.stringify(pool.metrics())),
      events: events.slice(-60),
    };
  } finally {
    unsubscribeAccepted();
    await pool?.close().catch(() => undefined);
    for (const client of [alice, bob, carol]) {
      await client?.runtime.dispose().catch(() => undefined);
      await client?.storage.close().catch(() => undefined);
    }
    await server.close().catch(() => undefined);
    resetServerPrimaryExecutionClaimRankConfig();
  }

  // Durable inspection of the closed store: which scope keys actually carry
  // a value for the narrowed derivation, and what that value is.
  const databasePath = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space),
  );
  const shareRows = scopeRows(databasePath, ids!.myShareId);
  const boardTotalRows = scopeRows(databasePath, ids!.boardTotalId);
  const durable = {
    shareByScope: Object.fromEntries(
      [...new Set(shareRows.map((row) => row.scope_key))].map((scopeKey) => [
        scopeKey,
        latestScopedValue(shareRows, scopeKey),
      ]),
    ),
    boardTotalScopes: [
      ...new Set(boardTotalRows.map((row) => row.scope_key)),
    ].sort(),
    boardTotalSpaceValue: latestScopedValue(boardTotalRows, "space"),
  };
  await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
  const complete = { ...report!, durable };
  // Always report the measurement, green or red: the assertions below only
  // say pass/fail, and the arc's discipline (§2.5) is that a number without
  // its engagement counters reads as "not engaged".
  console.log(`§5h.4 fan-out measurement:\n${describe(complete)}`);
  return complete;
}

/**
 * One workload, two independent verdicts. The stays-at-declared-scope case
 * and the narrowed case are two halves of the SAME algorithm over the same
 * trigger, so measuring them in one run is the adjacent-arm discipline
 * (§2.5); memoizing the report keeps each half's assertion failure its own.
 */
let workload: Promise<FanoutReport> | undefined;
const fanoutReport = (): Promise<FanoutReport> => {
  workload ??= withExecutorTeardownBarrier(() => runFanoutWorkload());
  return workload;
};

const describe = (report: FanoutReport): string =>
  JSON.stringify(
    {
      spaceTriggerServed: report.spaceTriggerServed,
      narrowedTriggerServed: report.narrowedTriggerServed,
      fanoutSettled: report.fanoutSettled,
      lateJoinerSettled: report.lateJoinerSettled,
      alice: report.alice,
      bob: report.bob,
      carol: report.carol,
      boardTotalScopes: report.boardTotalScopes,
      admissions: report.admissions,
      durable: report.durable,
      poolMetrics: report.poolMetrics,
      stats: report.stats,
      events: report.events,
    },
    null,
    2,
  );

Deno.test({
  name:
    "§5h.4 fan-out (1): a derivation whose scope STAYS at the declared space " +
    "scope is computed once and serves every interested principal",
  async fn() {
    const report = await fanoutReport();
    assert(
      report.spaceTriggerServed,
      `the shared trigger was never served at space scope, so nothing below ` +
        `is measurable: ${describe(report)}`,
    );

    // Every interested principal ends up with the shared value.
    assertEquals(
      [report.alice.deliveredBoardTotal, report.bob.deliveredBoardTotal],
      [BOARD_TOTAL, BOARD_TOTAL],
      `a principal did not receive the space-scoped derivation: ${
        describe(report)
      }`,
    );

    // ...and it was computed ONCE, for the space, not once per principal.
    // This is the case the inversion saves work on: no principal-scoped
    // instance of it exists anywhere, so nobody else had to run it.
    assertEquals(
      Object.keys(report.boardTotalScopes),
      ["space"],
      `the space-scoped derivation was admitted at a narrower scope too — ` +
        `the saving the inversion promises did not materialize: ${
          describe(report)
        }`,
    );
    assertEquals(
      report.durable.boardTotalScopes,
      ["space"],
      `durable rows for the space-scoped derivation are not space-only: ${
        describe(report)
      }`,
    );
    assertEquals(
      report.durable.boardTotalSpaceValue,
      BOARD_TOTAL,
      `the single shared instance does not carry the shared value: ${
        describe(report)
      }`,
    );

    // "you saved the others the run": the one shared result came from the
    // SERVER, and no client had to compute and commit it for itself.
    assert(
      report.alice.boardTotalAdmittedFromServer > 0,
      `the space-scoped derivation was never admitted from the server: ${
        describe(report)
      }`,
    );
    assertEquals(
      report.alice.boardTotalAdmittedFromAnyClient,
      0,
      `a client committed the space-scoped derivation itself, so the one ` +
        `shared run did not in fact serve it: ${describe(report)}`,
    );
  },
});

Deno.test({
  name: "§5h.4 fan-out (2): a derivation that NARROWED to user scope ends up " +
    "computed for EVERY interested principal, from one shared trigger",
  async fn() {
    const report = await fanoutReport();
    assert(
      report.spaceTriggerServed,
      `the shared trigger was never served at space scope, so nothing below ` +
        `is measurable: ${describe(report)}`,
    );

    // The triggering principal — the "first session interested in this".
    // Its value must be there AND must have come from the server; if either
    // fails, this is a serving-coverage gap UPSTREAM of the fan-out
    // question, not a fan-out failure.
    assertEquals(
      report.alice.deliveredShare,
      ALICE_SHARE,
      `the triggering principal did not receive its own narrowed value: ${
        describe(report)
      }`,
    );
    assert(
      report.alice.shareAdmittedFromServer > 0 &&
        report.alice.shareAdmittedFromAnyClient === 0,
      `the narrowed derivation is not served for the TRIGGERING principal ` +
        `either — a serving-coverage gap upstream of the fan-out question: ${
          describe(report)
        }`,
    );

    // THE FAN-OUT. Bob did nothing whatsoever after the executor took over:
    // no write, no handler, no interaction. His value must still be there.
    assertEquals(
      report.bob.deliveredShare,
      BOB_SHARE,
      `the adjacent principal was left without its narrowed value — the ` +
        `first principal's run did not "start the adjacent ones": ${
          describe(report)
        }`,
    );

    // ...and it was the SERVER that produced it. If a client had to compute
    // and commit bob's value, the value is right but the fan-out did not
    // happen: the client covered for it.
    assert(
      report.bob.shareAdmittedFromServer > 0,
      `the adjacent principal's narrowed value was never ADMITTED from the ` +
        `server after the shared trigger — nothing "started the adjacent ` +
        `one": ${describe(report)}`,
    );
    assertEquals(
      report.bob.shareAdmittedFromAnyClient,
      0,
      `a client committed the adjacent principal's narrowed derivation ` +
        `itself — the value came from the client, not from a server ` +
        `fan-out: ${describe(report)}`,
    );

    // Durably, each principal's own instance carries its OWN value: the
    // fan-out produced per-principal results, not one result copied around.
    assertEquals(
      report.durable.shareByScope[report.alice.laneKey],
      ALICE_SHARE,
      `durable narrowed value is wrong for the triggering principal: ${
        describe(report)
      }`,
    );
    assertEquals(
      report.durable.shareByScope[report.bob.laneKey],
      BOB_SHARE,
      `durable narrowed value is missing or wrong for the adjacent ` +
        `principal: ${describe(report)}`,
    );
  },
});

Deno.test({
  name:
    "§5h.4 fan-out (3): a principal who becomes interested AFTER the trigger " +
    "gets its own narrowed value computed, with no new trigger at all",
  async fn() {
    const report = await fanoutReport();
    assert(
      report.spaceTriggerServed,
      `the shared trigger was never served at space scope, so nothing below ` +
        `is measurable: ${describe(report)}`,
    );

    // This is the sharpest form of the owner's hypothesis. Carol's instance
    // was durably STALE when she arrived, and the ONLY thing that happened
    // afterwards is that a new session wanted the piece. Nothing wrote,
    // nothing was invalidated. So the only thing that can produce her value
    // is the delivery path noticing that it still needs computing.
    assertEquals(
      report.carol.deliveredShare,
      CAROL_SHARE,
      report.carol.deliveredShare === CAROL_STALE_SHARE
        ? `the late joiner is still reading her pre-trigger value: becoming ` +
          `interested did not cause her narrowed derivation to be ` +
          `computed: ${describe(report)}`
        : `the late joiner received the wrong narrowed value: ${
          describe(report)
        }`,
    );
    assert(
      report.carol.shareAdmittedFromServer > 0,
      `the late joiner's narrowed value was never admitted from the server ` +
        `after she became interested: ${describe(report)}`,
    );
    assertEquals(
      report.carol.shareAdmittedFromAnyClient,
      0,
      `a client committed the late joiner's narrowed derivation itself — ` +
        `the delivery path did not compute it: ${describe(report)}`,
    );
    assertEquals(
      report.durable.shareByScope[report.carol.laneKey],
      CAROL_SHARE,
      `durable narrowed value is missing or wrong for the late joiner: ${
        describe(report)
      }`,
    );

    // Joining must not disturb what was already shared: the space-scoped
    // derivation is not re-run per arriving principal.
    assertEquals(
      report.carol.boardTotalAdmittedFromServer +
        report.carol.boardTotalAdmittedFromAnyClient,
      0,
      `a principal arriving re-ran the space-scoped derivation, which by ` +
        `construction did not change: ${describe(report)}`,
    );
  },
});
