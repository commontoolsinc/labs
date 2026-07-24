/**
 * C3.11 — the composed two-space cross-space-READ gate (context-lattice §7 C3
 * gate; the FINAL acceptance of the C3 phase).
 *
 * WHAT THIS BINDS (honest scope — read carefully). This is the FIRST
 * composition of the C3 cross-space-read mechanism with a REAL authored pattern
 * and REAL Deno executor Workers. Every lower C3 WO built its evidence with
 * hand-authored claimed commits / scripted observation shapes (the memory +
 * runner fixtures HAND-ATTACH `foreignReadStamps` to the claimed observation);
 * this gate drives the authored `computed` that reads a foreign space through
 * the SharedExecutionPool and a real `executor-worker.ts`.
 *
 * The AUTHORED cross-space-read pattern shape (the crux the handoff flagged as
 * the risk) EXISTS and composes: a space-scoped `computed` (`doubled`) bound to
 * a cell that lives in a DIFFERENT space (`source` → space B) produces an
 * observation whose read address names space B, which the C3.6 servability
 * stage admits (`crossSpaceReadSpaces=[B]`). The gate proves the full ISSUANCE +
 * DELIVERY + SUBSCRIPTION + SERVED-FOREIGN-READ + WAKE pipeline composes end to
 * end through real Workers:
 *   1. the Worker emits a cross-space-read CANDIDATE at space rank naming B;
 *   2. the host ISSUES a cross-space-read claim (binding the acting principal's
 *      B READ at the C3A17 issuance preflight — the CA4/C3A17 ordering
 *      invariant, composed);
 *   3. the claim is DELIVERED to the negotiating client (the C3.6b delivery
 *      cohort gate, composed) and NOT to a non-negotiating one;
 *   4. the foreign-reader SUBSCRIPTION forms (home A → read B);
 *   5. the Worker's claimed run SERVES the authenticated foreign point read and
 *      the host VALIDATES the resulting vector-basis component
 *      (`foreignBasisComponentsValidated`) — this is what the C3.11 executor fix
 *      below unblocks (red-first: 0 without the fix, ≥1 with it);
 *   6. a space-B commit WAKES the home reader (the C3.3a foreign wake, composed).
 *
 * WHAT IS NOT COMPOSED HERE (and why — do NOT read this file as binding these):
 * driving the chain all the way to a COMMITTED server settlement that the
 * client drops its overlay for (clause (a)'s tail) and the revocation / fence /
 * write-authoritative / mixed-version / both-halves-wake clauses (b)–(f) is
 * NOT achievable at the patterns level today. A real integration defect blocks
 * it (see the report + the `INTEGRATION-DEFECT` note below): the composed
 * committed-settlement serve is fenced by a residual session-floor /
 * claim-context-mismatch interaction and a client foreign-replica resync gap
 * that live below the patterns layer. Each of clauses (a-tail)–(f) is bound
 * today by a memory/runner fixture (the fixture map is in the report); this
 * gate deliberately does NOT re-assert them against the broken composed path
 * (no fake green).
 *
 * INTEGRATION-DEFECT (found + partially fixed at the root):
 *   `packages/runner/src/executor/executor-worker.ts` populated the read-only
 *   foreign mount ONLY on a foreign WAKE (`refreshForeignMountForWake`), never
 *   before the INITIAL claimed run of a cross-space-read action. So that first
 *   run read the foreign source through the home mirror with NO served-point-
 *   read stamp, `foreignReadStampsForAction` yielded nothing, the accepted
 *   observation floored at session (the conservative no-provenance posture), and
 *   the SPACE-rank claim fenced it `claim-context-mismatch`. The fix
 *   (`hydrateForeignReadMount`, called from `startClaimedAction`, gated on
 *   `claim.crossSpaceReadSpaces` so same-space is byte-identical) makes the
 *   first claimed run STAMPED — `foreignBasisComponentsValidated` goes 0→1, the
 *   assertion below. A residual, deeper interaction (a separately-classified
 *   unserved rerun still floors session, and the client's foreign replica does
 *   not resync the read-space change to recompute/suppress) keeps the full
 *   committed serve from completing; it is characterized in the report, not
 *   faked green here.
 *
 * TRANSPORT: the in-process leg (one Server hosting A+B over the default
 * InProcessCrossSpaceTransport) is asserted here. The co-hosted transport leg
 * (two Servers + `crossSpaceLinkSocketPair` + `CoHostedCrossSpaceTransport`) is
 * bound at the memory level by v2-execution-cross-space-cohosted{,-c3-10b}-test
 * — the composed serve it would layer on is blocked by the same defect, so
 * re-crossing it here would be the same non-green; the transport crossing itself
 * (mirror/wake/point-read over the link) is those fixtures' contract.
 *
 * CI-budget clause (C3A23): named runtime ceiling in this header —
 * CROSS_SPACE_GATE_BUDGET_MS below, logged per test; the suite stays a single
 * default-run test on the patterns-integration shard (no separate shard).
 *
 * Barrier-driven (bounded polls over monotone server counters, no fixed sleeps
 * on the assertion path); FW7 `withExecutorTeardownBarrier`.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionClaimRankConfig,
  resetServerPrimaryExecutionCrossSpaceClaimsConfig,
  setServerPrimaryExecutionClaimRankConfig,
  setServerPrimaryExecutionCrossSpaceClaimsConfig,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Runtime } from "@commonfabric/runner";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { SharedExecutionPool } from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  waitForCondition,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";

/** CI-budget ceiling (C3A23): the whole suite must complete within this
 * wall-clock, keeping the patterns-integration shard bounded (no own shard). */
