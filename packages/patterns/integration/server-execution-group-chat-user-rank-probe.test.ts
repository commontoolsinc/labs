/**
 * §5f follow-up, LIVE half: the group-chat product SERVED by a real executor
 * for TWO principals, up the rank ladder, so the engagement counters and the
 * unserved-inventory delta come from a run rather than from a classifier.
 *
 * The classification half is `runner/test/server-execution-group-chat-rank-
 * probe.test.ts` (router seam, one principal, no server). This file is the
 * other half: a real memory-v2 Server with a file-backed store, the real
 * SharedExecutionPool driving a REAL Deno executor Worker, and one real client
 * Runtime per principal over the loopback transport — the C2.9/C2.10 gate
 * topology, which is the only topology where the rank dials can be flipped at
 * all (see the memo's CA4 audit: the RANK dials in the bundle — memory-side
 * `serverPrimaryExecutionClaimRank` and the runner-side user/session candidate
 * dials — are all programmatic-only, so no deployment can reach them).
 *
 * UPDATE (C1.7 env bridge): the audit's item-5 blocker is CLOSED. The
 * `context-lattice-claims-v1` negotiation dial is now env-reachable on both
 * halves of the handshake
 * (`EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS`, gated by
 * `server-execution-context-lattice-env-bridge-gate.test.ts`), so a
 * browser-shaped client DOES negotiate and the amendment-11 cohort gate no
 * longer makes user lanes structurally un-openable. The two-browser leg is
 * still blocked on the rank dials above, which stay a rollout decision.
 *
 * ARMS. Three adjacent arms over one identical workload, the dial bundle as
 * the only difference. Each arm gets its own Server, its own fresh store
 * directory and its own pool/Worker, so no state crosses between them:
 *   - `space`: the whole bundle off — what a deployment runs today.
 *   - `user`: cohort advertisement + claim rank `user` + the runner-side
 *     candidate dial. The C1.5a step §5f asks about.
 *   - `session`: the C2.5 step above it. Included because the product carries
 *     PerSession state (`hostMessageDraft`, `roomDraft`) that a user lane
 *     cannot route.
 *
 * SERVING THE PRODUCT. The pool deliberately does NOT wake an executor that
 * is already live (`#acceptAcceptedCommit` returns early on
 * `slot.executor !== null`) — its wake path exists to start or unpark a
 * Worker, not to drive one. And `set-demand` only ENQUEUES the structural
 * swap; activation completion is observable solely through `settle()`. So the
 * arms drive the Worker's `settle()`/`wake()`/`settle()` fixpoint explicitly,
 * exactly as `runner/test/server-execution-rollout-products.test.ts` does for
 * this same product. Without that the Worker goes live, takes its lanes, and
 * runs nothing — which is how the first cut of this probe measured zero.
 *
 * WHAT IS ASSERTED. The properties that must hold whatever the counters say:
 * every arm actually SERVES (non-zero scheduler runs and claims — otherwise
 * the counters are vacuous); each principal reads its OWN profile name (the
 * product's PerUser label); neither principal's wire stream ever carries the
 * other's `user:` scope key (cross-principal isolation, the A2 property at the
 * delivery seam); no settlement FAILS and no attempt is firewalled at any
 * rank; the dial-bundle discriminator holds (zero user lanes off, one per
 * principal on); the scoped-read offender class falls monotonically up the
 * ladder; and no rank dial INCREASES `claim-context-mismatch` fences.
 *
 * WHAT IS REPORTED, NOT ASSERTED. `server.executionStats` (the same object
 * `/api/health/stats` serves), the pool metrics, and the executor's own
 * counters, printed per arm so a re-run reproduces §5g's numbers. Absolute
 * counts move with load and with the product; pinning them would convert an
 * unrelated change into a failure of this file. One finding is reported this
 * way on purpose — see the R7 note at the fence assertion.
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionClaimRankConfig,
  sessionExecutionContextKey,
  setServerPrimaryExecutionClaimRankConfig,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { markRendererTrustedEvent } from "@commonfabric/runner/cfc";
import {
  SharedExecutionPool,
  type SpaceExecutor,
} from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import { Runtime } from "@commonfabric/runner";
import {
  collectWireScopeAndContextKeys,
  type GateClient,
  LoopbackStorageManager,
  readGateKey,
  waitForCondition,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const GROUP_CHAT = join(PATTERNS_ROOT, "cfc-group-chat-demo", "main.tsx");

// Trusted surface/action names from cfc-group-chat-demo/trusted.tsx, inlined
// exactly as cfc-group-chat-demo-multi-runtime.test.ts inlines them.
const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_SURFACE = "TrustedGroupChatSendSurface";
const SEND_ACTION = "TrustedGroupChatSendMessage";

/** Base protocol flags both arms share. The context-lattice subcapability is
 * added only by the ON arm — it is one of the three dials under audit. */
