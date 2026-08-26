// The SpaceServer's space-root ensure seat (OW45 arm-B server-ensure
// STAGE 1; design PR #6209 §1/§9): at activation the tenure owes the
// space one lease-guarded, single-flight root ensure — existence +
// freshness, no start — run as the first serialized step of the wave
// loop's first cycle. The pins are the design's §9 stage-1 subset:
//
// - a fresh OWNED space's activation materializes `defaultPattern` and
//   the root, provenance-stamped from the space-type source (watched
//   RED before the seat existed: the root never appeared);
// - park/re-activate converges on ONE root (the OCC/address invariant)
//   and an aged root's re-activation reconciles the obsolete
//   patternIdentity before anything loads it (the updater-ordering
//   half, at the seat);
// - the ensure's creation transaction carries the resolved OWNER's CFC
//   trust snapshot — never the ambient service snapshot (the OW59 Q3
//   caveat's named follow-up, design §4(b)); asserted on the LIVE
//   transaction the ensure minted, since the fixture patterns declare
//   no ifc labels for a store-side label audit to read;
// - a space with NO resolvable ACL owner SKIPS fail-closed: counted,
//   root left absent, tenure serving — never the service DID as
//   fallback (OW53's shape).
//
// The OFF witness for this seat is structural — the ensure's only
// caller is SpaceServer.activate, the SpaceServer's only builder is the
// ExecutorHost, and the host exists only under
// EXPERIMENTAL_SERVER_EXECUTION (packages/toolshed/lib/
// server-execution.test.ts pins the flag-off bootstrap returning
// undefined) — plus activate() itself refuses a runtime without the
// flag (pinned by the stage-G suite).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime, type RuntimeFetch } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { SpaceServer } from "../src/executor/space-server.ts";
import { waveRunContextOf } from "../src/executor/wave.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../src/executor/stats.ts";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
  resolveSpaceRootPattern,
} from "../src/ensure-space-root.ts";
import {
  ACLManager,
  getEntityId,
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
} from "../src/index.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("space root ensure space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space root ensure service",
);
const aliceSigner = await Identity.fromPassphrase("space root ensure alice");
const readerSigner = await Identity.fromPassphrase("space root ensure reader");

const HOME_PATH = "/api/patterns/system/home.tsx";
const APP_PATH = "/api/patterns/system/default-app.tsx";