const CROSS_SPACE_GATE_BUDGET_MS = 90_000;

const PATTERNS_ROOT = join(import.meta.dirname!, "..");
const FIXTURE_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "cross-space-reader",
  "main.tsx",
);

const AUDIENCE = "did:key:z6Mk-xsp-gate-audience";
const SOURCE_NAME = "xsp-gate-source";

/** The C3 gate flags: the C2 negotiated set (C1.7/C2.3 subcapabilities) plus the
 * C3.6b cross-space subcapability every gate session negotiates. */
const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
  serverPrimaryExecutionCrossSpaceClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

/** The routing-but-NON-cross-space negotiated set (C3.6b mixed cohort): the
 * cross-space subcapability dropped. A session on these flags must NOT receive a
 * cross-space-read claim (the delivery-gate discrimination). */
const FLAGS_NON_CROSS_SPACE = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

// ---------------------------------------------------------------------------
// Wire taps: the claim delivery (`session.execution.claim.set`) carries the
// cross-space-read claim to the negotiating client — the composed-level view of
// the C3.6b delivery cohort gate.
// ---------------------------------------------------------------------------

type ClaimSet = {
  actionId: string;
  contextKey: string;
  crossSpaceReadSpaces?: readonly string[];
};

const collectClaimSets = (value: unknown, into: ClaimSet[]): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectClaimSets(entry, into);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "session.execution.claim.set" && record.claim) {
    const claim = record.claim as ClaimSet;
    into.push({
      actionId: claim.actionId,
      contextKey: claim.contextKey,
      crossSpaceReadSpaces: claim.crossSpaceReadSpaces,
    });
  }
  for (const entry of Object.values(record)) collectClaimSets(entry, into);
};

// ---------------------------------------------------------------------------
// Space-routing loopback client. The deterministic in-realm analog of the
// production `cache.deno` StorageManager's `memoryHost` + `spaceHostMap`
// resolver (`createStorageAddressResolver` / v2-remote-session.ts): each space
// resolves to its OWN host. For the in-process leg both spaces resolve to one
// Server; the routing seam is where a co-hosted leg would resolve space B to
// host B. Loopback (not WebSocket) keeps the gate barrier-driven with no network
// timing — the cross-space MECHANISM under test is independent of the client
// transport.
// ---------------------------------------------------------------------------

class RoutingSessionFactory implements SessionFactory {
  readonly supportsExecutionDemand = true;

