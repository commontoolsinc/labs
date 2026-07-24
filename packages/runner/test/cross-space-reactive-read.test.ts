/**
 * C3.12.0 — the three-way diagnostic repro for client-side cross-space
 * reactivity (defect (ii)). This is WO-0 of the C3.12 decomposition and a
 * GATE: its verdict decides whether the rows below it are built (see
 * `docs/specs/server-side-execution/implementation-plan.md` §"C3.12 — client
 * cross-space reactivity" and `docs/history/development/design/
 * c3-12-adversarial-review-2026-07-24.md`, CR2/CR3/CR5/CR7).
 *
 * WHAT THE DECOMPOSITION EXPECTED (and why WO-0 exists to test it, not assume
 * it). The C3.11 composed gate delegated its clause (a) — the reader
 * recomputing on a foreign (space B) change — on the stated premise (defect
 * (ii)) that "a client's replica of a foreign space keeps no live subscription,
 * so a foreign change never reaches the reader's reactive graph": its sink on
 * the foreign source was said to fire ONCE and never again. The adversarial
 * panel (CR2/CR3) then forced WO-0 to return a THREE-WAY verdict rather than
 * the scout's under-resolved "B1":
 *   - B1-server = space B's origin emits NO third-party push to the reader's
 *                 standing foreign-read watch (needs an owned server-side row,
 *                 C3.12.1s).
 *   - B1-client = deliverable to the reader's B session, but the client dropped
 *                 it (watch torn down at settle / dedup-blocked re-pull /
 *                 authority-swallowed, `link-resolution.ts:342`).
 *   - B2        = delivered + applied (replica seq advances) but the derivation
 *                 never goes reactive-dirty (foreign read keyed under home).
 *
 * WHAT THIS TEST FOUND (the verdict, stated definitively per the WO-0 mandate).
 * The premise does NOT reproduce. Committing a LATER B change and observing the
 * reader (which the scout's cited repro `cross-space-value-read.test.ts` never
 * did — it only asserts the INITIAL value) shows the origin server DOES push
 * the third-party B commit to the reader's B-session standing watch, the direct
 * foreign sink REFIRES, the `doubled` derivation RECOMPUTES, and the reader's B
 * replica advances — across every config exercised (bare client-primary AND the
 * server-primary + doc-set-membership-watch product path). So:
 *   ⇒ B1-server is STRUCK: the origin emits third-party foreign push (wire-tap
 *     evidence below). C3.12.1s is NOT needed.
 *   ⇒ B1-client is FALSE at the runner level: the reader's B replica keeps a
 *     LIVE standing watch (the CR7 accessor reports update-promises > 0), not a
 *     torn-down one — directly refuting "keeps no live subscription".
 *   ⇒ B2 is FALSE: the derivation recomputes, so the foreign read is keyed
 *     under its OWN (space,id,scope) = B, not normalized onto home A (CR5).
 * The scout/gate "fires once, never again" was an ARCHITECTURAL INFERENCE from
 * `link-resolution.ts:321` ("the origin server never pushes other-space docs")
 * that conflates the reader's HOME (A) session — which indeed cannot carry B
 * docs — with the reader's separate B SESSION opened by the cross-space kick,
 * which registers a standing `watchAddSync` + `consumeUpdates(subscribeSync())`
 * (`storage/v2.ts:refreshWatchSet`) and DOES carry B's docs.
 *
 * WHY THE PROBES ARE SHAPED THIS WAY (CR2). `applyAttributedSessionSync`
 * (`storage/v2.ts:4985-4994`) fires the direct sink AND the scheduler
 * `#subscription.next` in the same step, so a direct-foreign-sink refire is a
 * faithful proxy for "the change reached the replica" (collapsing B2 out of the
 * direct path). A naive "sink fired once" still cannot split B1-server from
 * B1-client, so this test observes the actual transport with a WIRE TAP on the
 * reader's per-space loopback sessions (did the origin push the later value?)
 * and a CR7-budgeted TEST-ONLY SpaceReplica accessor `crossSpaceWatchDiagnostics`
 * (is the standing watch alive?). The `doubled` derivation (home A → B link,
 * the gate fixture's shape) is the B2 probe (delivered but mis-keyed ⇒ no
 * recompute). A SAME-SPACE control (a third party writing an A cell the reader
 * sinks) proves the bench genuinely delivers standing pushes, so a cross-space
 * silence — had there been one — could not be dismissed as a dead bench.
 *
 * STATUS OF THIS COMMITTED TEST. It was scoped as a RED baseline; reality made
 * it a GREEN one. It is committed GREEN as (a) the evidence base for the WO-0
 * verdict and (b) a REGRESSION PIN: if any later change breaks foreign reactive
 * delivery, the delivery assertions fail. Two corners are out of a runner unit
 * test's reach and are flagged for follow-on, NOT asserted here: the full
 * pool-SERVED regime (a `DenoSpaceExecutorFactory` Worker claiming `doubled`
 * server-side — the gate's habitat; needs perms a runner test lacks) and the
 * co-hosted/remote transport (C3.12.4c reconnect). Delivery is a storage-layer
 * property independent of execution mode, and the kick's standing watch is
 * established regardless of the pool, so the runner-level verdict is expected to
 * carry — but those legs belong to the patterns-integration gate, not here.
 *
 * Determinism: barrier-driven — a bounded `idle()` + real-timer poll that
 * returns the instant its condition holds (the server batches subscription
 * pushes on a real timer, so `synced()`/`pull()` are deliberately NOT used to
 * drive push observation: they fetch out-of-band and would MASK a missing push
 * — the same idiom the repo's live-delivery suites use, `scheduler-cold-replica`
 * / `observation-adoption-live`).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  decodeMemoryBoundary,
  type MemoryProtocolFlags,
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionDocSetWatchConfig,
  setServerPrimaryExecutionConfig,
  setServerPrimaryExecutionDocSetWatchConfig,
} from "@commonfabric/memory/v2";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const AUDIENCE = "did:key:z6Mk-xsp-reactive-audience";
const SOURCE_NAME = "xsp-reactive-source";
const CONTROL_NAME = "xsp-reactive-home-control";

// Distinctive values so the wire-tap scan for a doc-value push cannot collide
// with a small seq/localSeq number that happens to share the digit.
const B_INITIAL = 21;
const B_LATER = 777; // doubled => 1554
const CONTROL_INITIAL = 131;
const CONTROL_LATER = 939;

/** A tested flag/config combination. */
type ScenarioConfig = {
  name: string;
  flags: Partial<MemoryProtocolFlags>;
  serverPrimary: boolean;
  docSetWatch: boolean;
};