const BASE_FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

/** The event a genuine user interaction on a trusted surface delivers (see
 * the classification probe's copy for why the product rejects anything
 * else). */
const trustedEvent = (surface: string, action: string): unknown => {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: surface,
        eventIntegrity: [surface],
        uiContractDataset: { uiAction: action },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

/**
 * The harness's `openGateClient` with one addition the group-chat product
 * requires: a `trustSnapshotProvider`. The demo is a CFC pattern whose
 * trusted handlers refuse to prepare a transaction without an acting
 * principal in the trust snapshot (`cfc-relevant-transaction-not-prepared`),
 * and the harness's clients — built for non-CFC gate fixtures — do not supply
 * one. Everything else, including the wire-key tap the isolation assertion
 * reads, is the harness's own shape.
 */
const openProbeClient = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
): Promise<GateClient> => {
  const identity = await Identity.generate({ implementation: "noble" });
  const commits: Parameters<typeof collectWireScopeAndContextKeys>[0][] = [];
  const wireKeys: string[] = [];
  let mountedSessionId: string | undefined;
  const storage = LoopbackStorageManager.connectTo(
    server,
    flags,
    { as: identity },
    (commit) => commits.push(commit),
    (sessionId) => {
      mountedSessionId = sessionId;
    },
    (message) => collectWireScopeAndContextKeys(message, wireKeys),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    patternEnvironment: { apiUrl: new URL("https://toolshed.example/") },
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    trustSnapshotProvider: () => ({
      id: `principal:${identity.did()}`,
      actingPrincipal: identity.did(),
    }),
  });
  const sessionId = () => {
    if (mountedSessionId === undefined) {
      throw new Error("the probe client never mounted a session");
    }
    return mountedSessionId;
  };
  return {
    identity,
    did: identity.did(),
    userLaneKey: userExecutionContextKey(identity.did()),
    storage,
    runtime,
    // deno-lint-ignore no-explicit-any
    commits: commits as any,
    wireKeys,
    sessionId,
    sessionLaneKey: () =>
      sessionExecutionContextKey(identity.did(), sessionId()),
  };
};

type ArmReport = {
  readonly rank: "space" | "user" | "session";
  readonly dials: boolean;
  readonly metrics: Record<string, unknown>;
  /** The executor Worker's own cumulative counters — schedulerRuns is the
   * number that decides whether the Worker ran the piece at all. */
  readonly executorMetrics: Record<string, unknown>;
  /** Demand rows whose session negotiated `context-lattice-claims-v1` — the
   * cohort half of the dial bundle, observed on the wire. */
  readonly negotiatingDemands: number;
  readonly stats: Record<string, unknown>;
  readonly profileNames: Record<string, unknown>;
  readonly messageCount: number;
  /** Foreign `user:` scope keys observed on each client's wire stream —
   * the cross-principal isolation evidence. Must be empty. */
  readonly foreignUserKeys: Record<string, string[]>;
  /** Executor candidate/diagnostic events, histogrammed — the per-arm
   * detail behind the stats object. */
  readonly executorEvents: Record<string, number>;
};

