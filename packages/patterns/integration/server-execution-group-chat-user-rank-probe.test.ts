/**
 * §5f follow-up, LIVE half: the group-chat product driven by TWO principals
 * against a real server with the user-rank dial bundle ON, so the memo can
 * quote engagement counters and an unserved-inventory delta from a run
 * instead of from a classifier.
 *
 * The classification half is `runner/test/server-execution-group-chat-rank-
 * probe.test.ts` (router seam, one principal, no server). This file is the
 * other half of the same question: a real memory-v2 Server with a file-backed
 * store, the real SharedExecutionPool driving a REAL Deno executor Worker, and
 * one real client Runtime per principal over the loopback transport — the
 * C2.9/C2.10 gate topology, which is the only topology where the rank dials
 * can be flipped at all (see the memo's CA4 audit: every dial in the bundle is
 * programmatic-only, and the browser client has no way to negotiate
 * `context-lattice-claims-v1`, so the two-browser leg cannot host this
 * measurement today).
 *
 * ARMS. Two adjacent arms over one identical workload, the dial bundle as the
 * only difference:
 *   - OFF: `protocolFlags` without `serverPrimaryExecutionContextLatticeClaims
 *     V1`, claim rank left at its `space` default, `serverPrimaryExecution
 *     UserRankCandidates` off. This is what a deployment runs today.
 *   - ON: the full bundle — cohort advertisement, claim rank `user`, and the
 *     runner-side candidate dial on the factory and the pool.
 * Each arm gets its own Server, its own fresh store directory, and its own
 * pool/Worker, so no state crosses between them.
 *
 * WHAT IS ASSERTED. The properties that must hold whatever the counters say:
 * each principal reads its OWN profile name (the product's PerUser label),
 * neither principal's wire stream ever carries the other's `user:` scope key
 * (cross-principal isolation, the A2 property at the delivery seam), no
 * settlement fails and no lease fences in either arm, and — the dial-bundle
 * discriminator — the OFF arm opens ZERO user lanes while the ON arm opens
 * exactly one per principal.
 *
 * WHAT IS REPORTED, NOT ASSERTED. `server.executionStats` (the same object
 * `/api/health/stats` serves) and the pool metrics, printed per arm so a
 * re-run reproduces the memo's numbers. Counters move with load and with the
 * product; pinning them would convert an unrelated change into a failure of
 * this file.
 *
 * KNOWN GAP, recorded at the assertion site below and in the memo's §5g: in
 * this topology the executor Worker goes live and takes both lanes but never
 * runs the piece's actions, so no claim is issued in either arm and the
 * `candidateUnservedByCode` inventory stays empty. The claim/settlement half
 * of the user-rank question is therefore still open.
 */

import { assertEquals } from "@std/assert";
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
import { SharedExecutionPool } from "@commonfabric/runner/executor";
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
  readonly dials: boolean;
  readonly metrics: Record<string, unknown>;
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

const runArm = async (dials: boolean): Promise<ArmReport> => {
  const flags: Partial<MemoryProtocolFlags> = dials
    ? { ...BASE_FLAGS, serverPrimaryExecutionContextLatticeClaimsV1: true }
    : { ...BASE_FLAGS };
  const spaceIdentity = await Identity.generate({ implementation: "noble" });
  const space = spaceIdentity.did() as MemorySpace;
  const storeDir = await Deno.makeTempDir({
    prefix: `group-chat-user-rank-${dials ? "on" : "off"}-`,
  });
  if (dials) setServerPrimaryExecutionClaimRankConfig("user");
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
    pool = new SharedExecutionPool({
      control: server,
      factory: {
        async start(options) {
          return await factory.start({
            ...options,
            onCrash(error) {
              events.push(`crash:${String(error)}`);
              options.onCrash(error);
            },
          });
        },
      },
      settleTimeoutMs: 20_000,
      userLaneCandidates: dials,
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
    return {
      dials,
      metrics: JSON.parse(JSON.stringify(metrics)),
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
    `group-chat user-rank probe [dials=${report.dials ? "ON" : "OFF"}]\n` +
      `  profileNames=${JSON.stringify(report.profileNames)} ` +
      `messages=${report.messageCount}\n` +
      `  negotiatingDemands=${report.negotiatingDemands} ` +
      `activeUserLanes=${report.metrics.activeUserLanes} ` +
      `userLanesOpened=${report.metrics.userLanesOpened} ` +
      `schedulerRuns=${
        (report.metrics.executionPlacement as { schedulerRuns?: number })
          ?.schedulerRuns
      }\n` +
      `  executorEvents=${JSON.stringify(report.executorEvents)}\n` +
      `  executionStats=${JSON.stringify(report.stats)}`,
  );
};

Deno.test({
  name:
    "group-chat user-rank probe: two principals, dials OFF then ON, adjacent arms (§5f follow-up)",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      const off = await runArm(false);
      reportArm(off);
      const on = await runArm(true);
      reportArm(on);

      for (const arm of [off, on]) {
        const label = arm.dials ? "ON" : "OFF";
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

      // Whatever engagement the arm reached, it must not have failed a
      // settlement or fenced a lease.
      for (const arm of [off, on]) {
        const stats = arm.stats as Record<string, number>;
        const label = arm.dials ? "ON" : "OFF";
        assertEquals(
          [stats.settlementsFailed ?? 0, stats.leaseFenceRejects ?? 0],
          [0, 0],
          `[${label}] a settlement failed or a lease fenced: ${
            JSON.stringify(arm.stats)
          }`,
        );
      }

      // KNOWN GAP, reported not asserted (see the memo's §5g): in THIS
      // topology the executor Worker goes live and takes both lanes but
      // never runs the piece's actions (`executionPlacement.schedulerRuns`
      // stays 0), so no claim is issued in either arm and the
      // `candidateUnservedByCode` inventory stays empty. The classification
      // half of this question therefore lives in
      // `runner/test/server-execution-group-chat-rank-probe.test.ts`, and
      // the live claim/settlement half is still covered only by the C1.9
      // synthetic PerUser gates. Getting group-chat SERVED in-process needs
      // the `server-execution-rollout-products.test.ts` sequencing (worker-
      // realm clients plus an observer graph watch), which is the follow-up.
      const placement = on.metrics.executionPlacement as {
        schedulerRuns?: number;
      };
      console.log(
        `group-chat user-rank probe: KNOWN GAP — dials-ON executor ` +
          `schedulerRuns=${placement?.schedulerRuns} ` +
          `claimsIssued=${(on.stats as Record<string, number>).claimsIssued}`,
      );
    });
  },
});