const CONFIGS: readonly ScenarioConfig[] = [
  {
    // The real product delivery path: with these negotiated the client engages
    // the F4 doc-set MEMBERSHIP watch that maintains standing delivery.
    name: "product delivery path (server-primary + doc-set membership watch)",
    flags: {
      persistentSchedulerState: true,
      schedulerWriterLookup: true,
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionDocSetWatchV1: true,
    },
    serverPrimary: true,
    docSetWatch: true,
  },
  {
    // The plan's "isolated runner level" config — no server-primary machinery,
    // the same bare shape as `cross-space-value-read.test.ts`. Delivery here via
    // the plain graph watch's `subscribeSync` consumer.
    name: "bare client-primary (the plan's isolated runner level)",
    flags: { persistentSchedulerState: true },
    serverPrimary: false,
    docSetWatch: false,
  },
];

// ---------------------------------------------------------------------------
// Wire tap. Each `create(space)` mints a per-space loopback transport; we wrap
// BOTH directions so the diagnostic can observe (a) server->reader pushes (the
// B1-server discriminant) and (b) reader->server traffic.
// ---------------------------------------------------------------------------

type TappedMessage = {
  direction: "in" | "out";
  space: string;
  message: unknown;
};

class TappingSessionFactory implements SessionFactory {
  readonly supportsExecutionDemand = true;

  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
    private readonly onMessage?: (m: TappedMessage) => void,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const inner = MemoryClient.loopback(this.server);
    const tap = this.onMessage;
    const record = (direction: "in" | "out", payload: string) => {
      if (tap === undefined) return;
      try {
        tap({ direction, space, message: decodeMemoryBoundary(payload) });
      } catch {
        // Undecodable payloads are the client's problem, not the tap's.
      }
    };
    const transport: typeof inner = tap === undefined ? inner : {
      send: (payload: string) => {
        record("out", payload);
        return inner.send(payload);
      },
      close: () => inner.close(),
      setReceiver: (next: (payload: string) => void) => {
        inner.setReceiver((payload) => {
          record("in", payload);
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

class TappingStorageManager extends StorageManager {
  static connect(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<StorageOptions, "memoryHost" | "spaceHostMap">,
    onMessage?: (m: TappedMessage) => void,
  ): TappingStorageManager {
    return new TappingStorageManager(
      { ...options, memoryHost: new URL("memory://xsp-reactive") },
      new TappingSessionFactory(server, flags, onMessage),
    );
  }
}

// Raw ACL helper (enforce mode): reader holds READ on B + WRITE on A; writer
// holds WRITE on both.
const writeAcl = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
  space: string,
  adminDid: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const client = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: flags,
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

// The reader pattern: a space-scoped `computed` folding a foreign (space B) read
// bound at instantiation — the smallest home(A) → B link derivation, the same
// shape the C3.11 gate fixture uses.
const READER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, pattern, Writable } from 'commonfabric';",
        "",
        "export default pattern<{ source?: Writable<number> }>(({ source }) => ({",
        "  source,",
        "  doubled: computed(() => (source?.get() ?? 0) * 2),",
        "}));",
      ].join("\n"),
    },
  ],
};