const send = async (
  client: GateClient,
  resultLink: unknown,
  handler: string,
  event: unknown,
): Promise<void> => {
  const { error } = await client.runtime.editWithRetry((tx) => {
    client.runtime
      // deno-lint-ignore no-explicit-any
      .getCellFromLink(resultLink as any)
      .withTx(tx)
      .key(handler as never)
      .send(event as never);
  });
  if (error !== undefined) {
    throw new Error(`send(${handler}) failed: ${String(error)}`);
  }
  await client.runtime.idle();
  await client.runtime.settled();
  await client.storage.synced();
};

/** The rank-ladder arms. `space` is today's deployed default (whole bundle
 * off); `user` is the C1.5a step §5f asks about; `session` is the C2.5 step
 * above it, included because the product carries PerSession state
 * (`hostMessageDraft`, `roomDraft`) that a user lane cannot route. */
type RankArm = "space" | "user" | "session";

const runArm = async (rank: RankArm): Promise<ArmReport> => {
  const dials = rank !== "space";
  const flags: Partial<MemoryProtocolFlags> = dials
    ? { ...BASE_FLAGS, serverPrimaryExecutionContextLatticeClaimsV1: true }
    : { ...BASE_FLAGS };
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const storeDir = await Deno.makeTempDir({
    prefix: `group-chat-rank-${rank}-`,
  });
  if (dials) setServerPrimaryExecutionClaimRankConfig(rank);
  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-group-chat-user-rank" },
    protocolFlags: flags,
    acl: { mode: "off", serviceDids: [space] },
  });
  let alice: GateClient | null = null;
  let bob: GateClient | null = null;
  let pool: SharedExecutionPool | null = null;
  const events: string[] = [];
  try {
    alice = await openProbeClient(server, flags);
    bob = await openProbeClient(server, flags);

    // Alice seeds and runs the product; Bob resumes the same piece — the
    // C1.9 two-principal shape (Alice is deterministically the demand
    // sponsor, so her lane is the sponsor-overlap case).
    const program = await alice.runtime.harness.resolve(
      new FileSystemProgramResolver(GROUP_CHAT, PATTERNS_ROOT),
    );
    const compiled = await alice.runtime.patternManager.compilePattern(
      program,
      { space },
    );
    const tx = alice.runtime.edit();
    const result = alice.runtime.getCell<Record<string, unknown>>(
      space,
      "group-chat-user-rank-result",
      undefined,
      tx,
    );
    const handle = alice.runtime.run(tx, compiled, {}, result);
    alice.runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await alice.runtime.settled();
    await alice.storage.synced();
    const resultLink = result.getAsNormalizedFullLink();

    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
        ...(dials ? { serverPrimaryExecutionUserRankCandidates: true } : {}),
        ...(rank === "session"
          ? { serverPrimaryExecutionSessionRankCandidates: true }
          : {}),
      },
      // Wire the SAME two recorders toolshed wires (routes/storage/memory.ts)
      // — they are what populates `executionStats.candidateClaimReadyBySpace`
      // and `candidateUnservedByCode`, i.e. the `/api/health/stats` inventory
      // this probe exists to report. Without them the stats read all-zero
      // however engaged the run actually is.
      onCandidateClaim: (candidate) => {
        server.recordExecutionCandidateClaimReady(candidate.claimKey);
        events.push(`candidate:${candidate.claimKey.contextKey}`);
      },
      onCandidateDiagnostic: (diagnostic) => {
        server.recordExecutionCandidateUnserved(diagnostic);
        events.push(
          `diagnostic:${diagnostic.diagnosticCode}:${
            diagnostic.claimKey?.contextKey ?? "?"
          }`,
        );
      },
    });
    // Keep a handle on the live executor. The pool deliberately does NOT wake
    // an executor that is already live (`#acceptAcceptedCommit` returns early
    // on `slot.executor !== null`) — a live Worker is expected to notice
    // invalidations through its own replica, and the pool's wake path exists
    // only to start or unpark one. Driving the Worker's `settle()`/`wake()`
    // fixpoint explicitly is what
    // `runner/test/server-execution-rollout-products.test.ts` does for this
    // same product, and it is what turns the demand into actual scheduler
    // runs.
    let liveExecutor: SpaceExecutor | undefined;
    pool = new SharedExecutionPool({
      control: server,
      factory: {
        async start(options) {
          liveExecutor = await factory.start({
            ...options,
            onCrash(error) {
              events.push(`crash:${String(error)}`);
              options.onCrash(error);
            },
          });
          return liveExecutor;
        },
      },
      settleTimeoutMs: 20_000,
      userLaneCandidates: dials,
      sessionLaneCandidates: rank === "session",
      legacyBackgroundActive: () => false,
    });
    pool.start();

    // deno-lint-ignore no-explicit-any
    const aliceRoot = alice.runtime.getCellFromLink(resultLink as any);
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
    assertExists(
      liveExecutor,
      "the pool reported a live worker with no executor",
    );
    // Drive the Worker's activation to its fixpoint before any client work:
    // `set-demand` only enqueues the structural swap, and activation
    // completion is observable ONLY through `settle()` (see the executor
    // Worker's `set-demand` docblock).
    await liveExecutor.settle();

    // Bob attaches after the sponsor lease exists.
    // deno-lint-ignore no-explicit-any
    const bobRoot = bob.runtime.getCellFromLink(resultLink as any);
    await bobRoot.sync();
    assertEquals(await bob.runtime.start(bobRoot), true);
    await bob.runtime.settled();

    // The workload: each principal names themselves and posts once. The
    // profile label is the product's own PerUser derivation — the offender
    // class §5f named — so this is the smallest workload that exercises the
    // exact thing the dial is supposed to serve.
    for (
      const [client, name] of [
        [alice, "Alice"],
        [bob, "Bob"],
      ] as const
    ) {
      await send(client, resultLink, "setProfileDraft", name);
      await send(
        client,
        resultLink,
        "saveProfile",
        trustedEvent(PROFILE_SURFACE, SAVE_PROFILE_ACTION),
      );
      await send(client, resultLink, "setMessageDraft", `hello from ${name}`);
      await send(
        client,
        resultLink,
        "sendTrustedMessage",
        trustedEvent(SEND_SURFACE, SEND_ACTION),
      );
    }
    // One wake/settle round per client invalidation batch: pull the demanded
    // roots at the new basis, then run to fixpoint.
    await liveExecutor.wake();
    await liveExecutor.settle();
    await pool.idle();

    const profileNames: Record<string, unknown> = {};
    for (
      const [label, client] of [
        ["alice", alice],
        ["bob", bob],
      ] as const
    ) {
      profileNames[label] = await readGateKey(
        client,
        resultLink,
        "currentProfileName",
      );
    }
    const messages = await readGateKey(alice, resultLink, "messages") as
      | readonly unknown[]
      | undefined;

    const foreignUserKeys: Record<string, string[]> = {
      alice: alice.wireKeys.filter((key) => key === bob!.userLaneKey),
      bob: bob.wireKeys.filter((key) => key === alice!.userLaneKey),
    };

    const metrics = pool.metrics() as unknown as Record<string, unknown>;
    const executorMetrics = liveExecutor.executionMetrics?.();
    return {
      rank,
      dials,
      metrics: JSON.parse(JSON.stringify(metrics)),
      executorMetrics: JSON.parse(JSON.stringify(executorMetrics ?? {})),
      negotiatingDemands: server.listExecutionDemands(space, "").filter((
        demand,
      ) =>
        (demand as { negotiatesContextLatticeClaims?: boolean })
          .negotiatesContextLatticeClaims === true
      ).length,
      stats: JSON.parse(JSON.stringify(server.executionStats)),
      profileNames,
      messageCount: messages?.length ?? 0,
      foreignUserKeys,
      executorEvents: events.reduce<Record<string, number>>((counts, event) => {
        counts[event] = (counts[event] ?? 0) + 1;
        return counts;
      }, {}),
    };
  } finally {
    await pool?.close().catch(() => undefined);
    await alice?.runtime.dispose().catch(() => undefined);
    await alice?.storage.close().catch(() => undefined);
    await bob?.runtime.dispose().catch(() => undefined);
    await bob?.storage.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (dials) resetServerPrimaryExecutionClaimRankConfig();
    await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
  }
};