  constructor(
    private readonly serverForSpace: (space: string) => Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onServerMessage?: (message: unknown) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const inner = MemoryClient.loopback(this.serverForSpace(space));
    const tap = this.onServerMessage;
    const transport: typeof inner = tap === undefined ? inner : {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (next: (payload: string) => void) => {
        inner.setReceiver((payload) => {
          try {
            tap(decodeMemoryBoundary(payload));
          } catch {
            // A payload the boundary cannot decode is the client's problem.
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
    return { client, session };
  }
}

class RoutingStorageManager extends StorageManager {
  static connect(
    serverForSpace: (space: string) => Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<StorageOptions, "memoryHost" | "spaceHostMap">,
    onServerMessage?: (message: unknown) => void,
  ): RoutingStorageManager {
    return new RoutingStorageManager(
      { ...options, memoryHost: new URL("memory://xsp-gate") },
      new RoutingSessionFactory(serverForSpace, flags, onServerMessage),
    );
  }
}

type GateClient = {
  identity: Identity;
  did: string;
  storage: RoutingStorageManager;
  runtime: Runtime;
  claimSets: ClaimSet[];
};

const openClient = (
  serverForSpace: (space: string) => Server,
  identity: Identity,
  serverPrimary: boolean,
  flags: Partial<MemoryProtocolFlags> = FLAGS,
): GateClient => {
  const claimSets: ClaimSet[] = [];
  const storage = RoutingStorageManager.connect(
    serverForSpace,
    flags,
    { as: identity },
    (message) => collectClaimSets(message, claimSets),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      ...(serverPrimary ? { serverPrimaryExecution: true } : {}),
    },
  });
  return { identity, did: identity.did(), storage, runtime, claimSets };
};

/** Raw memory-client ACL helper (the enforce-mode ACL the cross-space read
 * preflight binds against). */
const writeAcl = async (
  server: Server,
  space: string,
  adminDid: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: FLAGS,
  });
  const session = await client.mount(
    space,
    {},
    (_space, _session, context) => ({
      invocation: { aud: context.audience, challenge: context.challenge.value },
      authorization: { principal: adminDid },
    }),
  );
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: `of:${space}`, value: { value: acl } }],
  });
  await client.close();
};

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "C3.11 cross-space-read gate [in-process]: authored foreign read composes issuance + delivery + subscription + served point read + wake",
  async fn() {
    const startedAt = performance.now();
    await withExecutorTeardownBarrier(async () => {
      setServerPrimaryExecutionClaimRankConfig("cross-space-read");
      setServerPrimaryExecutionCrossSpaceClaimsConfig(true);
      const storeDir = await Deno.makeTempDir({ prefix: "xsp-gate-inproc-" });
      try {
        await runInProcessGate(storeDir);
      } finally {
        resetServerPrimaryExecutionClaimRankConfig();
        resetServerPrimaryExecutionCrossSpaceClaimsConfig();
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
    const elapsed = performance.now() - startedAt;
    console.log(`C3.11 cross-space gate elapsed ${Math.round(elapsed)}ms`);
    assert(
      elapsed < CROSS_SPACE_GATE_BUDGET_MS,
      `CI budget (C3A23): the gate took ${
        Math.round(elapsed)
      }ms, ceiling ${CROSS_SPACE_GATE_BUDGET_MS}ms`,
    );
  },
});

async function runInProcessGate(storeDir: string): Promise<void> {
  const admin = await Identity.generate({ implementation: "noble" });
  const readerId = await Identity.generate({ implementation: "noble" });
  const writerId = await Identity.generate({ implementation: "noble" });
  const nonNegId = await Identity.generate({ implementation: "noble" });
  const spaceA = (await Identity.generate({ implementation: "noble" }))
    .did() as MemorySpace;
  const spaceB = (await Identity.generate({ implementation: "noble" }))
    .did() as MemorySpace;

  const server = new Server({
    store: new URL(`file://${storeDir}/`),
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: AUDIENCE },
    protocolFlags: FLAGS,
    acl: { mode: "enforce", serviceDids: [admin.did()] },
  });
  const serverForSpace = (_space: string) => server;

  let pool: SharedExecutionPool | null = null;
  let reader: GateClient | null = null;
  let writer: GateClient | null = null;
  let nonNeg: GateClient | null = null;
  const candidateEvents: Array<
    {
      contextKey: string;
      actionId: string;
      crossSpaceReadSpaces?: readonly string[];
    }
  > = [];

  try {
    // ACLs: A grants the reader WRITE; B grants the reader READ + the writer
    // WRITE. The reader is the acting principal whose B-READ the cross-space
    // issuance preflight (C3A17) binds.
    await writeAcl(server, spaceA, admin.did(), {
      [admin.did()]: "OWNER",
      [readerId.did()]: "WRITE",
      [nonNegId.did()]: "WRITE",
    });
    await writeAcl(server, spaceB, admin.did(), {
      [admin.did()]: "OWNER",
      [readerId.did()]: "READ",
      [writerId.did()]: "WRITE",
    });

    // B's own session pre-writes the foreign source doc (space-scoped, =21).
    writer = openClient(serverForSpace, writerId, false);
    {
      const tx = writer.runtime.edit();
      const sourceCell = writer.runtime.getCell<number>(
        spaceB,
        SOURCE_NAME,
        undefined,
        tx,
      );
      sourceCell.set(21);
      assertEquals((await tx.commit()).error, undefined);
      await writer.runtime.settled();
      await writer.storage.synced();
    }

    // The reader instantiates the authored reader pattern in A, binding
    // `source` to B's foreign cell (a genuine cross-space link).
    reader = openClient(serverForSpace, readerId, true);
    const program = await reader.runtime.harness.resolve(
      new FileSystemProgramResolver(FIXTURE_PATH, PATTERNS_ROOT),
    );
    const compiled = await reader.runtime.patternManager.compilePattern(
      program,
      { space: spaceA },
    );
    const tx = reader.runtime.edit();
    const foreignSource = reader.runtime.getCell<number>(
      spaceB,
      SOURCE_NAME,
      undefined,
      tx,
    );
    await foreignSource.sync();
    const result = reader.runtime.getCell<Record<string, unknown>>(
      spaceA,
      "xsp-gate-result",
      undefined,
      tx,
    );
    const handle = reader.runtime.run(
      tx,
      compiled,
      { source: foreignSource },
      result,
    );
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await reader.runtime.settled();
    await reader.storage.synced();

    // Pool + factory + REAL Deno Worker, cross-space-read candidates on.
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      patternApiUrl: new URL("https://toolshed.example/"),
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
        serverPrimaryExecutionUserRankCandidates: true,
        serverPrimaryExecutionSessionRankCandidates: true,
        serverPrimaryExecutionCrossSpaceReadCandidates: true,
      },
      onCandidateClaim: (candidate) => {
        candidateEvents.push({
          contextKey: candidate.claimKey.contextKey,
          actionId: candidate.claimKey.actionId,
          crossSpaceReadSpaces: (candidate as {
            crossSpaceReadSpaces?: readonly string[];
          }).crossSpaceReadSpaces,
        });
      },
    });
    pool = new SharedExecutionPool({
      control: server,
      factory,
      settleTimeoutMs: 10_000,
      userLaneCandidates: true,
      sessionLaneCandidates: true,
    });
    pool.start();

    const resultRoot = reader.runtime.getCellFromLink(
      // deno-lint-ignore no-explicit-any
      result.getAsNormalizedFullLink() as any,
    );
    assertEquals(await reader.runtime.start(resultRoot), true);
    await waitForCondition(
      "reader demand",
      () => server.listExecutionDemands(spaceA, "").length > 0,
      () => server.listExecutionDemands(spaceA, ""),
    );
    await pool.idle();
    await waitForCondition(
      "pool live",
      () => pool!.metrics().activeWorkers > 0,
      () => pool!.metrics(),
    );

    // ---- (2) issuance: the host issues a cross-space-read claim. ----
    await waitForCondition(
      "cross-space-read candidate + claim issued",
      () =>
        candidateEvents.some((c) =>
          c.contextKey === "space" &&
          (c.crossSpaceReadSpaces ?? []).includes(spaceB)
        ) && (server.executionStats.claimsIssuedByContextKey.space ?? 0) >= 1,
      () => ({
        candidateEvents,
        claims: server.executionStats.claimsIssuedByContextKey,
      }),
    );

    // ---- (5) served foreign point read: the host validates a vector-basis
    // component. This is what the C3.11 executor fix unblocks (red-first: 0
    // without the fix). ----
    await waitForCondition(
      "the Worker's claimed run SERVES the foreign point read (host-validated vector-basis component)",
      () => server.executionStats.foreignBasisComponentsValidated >= 1,
      () => ({
        foreignBasisComponentsValidated:
          server.executionStats.foreignBasisComponentsValidated,
        foreignBasisAssertionsStripped:
          server.executionStats.foreignBasisAssertionsStripped,
      }),
    );

    // ---- (4) subscription: the foreign-reader subscription (home A → read B)
    // forms. ----
    const foreignSubs = () => {
      const map = (server as unknown as {
        foreignReaderSubscriptionsByReadSpace: Map<
          string,
          Map<string, unknown>
        >;
      }).foreignReaderSubscriptionsByReadSpace;
      return [...(map.get(spaceB)?.keys() ?? [])];
    };
    await waitForCondition(
      "the foreign-reader subscription (home A → read B) is live",
      () => foreignSubs().some((home) => home.startsWith(spaceA)),
      () => ({ foreignSubs: foreignSubs() }),
    );

    // ---- (3) delivery: the negotiating reader RECEIVES the cross-space-read
    // claim; a non-negotiating session does NOT (the C3.6b delivery gate,
    // composed). ----
    await waitForCondition(
      "the negotiating client receives the cross-space-read claim",
      () =>
        reader!.claimSets.some((c) =>
          (c.crossSpaceReadSpaces ?? []).includes(spaceB)
        ),
      () => ({ readerClaimSets: reader!.claimSets }),
    );
    // A routing-but-non-cross-space session attaches to A: it must NOT receive
    // the cross-space-read claim (delivery narrowing / C3.6b).
    nonNeg = openClient(serverForSpace, nonNegId, false, FLAGS_NON_CROSS_SPACE);
    {
      const cell = nonNeg.runtime.getCell<Record<string, unknown>>(
        spaceA,
        "xsp-gate-result",
        undefined,
      );
      await cell.sync();
    }
    await pool.idle();
    assert(
      !nonNeg.claimSets.some((c) =>
        (c.crossSpaceReadSpaces ?? []).includes(spaceB)
      ),
      `a non-negotiating session must NOT receive the cross-space-read claim: ${
        JSON.stringify(nonNeg.claimSets)
      }`,
    );

    // ---- (6) foreign wake: a space-B commit wakes the home reader (C3.3a). ----
    const wakesBefore = pool.metrics().foreignWakeNotifications;
    {
      const tx = writer.runtime.edit();
      const sourceCell = writer.runtime.getCell<number>(
        spaceB,
        SOURCE_NAME,
        undefined,
        tx,
      );
      sourceCell.set(5);
      assertEquals((await tx.commit()).error, undefined);
      await writer.runtime.settled();
      await writer.storage.synced();
    }
    await waitForCondition(
      "a space-B commit wakes the home reader (the C3.3a foreign wake, composed)",
      () => pool!.metrics().foreignWakeNotifications > wakesBefore,
      () => ({
        wakesBefore,
        wakesNow: pool!.metrics().foreignWakeNotifications,
      }),
    );

    // Final assertions on the settled facts.
    assert(
      candidateEvents.some((c) =>
        c.contextKey === "space" &&
        (c.crossSpaceReadSpaces ?? []).includes(spaceB)
      ),
      "the Worker must emit a space-rank cross-space-read candidate naming B",
    );
    assertEquals(
      (server.executionStats.claimsIssuedByContextKey.space ?? 0) >= 1,
      true,
      "the host must issue a space-rank claim",
    );
    assert(
      server.executionStats.foreignBasisComponentsValidated >= 1,
      "the Worker's claimed run must serve the foreign point read (C3.11 fix)",
    );

    console.log(
      "C3.11 cross-space gate [in-process] composed:",
      JSON.stringify({
        candidate: candidateEvents.find((c) =>
          (c.crossSpaceReadSpaces ?? []).includes(spaceB)
        ),
        claimsIssued: server.executionStats.claimsIssuedByContextKey,
        foreignBasisComponentsValidated:
          server.executionStats.foreignBasisComponentsValidated,
        foreignReaderSubscriptions: foreignSubs().length,
        readerReceivedCrossSpaceClaim: reader.claimSets.some((c) =>
          (c.crossSpaceReadSpaces ?? []).includes(spaceB)
        ),
        foreignWakeNotifications: pool.metrics().foreignWakeNotifications,
      }),
    );
  } finally {
    await pool?.close();
    await reader?.storage.close().catch(() => undefined);
    await writer?.storage.close().catch(() => undefined);
    await nonNeg?.storage.close().catch(() => undefined);
    await server.close();
  }
}