type Party = {
  identity: Identity;
  did: string;
  storage: TappingStorageManager;
  runtime: Runtime;
  taps: TappedMessage[];
};

const openParty = async (
  server: Server,
  flags: Partial<MemoryProtocolFlags>,
  tapped: boolean,
): Promise<Party> => {
  const identity = await Identity.generate({ implementation: "noble" });
  const taps: TappedMessage[] = [];
  const storage = TappingStorageManager.connect(
    server,
    flags,
    { as: identity },
    tapped ? (m) => taps.push(m) : undefined,
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { persistentSchedulerState: true },
  });
  return { identity, did: identity.did(), storage, runtime, taps };
};

// Barrier for observing a server PUSH: poll a condition across bounded `idle()`
// + real-timer cycles and return the instant it holds (never a fixed sleep).
// Deliberately avoids `synced()`/`pull()`, which fetch out-of-band and would
// MASK a missing push — turning the very gap under test falsely green.
async function waitForPush(
  party: Party,
  until: () => boolean,
  attempts = 40,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await party.runtime.idle();
    if (until()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await party.runtime.idle();
  return until();
}

// Convergence settle for SETUP steps (not push observation): drive the reactive
// graph and the cross-space kick to quiescence.
async function settle(party: Party): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await party.runtime.idle();
    await party.storage.synced();
    await party.storage.crossSpaceSettled();
  }
}

// The CR7-budgeted test-only replica accessor for the reader's B replica.
function bReplicaWatch(reader: Party, spaceB: MemorySpace): {
  updatePromiseCount: number;
  hasSubscribedWatch: boolean;
  docSetWatchId: string | undefined;
} {
  const replica = reader.storage.open(spaceB).replica as unknown as {
    crossSpaceWatchDiagnostics?: () => {
      updatePromiseCount: number;
      hasSubscribedWatch: boolean;
      docSetWatchId: string | undefined;
    };
  };
  return replica.crossSpaceWatchDiagnostics?.() ??
    {
      updatePromiseCount: -1,
      hasSubscribedWatch: false,
      docSetWatchId: undefined,
    };
}

// Does any tapped message on the reader's space-B session (in the given
// direction) carry the given value as a doc push? A cheap structural scan of the
// decoded boundary — the distinctive later value is enough that its presence in
// a B-session inbound message means the origin delivered the third-party commit.
function tapCarriesValue(
  taps: TappedMessage[],
  space: string,
  direction: "in" | "out",
  value: number,
): boolean {
  const needle = `:${JSON.stringify(value)}`;
  return taps.some((t) =>
    t.space === space && t.direction === direction &&
    JSON.stringify(t.message ?? null).includes(needle)
  );
}

type Observations = {
  config: string;
  initialDirect: unknown[];
  initialDoubled: unknown[];
  initialControl: unknown[];
  bWatchInitial: ReturnType<typeof bReplicaWatch>;
  directRefired: boolean;
  doubledRecomputed: boolean;
  doubledLast: unknown;
  controlRefired: boolean;
  replicaAdvanced: boolean;
  watchAlive: boolean;
  bWatchAfter: ReturnType<typeof bReplicaWatch>;
  serverPushedBLater: boolean;
  tapInBefore: number;
  tapInAfter: number;
  verdict: string;
  keyingAnswer: string;
};