const reportArm = (report: ArmReport): void => {
  console.log(
    `group-chat user-rank probe [rank=${report.rank}]\n` +
      `  profileNames=${JSON.stringify(report.profileNames)} ` +
      `messages=${report.messageCount}\n` +
      `  negotiatingDemands=${report.negotiatingDemands} ` +
      `activeUserLanes=${report.metrics.activeUserLanes} ` +
      `activeSessionLanes=${report.metrics.activeSessionLanes} ` +
      `userLanesOpened=${report.metrics.userLanesOpened} ` +
      `poolSchedulerRuns=${
        (report.metrics.executionPlacement as { schedulerRuns?: number })
          ?.schedulerRuns
      }\n` +
      `  executorMetrics=${JSON.stringify(report.executorMetrics)}\n` +
      `  executorEvents=${JSON.stringify(report.executorEvents)}\n` +
      `  executionStats=${JSON.stringify(report.stats)}`,
  );
};

/** Distinct offender actions per unserved code — the `×N offenders` number
 * the §5f inventory quotes, straight off the server's own accounting. */
const offenders = (arm: ArmReport): Record<string, number> =>
  (arm.stats.candidateUnservedOffendersByCode ?? {}) as Record<string, number>;

const unservedEvents = (arm: ArmReport): Record<string, number> =>
  (arm.stats.candidateUnservedByCode ?? {}) as Record<string, number>;