function rootSource(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    "const Root = pattern<Record<string, never>, { marker: string }>(" +
    `() => ({ marker: computed(() => "${marker}") }));`,
    "export default Root;",
    "",
  ].join("\n");
}

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("SpaceServer space-root ensure (OW45 arm-B stage 1)", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let files: Map<string, string>;
  let spaceServer: SpaceServer | undefined;
  let hostUnderTest: ExecutorHost | undefined;
  let mintedTxs: IExtendedStorageTransaction[];
  let stats: ServingLoopStats;
  let cleanups: Array<() => Promise<void>>;

  /** ONE localSeq counter across every SpaceServer this test builds —
   * the HOST's contract (host.ts #sinkLocalSeq: the counter is
   * process-lifetime and SURVIVES park/re-activate, because every
   * tenure's sink commits under the same process-stable session id; a
   * fresh counter per tenure re-mints (session, localSeq) pairs the
   * engine already consumed and replay detection kills the second
   * tenure's waves as "commit replay mismatch" — observed live while
   * building the aged-reconcile pin). */
  let sinkLocalSeq: { value: number };

  const identityFor = (entry: string): Promise<string> =>
    resolveEntryIdentity(entry, (name) => {
      const contents = files.get(name);
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`not found: ${name}`));
    });

  /** F2's wedge switch: when set, pattern SOURCE fetches hang forever
   * (a never-settling promise — the unbounded-remote-fetch shape the
   * ensure's deadline exists to bound). */
  let hangPatternFetches = false;

  const fetchStub: RuntimeFetch = (input, _init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const body = files.get(url.pathname);
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (hangPatternFetches && !url.searchParams.has("identity")) {
      return new Promise<Response>(() => {});
    }
    if (url.searchParams.has("identity")) {
      return identityFor(url.pathname).then((id) => new Response(id));
    }
    return Promise.resolve(new Response(body));
  };

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    engine = await server.engineForSpace(space);
    files = new Map([
      [HOME_PATH, rootSource("home-v1")],
      [APP_PATH, rootSource("app-v1")],
    ]);
    mintedTxs = [];
    stats = emptyServingLoopStats();
    sinkLocalSeq = { value: 0 };
    hangPatternFetches = false;
    spaceServer = undefined;
    cleanups = [];
  });

  afterEach(async () => {
    await hostUnderTest?.close();
    hostUnderTest = undefined;
    await spaceServer?.park("test-teardown");
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  const clientRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: manager,
      fetch: fetchStub,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return runtime;
  };

  /** Seed the space's ACL (`of:<space>`) through the SPACE IDENTITY via
   * ACLManager — the sanctioned whole-document mutation path (a
   * value-path write is refused: "mutate it through ACLManager"). */
  const seedAcl = async (
    acl: Record<string, "READ" | "WRITE" | "OWNER">,
  ): Promise<void> => {
    const runtime = clientRuntime(spaceSigner);
    const manager = new ACLManager(runtime, space as never);
    for (const [user, capability] of Object.entries(acl)) {
      await manager.set(user as never, capability);
    }
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  const newSpaceServer = (
    policyOverride?: Partial<
      NonNullable<ConstructorParameters<typeof SpaceServer>[0]["policy"]>
    >,
    options?: { ensureSpaceRoots?: boolean },
  ): SpaceServer => {
    const created = new SpaceServer({
      ...(options?.ensureSpaceRoots !== undefined
        ? { ensureSpaceRoots: options.ensureSpaceRoots }
        : {}),
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: manager,
          fetch: fetchStub,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: true,
          },
        });
        // Record every transaction the serving runtime mints, so the
        // pins can find the ensure's creation tx and read the LIVE
        // trust snapshot it carried (the rejectFirstFabricCommit
        // precedent: instance-level patching is the established seam).
        const originalEdit = runtime.edit.bind(runtime);
        runtime.edit = (() => {
          const tx = originalEdit();
          mintedTxs.push(tx);
          return tx;
        }) as typeof runtime.edit;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      localSeqRef: sinkLocalSeq,
      stats,
      policy: {
        flushDeadlineMs: 2_000,
        idleParkMs: 600_000,
        ...policyOverride,
      },
    });
    spaceServer = created;
    return created;
  };

  /** Resolve the space root through a client replica, poll-bounded:
   * the wave batch lands link + docs together, but a reader's replica
   * receives them on subscription frames, so the first resolve after
   * the link's arrival can still miss the target's meta. */
  const resolveRootEventually = async (reader: Runtime) => {
    const deadline = Date.now() + 20_000;
    while (true) {
      const root = await resolveSpaceRootPattern(reader, space);
      if (root !== undefined) return root;
      if (Date.now() > deadline) {
        throw new Error("timed out resolving the space root");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const ensureTxs = (): IExtendedStorageTransaction[] =>
    mintedTxs.filter((tx) =>
      waveRunContextOf(tx)?.actionId?.startsWith("space-root-ensure/") === true
    );

  it("activation of a fresh self-owned space materializes the root from the home source", async () => {
    await seedAcl({ [space]: "OWNER" });
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    // The ensure's writes ride the first wave; poll the DURABLE store
    // through an independent client replica.
    const reader = clientRuntime(readerSigner);
    const probe = reader.getSpaceCell(space).key("defaultPattern");
    await probe.sync();
    await waitUntil(() => probe.get() !== undefined, "root linked");

    const root = await resolveRootEventually(reader);
    expect(getPatternSource(root)).toBe(HOME_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root)?.identity).toBe(
      await identityFor(HOME_PATH),
    );
    expect(stats.rootEnsure.runs).toBe(1);
    expect(stats.rootEnsure.created).toBe(1);
    expect(stats.rootEnsure.skippedNoOwner).toBe(0);
    expect(stats.rootEnsure.failures).toBe(0);
  });

  it("park/re-activate converges on ONE root and reconciles an aged identity before anything loads it", async () => {
    await seedAcl({ [space]: "OWNER" });
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    const reader = clientRuntime(readerSigner);
    const probe = reader.getSpaceCell(space).key("defaultPattern");
    await probe.sync();
    await waitUntil(() => probe.get() !== undefined, "root linked");
    const firstRoot = await resolveRootEventually(reader);
    const agedIdentity = await identityFor(HOME_PATH);
    expect(getPatternIdentityRef(firstRoot)?.identity).toBe(agedIdentity);

    // The served source moves while the space is parked — the aged
    // space. Re-activation's ensure must swap the stored identity
    // forward as its freshness half, before any load of the obsolete
    // identity. A SpaceServer is single-tenure (park() is terminal on
    // the instance; the HOST builds a fresh one per re-activation), so
    // the second tenure is a second SpaceServer over the same engine
    // and the SAME stats object — the counters span tenures like the
    // host's do.
    await created.park("test-age");
    await created.whenParked;
    files.set(HOME_PATH, rootSource("home-v2"));
    const freshIdentity = await identityFor(HOME_PATH);
    expect(freshIdentity).not.toBe(agedIdentity);

    const second = newSpaceServer();
    expect(await second.activate()).toBe(true);
    await waitUntil(
      () => stats.rootEnsure.runs === 2,
      "second tenure's ensure",
    );
    // The server side first: the second tenure RESOLVED (created stays
    // 1 — one root ever) and its freshness half MOVED the identity.
    expect(stats.rootEnsure.created).toBe(1);
    await waitUntil(
      () => stats.rootEnsure.reconciled === 1,
      "second tenure's reconcile counted",
    );

    // Then the DURABLE outcome: a fresh replica per attempt (client
    // push freshness of meta is a different mechanism's contract; the
    // ensure's promise is the store).
    {
      const deadline = Date.now() + 20_000;
      while (true) {
        const probeReader = clientRuntime(readerSigner);
        const current = await resolveRootEventually(probeReader);
        if (getPatternIdentityRef(current)?.identity === freshIdentity) {
          expect(getEntityId(current)).toEqual(getEntityId(firstRoot));
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for aged identity reconcile");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // F1 (adversarial review of this PR): the FRESHNESS half's
    // transactions must carry the resolved OWNER's snapshot too — the
    // update arm runs `runtime.setup` on the root (the label-minting
    // class), and a transaction's birth snapshot is the AMBIENT SERVICE
    // one (`trustSnapshotProvider()`), which the updater's bookkeeping
    // stamp deliberately leaves alone. Without the ensure's hook
    // threaded through `checkDefaultPattern`, every stale space's next
    // activation restages its root AS THE SERVICE — OW59's named
    // restage shape. Asserted on the LIVE transactions the reconcile
    // minted (watched RED before the hook existed: actingPrincipal was
    // the service DID).
    const reconcileTxs = mintedTxs.filter((tx) =>
      waveRunContextOf(tx)?.actionId?.startsWith("pattern-update/") === true
    );
    expect(reconcileTxs.length).toBeGreaterThan(0);
    for (const tx of reconcileTxs) {
      const snapshot = tx.getCfcState().trustSnapshot;
      expect(snapshot?.actingPrincipal).toBe(space);
      expect(snapshot?.actingPrincipal).not.toBe(serviceSigner.did());
    }
  });

  it("a plain space-cell subscriber SURVIVES a replica that fails to absorb the cid schema docs (OW61 containment at the live producer)", async () => {
    // OW61, reshaped after the owner's reversal ruling (2026-08-24):
    // the server deliberately ELIDES cid docs a session already
    // received — not retransmitting schemas is why content addressing
    // exists — and the client's obligation is to absorb and retain
    // every frame. The defect class under investigation is a CLIENT
    // that fails that obligation (a dropped/reordered/un-retained cid
    // delivery); this step simulates exactly that at the register's
    // named deterministic producer and pins the ACKed containment ON
    // THE CRASH CLASS'S ACTUAL SEAM: the subscription is registered
    // BEFORE the ensure activates, so the mention-carrying frames
    // arrive as server pushes through the BACKGROUND consume path
    // (`consumeUpdates` → `applySessionSync`) — where the
    // pre-containment validator throw was an unhandled rejection that
    // killed the consuming worker (the OW61 board's kill mode; the
    // round-3 review's R2: routed through the request-shaped pull
    // path instead, the base throw surfaced as an ignored error
    // result and the step discriminated nothing). Red-first: this
    // step's head construction was run against the no-containment
    // base validator and died on exactly that unhandled rejection.
    await seedAcl({ [space]: "OWNER" });
    const created = newSpaceServer();

    const reader = clientRuntime(readerSigner);
    // The simulated absorb defect: DROP every cid: upsert before the
    // frame applies. Installed on the reader's replica before its
    // space-cell subscription (the suite's established instance-patch
    // seam).
    const replica = (reader.storageManager.open(space) as unknown as {
      replica: {
        applySessionSync(sync: unknown, type: string): void;
        getDocument(uri: string): unknown;
      };
    }).replica;
    let droppedCids = 0;
    const computedSeen = new Set<string>();
    const originalApply = replica.applySessionSync.bind(replica);
    replica.applySessionSync = (sync: unknown, type: string) => {
      const frame = sync as { upserts?: Array<{ id?: unknown }> };
      const upserts = Array.isArray(frame?.upserts) ? frame.upserts : [];
      const kept = upserts.filter((upsert) => {
        if (typeof upsert?.id !== "string") return true;
        if (upsert.id.startsWith("computed:")) computedSeen.add(upsert.id);
        if (upsert.id.startsWith("cid:")) {
          droppedCids += 1;
          return false;
        }
        return true;
      });
      return originalApply(
        kept.length === upserts.length
          ? sync
          : { ...(sync as object), upserts: kept },
        type,
      );
    };

    // Subscribe FIRST (this starts the background consumer), activate
    // SECOND: everything the ensure materializes reaches this replica
    // as push frames on the consume path. The liveness cell is synced
    // up front too — it rides the SAME session's consume loop, and its
    // later update is the discriminator a dead loop can never deliver.
    const probe = reader.getSpaceCell(space).key("defaultPattern");
    await probe.sync();
    const liveness = reader.getCell<{ n?: number }>(
      space,
      "ow61-containment-liveness",
      undefined,
    );
    await liveness.sync();
    expect(await created.activate()).toBe(true);

    // Producer sanity: the ensure's computed cells DID ride the plain
    // subscription as pushes, and the simulated defect DID drop cid
    // deliveries — without both, this pin is vacuously green.
    await waitUntil(
      () => computedSeen.size > 0,
      "the ensured root's computed cell riding the plain subscription",
    );
    await waitUntil(
      () => droppedCids > 0,
      "the simulated absorb defect dropping a cid delivery",
    );
    await waitUntil(
      () => stats.rootEnsure.created === 1,
      "the ensure's creation to complete beside the defective reader",
    );

    // THE PIN, half one — the consumer SURVIVED the violating push
    // frames (pre-containment: unhandled rejection in consumeUpdates,
    // nothing after this point runs) and the mention-carrying computed
    // doc is QUARANTINED, not applied: fail-closed for the doc.
    let quarantinedId: string | undefined;
    await waitUntil(
      () => {
        quarantinedId = [...computedSeen].find((id) =>
          replica.getDocument(id) === undefined
        );
        return quarantinedId !== undefined;
      },
      "a cid-mentioning computed doc held in quarantine (not applied)",
    );

    // Half two — the CONSUMER LOOP IS ALIVE, proven by delivery: a
    // writer pushes an update to the pre-synced liveness cell, and the
    // reader must SEE it arrive through the same background session.
    // Pre-containment the violating push frame's throw ended the
    // consume loop (the unhandled rejection is retained by the test
    // harness, so death is otherwise silent here — the round-3
    // review's R2), and this wait times out: the discriminator.
    // A stall anywhere in the writer path must FAIL with its name, not
    // hang the suite ahead of the named liveness wait below (Cubic P2 on
    // this PR). These are event-completions, not polls — the deadline
    // only converts a hang into a named failure, matching the suite's
    // waitUntil discipline.
    const named = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out waiting for ${label}`)),
              20_000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    {
      const writer = clientRuntime(spaceSigner);
      const writerLiveness = writer.getCell<{ n?: number }>(
        space,
        "ow61-containment-liveness",
        undefined,
      );
      await named(writerLiveness.sync(), "the writer's liveness-cell sync");
      const tx = writer.edit();
      writerLiveness.withTx(tx).set({ n: 2 });
      expect((await named(tx.commit(), "the writer's liveness commit")).error)
        .toBeUndefined();
      await named(
        writer.storageManager.synced(),
        "the writer's post-commit sync barrier",
      );
    }
    await waitUntil(
      () => (liveness.get() as { n?: number } | undefined)?.n === 2,
      "a post-quarantine push to be DELIVERED through the same consumer",
    );

    // And the request-shaped path still answers ok (pre-containment
    // the pull-path validator throw surfaced here as an error
    // result — the round-3 review's named discriminator), plus an
    // ordinary write/read round trip through the reader itself.
    const lateSync = await (reader.storageManager.open(space) as unknown as {
      sync(
        id: string,
        selector: { path: string[]; schema: boolean },
      ): Promise<{ error?: unknown }>;
    }).sync(quarantinedId!, { path: [], schema: false });
    expect(lateSync.error).toBeUndefined();
    // The request path exercised the exact quarantined doc, and the
    // quarantine held through it (its cid rode the response and was
    // dropped by the simulated defect again).
    expect(replica.getDocument(quarantinedId!)).toBeUndefined();
    const witness = reader.getCell<{ n?: number }>(
      space,
      "ow61-containment-witness",
      undefined,
    );
    await witness.sync();
    {
      const tx = reader.edit();
      witness.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
      await reader.storageManager.synced();
    }
    expect((witness.get() as { n?: number } | undefined)?.n).toBe(1);
    expect(stats.rootEnsure.failures).toBe(0);
  });

  it("the ensure's creation tx carries the resolved OWNER's trust snapshot, never the service's (granted-owner space, default-app source)", async () => {
    await seedAcl({ [aliceSigner.did()]: "OWNER" });
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    const reader = clientRuntime(readerSigner);
    const probe = reader.getSpaceCell(space).key("defaultPattern");
    await probe.sync();
    await waitUntil(() => probe.get() !== undefined, "root linked");

    // A non-self-owned space is NOT the owner's home: the system
    // default-app source, with the custom-URL fork's interim (system
    // default only) — never the home source.
    const root = await resolveRootEventually(reader);
    expect(getPatternSource(root)).toBe(DEFAULT_APP_PATTERN_SOURCE);

    const creations = ensureTxs();
    expect(creations.length).toBeGreaterThan(0);
    for (const tx of creations) {
      const snapshot = tx.getCfcState().trustSnapshot;
      expect(snapshot?.actingPrincipal).toBe(aliceSigner.did());
      expect(snapshot?.actingPrincipal).not.toBe(serviceSigner.did());
    }
  });

  it("activation before the genesis ACL: the fail-closed skip RE-ARMS on the ACL commit and the ensure runs in the SAME tenure", async () => {
    // The measured live boot order (stage-1 measurement r01): the host
    // activates on SESSION-OPEN, before the client's genesis ACL commit
    // (which is the space's commit #1 — INV-13) has landed, so the
    // tenure's first ensure finds no owner and skips fail-closed. The
    // owner then RESOLVES seconds later; waiting for the next tenure
    // would leave every fresh space's stage-1 ensure inert. The seat
    // re-arms the owed step when an admitted commit touches the ACL
    // doc (`of:<space>`) — same tenure, same fail-closed posture, still
    // never the service DID.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);
    await waitUntil(
      () => stats.rootEnsure.skippedNoOwner === 1,
      "fail-closed skip before the genesis",
    );
    expect(stats.rootEnsure.runs).toBe(0);

    // The genesis lands (the client's bootstrap), and the host's feed
    // delivers its admission notice — modelled directly here (the
    // host→feed plumbing is pre-existing and pinned elsewhere).
    await seedAcl({ [space]: "OWNER" });
    created.enqueueCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "test-genesis",
      writes: [{ id: `of:${space}`, scopeKey: "space" as never }],
    });

    await waitUntil(
      () => stats.rootEnsure.runs === 1,
      "the re-armed ensure ran",
    );
    expect(stats.rootEnsure.created).toBe(1);
    const reader = clientRuntime(readerSigner);
    const root = await resolveRootEventually(reader);
    expect(getPatternSource(root)).toBe(HOME_PATTERN_SOURCE);
  });

  it("a WEDGED ensure hits its deadline: counted failure, lease kept serving, no park (F2)", async () => {
    // The ensure is fully awaited at the top of the first cycle, and
    // its resolve path fetches with no timeout of its own — a wedged
    // fetch (remote mappedHost, dead route) would otherwise hold the
    // tenure's first cycle open forever WHILE the renew timer keeps
    // the lease: no failover, events queueing, no loop-failed park.
    // The deadline lands the wedge in the counted-failure arm and the
    // tenure proceeds serving. Watched RED before the deadline
    // existed: the failure never counted and this pin timed out.
    await seedAcl({ [space]: "OWNER" });
    hangPatternFetches = true;
    const created = newSpaceServer({ rootEnsureDeadlineMs: 300 });
    expect(await created.activate()).toBe(true);

    await waitUntil(
      () => stats.rootEnsure.failures === 1,
      "the wedged ensure's deadline failure counted",
    );
    expect(stats.rootEnsure.runs).toBe(0);
    expect(stats.rootEnsure.created).toBe(0);
    // The tenure is alive and serving — the wedge parked nothing.
    expect(created.active).toBe(true);
  });

  it("HOST-LEVEL live glue (the CI coverage seat): a real session-open activates, the genesis ACL rides the host's own admission feed, and the ensure creates at the knob's production default", async () => {
    // The CI ON lanes run their shared toolshed with the ensure
    // switched OFF (the RULED test posture), so the lanes' green says
    // nothing about the ensure — THIS pin is the live-glue coverage
    // that keeps the production path exercised in CI (it rides the
    // runner unit shards): a REAL ExecutorHost whose admission
    // observer sees a real client session-open (the activation
    // trigger) and whose OWN feed delivers the client's genesis-ACL
    // admission (the same-tenure re-arm) — nothing hand-fed — with
    // ensureSpaceRoots left at its PRODUCTION DEFAULT (unset = ON).
    // The genesis-vs-activation race is real and either arm is
    // correct (genesis first: the ensure resolves the owner directly;
    // activation first: skip + re-arm — pinned deterministically by
    // the direct-SpaceServer re-arm pin above), so this pin asserts
    // the invariant outcome: one ensure ran, ONE root created,
    // durably visible to a fresh replica, home-sourced (self-owned
    // ACL). Mutation-checked: ensureSpaceRoots:false on the host reds
    // this pin.
    const host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: manager,
          fetch: fetchStub,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: true,
          },
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    hostUnderTest = host;

    // A real client: its first session use opens the space
    // (sessionOpened → host activation) and its genesis-ACL write is a
    // real authored admission on the host's feed.
    const writer = clientRuntime(spaceSigner);
    const aclManager = new ACLManager(writer, space as never);
    await aclManager.set(space as never, "OWNER");
    await writer.idle();
    await writer.storageManager.synced();

    const reader = clientRuntime(readerSigner);
    const root = await resolveRootEventually(reader);
    expect(getPatternSource(root)).toBe(HOME_PATTERN_SOURCE);
    await waitUntil(
      () => host.stats().rootEnsure.created === 1,
      "the host-driven ensure's creation counted",
    );
    expect(host.stats().rootEnsure.runs).toBeGreaterThanOrEqual(1);
    expect(host.stats().rootEnsure.failures).toBe(0);
  });

  it("ensureSpaceRoots:false (the RULED test switch) arms NOTHING: no root, no counter movement, tenure serving", async () => {
    // RULED 2026-08-24 (the owner; recorded verbatim in the stage-1
    // report): production spaces always get a default pattern, but
    // tests may switch the tenure's ensure OFF — the CI ON lanes'
    // fixture clients hold space-cell subscriptions that receive the
    // ensured root's computed cells with unverified cid: schema refs
    // (the broken-schema-ref uncaught class that redded the board).
    // OFF must mean fully inert: nothing armed, nothing skipped,
    // nothing counted — and the ACL-arrival re-arm must not resurrect
    // it.
    await seedAcl({ [space]: "OWNER" });
    const created = newSpaceServer(undefined, { ensureSpaceRoots: false });
    expect(await created.activate()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The re-arm path cannot resurrect a disabled ensure either.
    created.enqueueCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "test-acl-touch",
      writes: [{ id: `of:${space}`, scopeKey: "space" as never }],
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(stats.rootEnsure).toEqual({
      runs: 0,
      created: 0,
      reconciled: 0,
      skippedNoOwner: 0,
      failures: 0,
    });
    expect(created.active).toBe(true);
    const reader = clientRuntime(readerSigner);
    expect(await resolveSpaceRootPattern(reader, space)).toBeUndefined();
    expect(ensureTxs().length).toBe(0);
  });

  it("a space with no resolvable ACL owner SKIPS fail-closed: counted, no root, tenure alive", async () => {
    // No ACL seeded at all — resolveSpaceOwner yields undefined.
    const created = newSpaceServer();
    expect(await created.activate()).toBe(true);

    await waitUntil(
      () => stats.rootEnsure.skippedNoOwner === 1,
      "fail-closed skip counted",
    );
    expect(stats.rootEnsure.runs).toBe(0);
    expect(stats.rootEnsure.created).toBe(0);
    // The tenure keeps serving (the skip parks nothing).
    expect(created.active).toBe(true);

    // And the root was NOT created under the service identity (the
    // fallback the fail-closed arm exists to prevent): semantic
    // absence through the same resolution the ensure itself uses.
    const reader = clientRuntime(readerSigner);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await resolveSpaceRootPattern(reader, space)).toBeUndefined();
    expect(ensureTxs().length).toBe(0);
  });
});