async function runScenario(config: ScenarioConfig): Promise<Observations> {
  if (config.serverPrimary) setServerPrimaryExecutionConfig(true);
  if (config.docSetWatch) setServerPrimaryExecutionDocSetWatchConfig(true);

  const admin = await Identity.generate({ implementation: "noble" });
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: AUDIENCE },
    protocolFlags: config.flags,
    acl: { mode: "enforce", serviceDids: [admin.did()] },
  });

  let reader: Party | undefined;
  let writer: Party | undefined;
  try {
    reader = await openParty(server, config.flags, true);
    writer = await openParty(server, config.flags, false);
    const spaceA = reader.did as MemorySpace; // reader's home space
    const spaceB = writer.did as MemorySpace; // writer owns B

    await writeAcl(server, config.flags, spaceA, admin.did(), {
      [admin.did()]: "OWNER",
      [reader.did]: "WRITE",
      [writer.did]: "WRITE", // writer third-party-writes the same-space control
    });
    await writeAcl(server, config.flags, spaceB, admin.did(), {
      [admin.did()]: "OWNER",
      [writer.did]: "WRITE",
      [reader.did]: "READ",
    });

    // ---- Writer seeds the foreign source (B) and the home control (A). ------
    // Each transaction writes a single space (writer isolation is per-space).
    {
      const tx = writer.runtime.edit();
      writer.runtime.getCell<number>(spaceB, SOURCE_NAME, undefined, tx)
        .set(B_INITIAL);
      expect((await tx.commit()).error).toBe(undefined);
    }
    {
      const tx = writer.runtime.edit();
      writer.runtime.getCell<number>(spaceA, CONTROL_NAME, undefined, tx)
        .set(CONTROL_INITIAL);
      expect((await tx.commit()).error).toBe(undefined);
    }
    await writer.runtime.idle();
    await writer.storage.synced();

    // ---- Reader instantiates the doubled pattern in A, binding source -> B. -
    const compiled = await reader.runtime.patternManager.compilePattern(
      READER_PROGRAM,
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
      "xsp-reactive-result",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const handle = reader.runtime.run(tx, compiled as any, {
      source: foreignSource,
    }, result);
    expect((await tx.commit()).error).toBe(undefined);
    await handle.pull();
    // Go LIVE on the derivation: a receiver only gets standing pushes once
    // `start()` establishes its live reactive session (scheduler-cold-replica).
    expect(await reader.runtime.start(handle)).toBeTruthy();
    await settle(reader);

    // Same-space control the reader sinks (the positive proof the bench
    // delivers standing pushes).
    const controlCell = reader.runtime.getCell<number>(
      spaceA,
      CONTROL_NAME,
      undefined,
    );
    await controlCell.sync();

    // ---- Sinks: direct foreign cell, doubled derivation, home control. ------
    const directSeen: unknown[] = [];
    const doubledSeen: unknown[] = [];
    const controlSeen: unknown[] = [];
    const cancelDirect = foreignSource.sink((v) => {
      directSeen.push(v);
    });
    const cancelDoubled = handle.key("doubled").sink((v) => {
      doubledSeen.push(v);
    });
    const cancelControl = controlCell.sink((v) => {
      controlSeen.push(v);
    });
    await settle(reader);

    const initialDirect = [...directSeen];
    const initialDoubled = [...doubledSeen];
    const initialControl = [...controlSeen];
    const bWatchInitial = bReplicaWatch(reader, spaceB);

    // ---- Writer commits a LATER B change AND a later control change. --------
    const tapInBefore =
      reader.taps.filter((t) => t.space === spaceB && t.direction === "in")
        .length;
    {
      const tx2 = writer.runtime.edit();
      writer.runtime.getCell<number>(spaceB, SOURCE_NAME, undefined, tx2)
        .set(B_LATER);
      expect((await tx2.commit()).error).toBe(undefined);
    }
    {
      const tx3 = writer.runtime.edit();
      writer.runtime.getCell<number>(spaceA, CONTROL_NAME, undefined, tx3)
        .set(CONTROL_LATER);
      expect((await tx3.commit()).error).toBe(undefined);
    }
    await writer.runtime.idle();
    await writer.storage.synced();

    // Same-space control landing first is the positive control; then give the
    // cross-space B change its full, fair chance to land.
    await waitForPush(reader, () => controlSeen.length > initialControl.length);
    await waitForPush(reader, () => directSeen.length > initialDirect.length);

    // Snapshot the PUSH-phase observations BEFORE any out-of-band re-sync.
    const directRefired = directSeen.length > initialDirect.length;
    const doubledRecomputed = doubledSeen.length > initialDoubled.length;
    const controlRefired = controlSeen.length > initialControl.length;
    const replicaAdvanced = foreignSource.get() === B_LATER;
    const bWatchAfter = bReplicaWatch(reader, spaceB);
    const watchAlive = bWatchAfter.updatePromiseCount > 0 ||
      bWatchAfter.hasSubscribedWatch;
    const serverPushedBLater = tapCarriesValue(
      reader.taps,
      spaceB,
      "in",
      B_LATER,
    );
    const tapInAfter =
      reader.taps.filter((t) => t.space === spaceB && t.direction === "in")
        .length;
    const doubledLast = doubledSeen.at(-1);

    cancelDirect();
    cancelDoubled();
    cancelControl();

    // ---- Verdict. -----------------------------------------------------------
    let verdict: string;
    if (directRefired && replicaAdvanced) {
      verdict = doubledRecomputed
        ? "NO-GAP: delivered + reactive (B1-server STRUCK; not B1-client; not B2)"
        : "B2 (delivered + applied, but derivation not reactive-dirty)";
    } else if (serverPushedBLater) {
      verdict = "B1-client (origin pushed; client dropped/deduped)";
    } else if (watchAlive) {
      verdict = "B1-server (watch alive, but origin emits no third-party push)";
    } else {
      verdict = "B1-client (standing watch torn down)";
    }
    // CR5: doubled recomputing on the B change proves the reactive dep matched a
    // B-keyed invalidation ⇒ the foreign read is logged under its OWN space.
    const keyingAnswer = doubledRecomputed
      ? "own (space,id,scope) — read space B (NOT normalized onto home A)"
      : "indeterminate from behavior (derivation did not recompute)";

    return {
      config: config.name,
      initialDirect,
      initialDoubled,
      initialControl,
      bWatchInitial,
      directRefired,
      doubledRecomputed,
      doubledLast,
      controlRefired,
      replicaAdvanced,
      watchAlive,
      bWatchAfter,
      serverPushedBLater,
      tapInBefore,
      tapInAfter,
      verdict,
      keyingAnswer,
    };
  } finally {
    await reader?.runtime.dispose().catch(() => undefined);
    await writer?.runtime.dispose().catch(() => undefined);
    await reader?.storage.close().catch(() => undefined);
    await writer?.storage.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (config.serverPrimary) resetServerPrimaryExecutionConfig();
    if (config.docSetWatch) resetServerPrimaryExecutionDocSetWatchConfig();
  }
}