Deno.test({
  name:
    "group-chat rank probe: two principals up the rank ladder, adjacent arms (§5f follow-up)",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      const space = await runArm("space");
      reportArm(space);
      const user = await runArm("user");
      reportArm(user);
      const session = await runArm("session");
      reportArm(session);
      const off = space;
      const on = user;

      for (const arm of [space, user, session]) {
        const label = arm.rank;
        // Per-user value correctness: each principal reads its OWN label.
        assertEquals(
          arm.profileNames,
          { alice: "Alice", bob: "Bob" },
          `[${label}] a principal read the wrong PerUser profile label`,
        );
        assertEquals(
          arm.messageCount,
          2,
          `[${label}] the trusted sends did not both land`,
        );
        // Cross-principal isolation at the delivery seam: neither client's
        // wire stream ever carried the other principal's user scope key.
        assertEquals(
          arm.foreignUserKeys,
          { alice: [], bob: [] },
          `[${label}] a foreign user-scope key reached a client`,
        );
      }

      // The dial bundle is the discriminator, observed live on the real
      // product: OFF, no session negotiates the subcapability and no user
      // lane can open; ON, both principals' sessions negotiate it and the
      // host opens a lane for each — the C1.7 cohort gate, the C1.3 lane
      // grants, and the C1.8 pool lifecycle all engaging on group-chat.
      assertEquals(
        [off.negotiatingDemands, off.metrics.activeUserLanes],
        [0, 0],
        "a user lane opened with the dial bundle off",
      );
      assertEquals(
        [on.negotiatingDemands, on.metrics.activeUserLanes],
        [2, 2],
        "the dial bundle did not open a user lane per principal",
      );

      // Every arm must actually have SERVED the product — the whole point of
      // this file. A zero here means the Worker never ran the piece and every
      // counter below is vacuous.
      for (const arm of [space, user, session]) {
        const runs =
          (arm.executorMetrics as { schedulerRuns?: number }).schedulerRuns ??
            0;
        assertEquals(
          runs > 0 &&
            ((arm.stats as Record<string, number>).claimsIssued ?? 0) > 0,
          true,
          `[${arm.rank}] the executor never served the product: runs=${runs} ` +
            `stats=${JSON.stringify(arm.stats)}`,
        );
        // No settlement may FAIL and no attempt may be refused by the engine's
        // firewall, at any rank.
        const stats = arm.stats as Record<string, number>;
        assertEquals(
          [stats.settlementsFailed ?? 0, stats.actionFirewallRejects ?? 0],
          [0, 0],
          `[${arm.rank}] a settlement failed or an attempt was firewalled: ${
            JSON.stringify(arm.stats)
          }`,
        );
      }

      // THE BUY, live: the scoped-read offender class §5f named collapses as
      // the ladder climbs, and claim-readiness rises with it.
      const readScope = (arm: ArmReport) =>
        offenders(arm)["non-space-read-scope"] ?? 0;
      assertEquals(
        readScope(user) < readScope(space) &&
          readScope(session) <= readScope(user),
        true,
        `non-space-read-scope offenders did not fall up the ladder: ` +
          `space=${readScope(space)} user=${readScope(user)} ` +
          `session=${readScope(session)}`,
      );

      // R7's acceptance criterion — `claim-context-mismatch` hard-zero, the
      // cause C2.10 retired from TOLERATED_LEASE_FENCE_CAUSES (see
      // server-execution-measurement.ts).
      //
      // This probe originally MEASURED that criterion failing on the real
      // product (5-6 → 2 → 2 up the ladder). The diagnosis and fix are in
      // client-passivity §5g: an unclaimed CLIENT run durably narrows the
      // action's monotonic context floor; the executor, which classifies from
      // the current observation's surfaces alone, keeps proposing a broader
      // rank; and nothing consulted the floor until commit time. The host now
      // declines such a claim at ISSUANCE
      // (`#assertExecutionClaimContextFloorAdmits`).
      //
      // Pinned at the SCOPED ranks, where a lane exists and the criterion
      // applies. The `space` arm is NOT pinned to zero: with no lane at all
      // it can still fence on the one case issuance cannot see — a floor
      // narrowed between issuance and commit — which is exactly what the
      // engine fence remains the backstop for.
      const fences = (arm: ArmReport) =>
        ((arm.stats.leaseFenceRejectCauses ?? {}) as Record<string, number>)[
          "claim-context-mismatch"
        ] ?? 0;
      assertEquals(
        [fences(user), fences(session)],
        [0, 0],
        `R7: claim-context-mismatch is not hard-zero at the scoped ranks — ` +
          `space=${fences(space)} user=${fences(user)} ` +
          `session=${fences(session)}`,
      );
      assertEquals(
        fences(space) <= 2,
        true,
        `the space arm fenced more than the issuance→commit race explains: ` +
          `${fences(space)}`,
      );

      console.log(
        `group-chat rank probe LADDER\n` +
          `  claimsIssuedByContextKey: ${
            [space, user, session].map((a) =>
              `${a.rank}=${JSON.stringify(a.stats.claimsIssuedByContextKey)}`
            ).join(" ")
          }\n` +
          `  claimsIssued/attempts/conflicts/committed: ${
            [space, user, session].map((a) => {
              const s = a.stats as Record<string, number>;
              return `${a.rank}=${s.claimsIssued}/${s.acceptedActionAttempts}/` +
                `${s.claimedActionConflicts}/${s.settlementsCommitted}`;
            }).join(" ")
          }\n` +
          `  unservedByCode: ${
            [space, user, session].map((a) =>
              `${a.rank}=${JSON.stringify(unservedEvents(a))}`
            ).join(" ")
          }\n` +
          `  offendersByCode: ${
            [space, user, session].map((a) =>
              `${a.rank}=${JSON.stringify(offenders(a))}`
            ).join(" ")
          }\n` +
          `  claimContextMismatchFences: ${
            [space, user, session].map((a) => `${a.rank}=${fences(a)}`).join(
              " ",
            )
          }`,
      );
    });
  },
});