describe("C3.12.0 cross-space reactive read — three-way diagnostic", () => {
  for (const config of CONFIGS) {
    it(
      `origin pushes third-party B commits and the reader recomputes — ${config.name}`,
      async () => {
        const obs = await runScenario(config);
        console.log("C3.12.0 VERDICT", JSON.stringify(obs));

        // ---- PINS (invariant across the C3.12 arc). -------------------------
        // The one true observation from the plan: the sink fires exactly once at
        // instantiation with the initial value.
        expect(obs.initialDirect).toEqual([B_INITIAL]);
        expect(obs.initialDoubled.at(-1)).toBe(B_INITIAL * 2);
        // Counter-evidence to "keeps no live subscription": the reader's B
        // replica holds a LIVE standing watch after the cross-space read.
        expect(obs.bWatchInitial.updatePromiseCount).toBeGreaterThan(0);
        // The bench genuinely delivers standing same-space pushes.
        expect(obs.controlRefired).toBe(true);

        // ---- VERDICT (definitive; regression pin). --------------------------
        // Origin emits the third-party foreign push (wire evidence) ⇒ B1-server
        // is STRUCK. The reader's foreign sink REFIRES and `doubled` RECOMPUTES
        // ⇒ neither B1-client nor B2 at the runner level. If a later change
        // regresses foreign reactive delivery, these fail loudly.
        expect(obs.serverPushedBLater).toBe(true);
        expect(obs.tapInAfter).toBeGreaterThan(obs.tapInBefore);
        expect(obs.directRefired).toBe(true);
        expect(obs.replicaAdvanced).toBe(true);
        expect(obs.doubledRecomputed).toBe(true);
        expect(obs.doubledLast).toBe(B_LATER * 2);
        expect(obs.watchAlive).toBe(true);
        expect(obs.verdict).toContain("NO-GAP");
      },
    );
  }
});
