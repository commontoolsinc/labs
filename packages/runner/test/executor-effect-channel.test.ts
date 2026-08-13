// Server-execution v2 Phase 4: the client-effect channel, end to end
// against a real memory server, a live ExecutorHost, and flag-ON
// clients (docs/specs/server-side-execution/protocol.md §5,
// builtins.md §4; scenario-traces.md T2 is the reference journey).
//
// - the SERVED intent (T2 hops 1–4): a client fire's handler returns
//   navigateTo; the wave computes the target and writes the §5 entry
//   `{nonce, kind: "navigate", args: {target}, issuedIn}` into the
//   FIRING session's effects INSTANCE — the one well-known doc id at
//   `scope_key = session:<user>:<sid>`, the SpaceServer naming the key
//   via the seal-time annotations (T2.Q1/Q2), `issuedIn` engine-stamped
//   with the issuing commit's seq;
// - CARDINALITY 2 + the multi-hop chain: a navigateTo computed a
//   CASCADE hop from the click still addresses the session that
//   clicked (events.md §2's actor inheritance; builtins.md §4), and a
//   second session's fire lands in ITS instance — neither sees the
//   other's intent;
// - the CLIENT half (T2 hops 5–6): optimistic enactment carries the
//   same deterministic nonce, the authoritative intent CONVERGES on it
//   (ONE navigation), the ack is an ordinary authored write of the
//   session's own `acks[nonce]` mark, `effectAcks` counts it, and the
//   NEXT wave retires the acked entry with a bookkeeping-stamped
//   SpaceServer write carrying addressing and NO acting principal
//   (T2.Q4/Q5);
// - the LT8 reload journey: a reload between intent and ack re-enacts
//   (the enacted-nonce record is reload-wiped — accepted for
//   reversible effects), then acks ONCE; retirement is idempotent and
//   nothing resurrects after it;
// - the SESSIONLESS refusal (builtins.md §4): a chain with no acting
//   session reaches navigateTo and the served half refuses — no intent
//   is written anywhere;
// - the LT3 refusal: an acting session NOT connected to the computing
//   space is refused the same way (cross-space navigateTo deferred).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  decodeMemoryBoundary,
  type EffectIntentEntry,
  resolvePrincipalSessionKey,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/** The settle-gate seam (see executor-events-down.test.ts): holds the
 * serving loop's settle so a test can dispose a client INSIDE the
 * intent-computing wave (the LT8 reload window). */
class GatedStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Parameters<typeof EmulatedStorageManager.connectTo>[1],
  ): GatedStorageManager {
    return super.connectTo(server, options) as GatedStorageManager;
  }

  settleGate: Promise<void> | undefined;
  settleGateWhen: (() => boolean) | undefined;

  override async inputSynced(): Promise<void> {
    await super.inputSynced();
    if (this.settleGate !== undefined && (this.settleGateWhen?.() ?? true)) {
      await this.settleGate;
    }
  }
}

const spaceSigner = await Identity.fromPassphrase("effect channel space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("effect channel service");
const aliceSigner = await Identity.fromPassphrase("effect channel alice");
const bobSigner = await Identity.fromPassphrase("effect channel bob");

const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

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

/** The stored effects instance of one (principal, sessionId) — read
 * from the ENGINE (the per-instance truth; T2.Q1's addressing). */
const effectsInstanceOf = (
  engine: Engine.Engine,
  principal: string,
  sessionId: string,
): SessionEffectsDocValue =>
  (Engine.readState(engine, {
    id: SERVER_EXECUTION_EFFECTS_DOC_ID,
    scopeKey: resolvePrincipalSessionKey(principal, sessionId),
  })?.document?.value ?? {}) as SessionEffectsDocValue;

const intentsOf = (
  engine: Engine.Engine,
  principal: string,
  sessionId: string,
): EffectIntentEntry[] => {
  const value = effectsInstanceOf(engine, principal, sessionId);
  return Array.isArray(value.entries) ? value.entries : [];
};

/** A handler that returns navigateTo(TargetPage) — the canonical split
 * contract journey (builtins.md §4). */
const NAVIGATE_PATTERN = [
  "import { handler, navigateTo, pattern, Stream, Writable } from 'commonfabric';",
  "const TargetPage = pattern<{ label: string }, { label: string }>(",
  "  ({ label }) => ({ label }),",
  ");",
  "const go = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => {",
  "    value.set((value.get() ?? 0) + 1);",
  "    return navigateTo(TargetPage({ label: 'target page' }));",
  "  },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; go: Stream<unknown> }",
  ">(({ value }) => ({ value, go: go({ value }) }));",
].join("\n");

/** H1 (the click's handler) emits to a second stream; H2 returns the
 * navigateTo — the intent must still address the CLICKING session
 * (events.md §2's inheritance; the task's cardinality-2 multi-hop pin). */
const CASCADE_NAVIGATE_PATTERN = [
  "import { handler, navigateTo, pattern, Stream, Writable } from 'commonfabric';",
  "const TargetPage = pattern<{ label: string }, { label: string }>(",
  "  ({ label }) => ({ label }),",
  ");",
  "const secondHandler = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => {",
  "    value.set((value.get() ?? 0) + 10);",
  "    return navigateTo(TargetPage({ label: 'hop two' }));",
  "  },",
  ");",
  "const firstHandler = handler<",
  "  unknown,",
  "  { value: Writable<number>; second: Stream<unknown> }",
  ">((_ev, { value, second }) => {",
  "  value.set((value.get() ?? 0) + 1);",
  "  second.send({});",
  "});",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; first: Stream<unknown>; second: Stream<unknown> }",
  ">(({ value }) => {",
  "  const second = secondHandler({ value });",
  "  return { value, first: firstHandler({ value, second }), second };",
  "});",
].join("\n");

describe("Phase 4 client-effect channel", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let extraManagers: EmulatedStorageManager[];
  let extraRuntimes: Runtime[];
  let servingManager: GatedStorageManager | undefined;

  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = GatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: false,
          },
        });
        servingManager = manager;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: policy ?? { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    extraManagers = [];
    extraRuntimes = [];
    servingManager = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of extraRuntimes) await runtime.dispose();
    for (const manager of extraManagers) await manager.close();
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = (
    signer: Identity = aliceSigner,
    options: { navigations?: string[]; sessionId?: string } = {},
  ): { manager: EmulatedStorageManager; runtime: Runtime } => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: signer,
      ...(options.sessionId !== undefined ? { id: options.sessionId } : {}),
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      ...(options.navigations !== undefined
        ? {
          navigateCallback: (target) => {
            options.navigations!.push(target.getAsNormalizedFullLink().id);
          },
        }
        : {}),
    });
    return { manager, runtime };
  };

  /** Compile + run a pattern on `runtime`, returning its cells. */
  const standUp = async (
    runtime: Runtime,
    source: string,
    names: { arg: string; result: string },
  ) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    }, { space });
    const argument = runtime.getCell<{ value: number }>(
      space,
      names.arg,
      undefined,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      names.result,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = runtime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { compiled, argument, result };
  };

  it("the served intent (T2 hops 1–4): fire → wave computes navigateTo → the §5 entry lands in the FIRING session's instance, issuedIn stamped, annotations addressing + acting", async () => {
    const navigations: string[] = [];
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations },
    ));
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(
      clientRuntime,
      NAVIGATE_PATTERN,
      { arg: "served-arg", result: "served-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const before = Engine.serverSeq(engine);
    result.key("go").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const sessionId = clientManager.id;
    await waitUntil(
      () => intentsOf(engine, aliceSigner.did(), sessionId).length === 1,
      "the intent to land in alice's session instance",
    );
    const [intent] = intentsOf(engine, aliceSigner.did(), sessionId);

    // T2.Q2: the §5 shape — nonce, kind navigate, a target link,
    // issuedIn = the issuing derived commit's seq (engine-stamped).
    expect(intent.kind).toBe("navigate");
    expect(typeof intent.nonce).toBe("string");
    expect(intent.args?.target?.id).toBeDefined();
    expect(typeof intent.issuedIn).toBe("number");
    const issuedRow = engine.database.prepare(
      `SELECT class FROM "commit" WHERE seq = :seq`,
    ).get({ seq: intent.issuedIn }) as { class: string } | undefined;
    expect(issuedRow?.class).toBe("derived");

    // The handler's own consequence landed too (same wave family).
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 1;
      },
      "the handler consequence to land",
    );

    // T2.Q1 + protocol §1: the intent write's annotation carries the
    // ADDRESSING (alice's session scope key) AND the acting identity
    // (the event's stamped actor).
    const aliceKey = resolvePrincipalSessionKey(aliceSigner.did(), sessionId);
    const annotated = engine.database.prepare(
      `SELECT annotations FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND annotations IS NOT NULL`,
    ).all({ from_seq: before }) as Array<{ annotations: string }>;
    const intentAnnotations = annotated.flatMap((row) =>
      decodeMemoryBoundary(row.annotations) as Array<{
        scopeKey?: string;
        actingUser?: string;
        actingSession?: string;
      }>
    ).filter((annotation) => annotation.scopeKey === aliceKey);
    expect(intentAnnotations.length).toBeGreaterThan(0);
    expect(
      intentAnnotations.some((annotation) =>
        annotation.actingUser === aliceSigner.did() &&
        annotation.actingSession === sessionId
      ),
    ).toBe(true);

    cancelDemand();
  });

  it("cardinality 2 + multi-hop: a cascade-hop navigateTo addresses the CLICKING session; two sessions' fires land in their OWN instances", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(
      clientRuntime,
      CASCADE_NAVIGATE_PATTERN,
      { arg: "hop-arg", result: "hop-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Bob joins the same piece.
    const bob = openClient(bobSigner);
    extraManagers.push(bob.manager);
    extraRuntimes.push(bob.runtime);
    const bobResult = bob.runtime.getCell<Record<string, unknown>>(
      space,
      "hop-result",
      undefined,
    );
    await bobResult.sync();

    host = newHost();
    // Alice clicks: H1 (her actor) emits E2; H2 (E2's handler, actor
    // INHERITED) returns the navigateTo — the intent must land in
    // ALICE's instance (events.md §2; builtins.md §4).
    result.key("first").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const aliceSession = clientManager.id;
    const bobSession = bob.manager.id;
    await waitUntil(
      () => intentsOf(engine, aliceSigner.did(), aliceSession).length === 1,
      "alice's multi-hop intent to land in HER instance",
    );
    expect(intentsOf(engine, bobSigner.did(), bobSession).length).toBe(0);

    // Bob clicks his own: his intent lands in HIS instance; alice
    // still holds exactly hers.
    bobResult.key("first").send({});
    await bob.runtime.idle();
    await bob.runtime.storageManager.synced();
    await waitUntil(
      () => intentsOf(engine, bobSigner.did(), bobSession).length === 1,
      "bob's intent to land in HIS instance",
    );
    expect(intentsOf(engine, aliceSigner.did(), aliceSession).length).toBe(
      1,
    );
    const aliceNonce =
      intentsOf(engine, aliceSigner.did(), aliceSession)[0].nonce;
    const bobNonce = intentsOf(engine, bobSigner.did(), bobSession)[0].nonce;
    expect(aliceNonce).not.toBe(bobNonce);

    cancelDemand();
  });

  it("the client half (T2 hops 5–6): optimistic enactment converges by nonce (ONE navigation), the authored ack lands and is counted, and the next wave retires the entry with addressing-only annotations", async () => {
    const navigations: string[] = [];
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations },
    ));
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, NAVIGATE_PATTERN, {
      arg: "ack-arg",
      result: "ack-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const before = Engine.serverSeq(engine);
    result.key("go").send({});

    const sessionId = clientManager.id;
    // The full lifecycle, in order: the intent LANDS in alice's
    // instance… (transient-tolerant: intent → ack → retire can outrun
    // the poll, so a drained-but-PRESENT instance with the ack counted
    // is also completion — the sx2 gate's rule).
    let sampledNonce: string | undefined;
    await waitUntil(
      () => {
        const intents = intentsOf(engine, aliceSigner.did(), sessionId);
        if (intents.length === 1) {
          sampledNonce = intents[0].nonce;
          return true;
        }
        const value = effectsInstanceOf(engine, aliceSigner.did(), sessionId);
        return Object.keys(value).length > 0 &&
          (host!.stats().effectAcks ?? 0) >= 1;
      },
      "the intent to land",
    );
    // …then the client acks and the next wave RETIRES the acked entry
    // (the instance drains — entries AND marks).
    await waitUntil(
      () => {
        const value = effectsInstanceOf(engine, aliceSigner.did(), sessionId);
        const entries = Array.isArray(value.entries) ? value.entries : [];
        const acks = value.acks ?? {};
        return entries.length === 0 && Object.keys(acks).length === 0;
      },
      "the ack to land and the entry to retire",
    );
    // The enacted-nonce record converged: exactly ONE distinct nonce
    // was ever recorded this life — the optimistic record and the
    // authoritative intent shared it (a divergent pair records two).
    // UNCONDITIONAL (independent review NOTE-e): the count witnesses
    // convergence even when the poll never sampled the transient
    // intent; the sampled equality below is the opportunistic
    // stronger half.
    expect(clientRuntime.effectsChannel?.enactedNonceCount).toBe(1);
    if (sampledNonce !== undefined) {
      expect(clientRuntime.effectsChannel?.hasEnacted(sampledNonce)).toBe(
        true,
      );
    }

    // Exactly ONE navigation: the optimistic enactment carried the same
    // nonce the authoritative intent arrived with — the channel
    // converged instead of re-enacting (T2.Q7), and retirement did not
    // resurrect anything.
    await clientRuntime.idle();
    expect(navigations.length).toBe(1);

    // The ack was counted (serving-loop.md §7's effectAcks — the
    // amplification metric's exclusion).
    expect(host!.stats().effectAcks).toBeGreaterThanOrEqual(1);

    // T2.Q4: the retirement write is the SpaceServer's OWN — its
    // annotation carries ADDRESSING (alice's key) and NO acting
    // principal. Find derived commits annotating alice's key with no
    // actingUser.
    const aliceKey = resolvePrincipalSessionKey(aliceSigner.did(), sessionId);
    const annotated = engine.database.prepare(
      `SELECT annotations FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND annotations IS NOT NULL`,
    ).all({ from_seq: before }) as Array<{ annotations: string }>;
    const addressingOnly = annotated.flatMap((row) =>
      decodeMemoryBoundary(row.annotations) as Array<{
        scopeKey?: string;
        actingUser?: string;
      }>
    ).filter((annotation) =>
      annotation.scopeKey === aliceKey && annotation.actingUser === undefined
    );
    expect(addressingOnly.length).toBeGreaterThan(0);

    cancelDemand();
  });

  it("cascade × capable client (review M1): the cascade hop's navigateTo enacts EXACTLY once — one navigation, one target", async () => {
    // The independent review's probe 6, as a test: on a CASCADE hop the
    // client's speculative run and the server's authoritative run mint
    // DIFFERENT attempt ids (events.md §4's fresh-per-attempt cascades),
    // and the handler-result frame's cause embeds that id
    // (runner.ts's `$event: tx.dispatchedEventId`), so BOTH nonce
    // components diverge across the twins. An optimistic enactment on
    // the cascade hop therefore cannot converge with the authoritative
    // intent — the fix suppresses cascade-hop optimism (the capture is
    // tagged attempt-minted), and the authoritative intent is the ONE
    // navigation. Before the fix: two navigations, two distinct
    // targets, per click.
    const navigations: string[] = [];
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations },
    ));
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(
      clientRuntime,
      CASCADE_NAVIGATE_PATTERN,
      { arg: "m1-arg", result: "m1-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("first").send({});
    // BOUNDED waits only past this point: at the pre-fix HEAD this
    // journey does not merely double-navigate — the client runtime
    // LIVELOCKS (idle() never resolves; the serving side starves into
    // repeated lease-renewal failures), so an unbounded idle()/synced()
    // await here wedges the whole suite instead of failing.

    const sessionId = clientManager.id;
    // The authoritative intent lands, alice's channel enacts + acks,
    // and the next wave retires it (transient-tolerant, as in the
    // client-half test: a drained instance after at least one
    // navigation is completion too).
    await waitUntil(
      () => {
        if (navigations.length === 0) return false;
        const value = effectsInstanceOf(engine, aliceSigner.did(), sessionId);
        const entries = Array.isArray(value.entries) ? value.entries : [];
        const acks = value.acks ?? {};
        return entries.length === 0 && Object.keys(acks).length === 0 &&
          (host!.stats().effectAcks ?? 0) >= 1;
      },
      "the cascade intent to land, enact, ack, and retire",
    );
    // Let any straggler enactment (the double-navigation defect) land
    // before counting — a fixed drain, never idle() (see above).
    await new Promise((resolve) => setTimeout(resolve, 500));

    // EXACTLY one navigation, one distinct target (the acceptance).
    expect(navigations.length).toBe(1);
    expect(new Set(navigations).size).toBe(1);

    cancelDemand();
  });

  it("requeued navigate event (review M2): a mid-wave conflict requeues the event, and the wave-2 re-run RE-ISSUES — the intent lands exactly once at the store", async () => {
    // The requeue schedule THROUGH THE BUILTIN (the wave-level fold
    // test hand-builds transactions and so never exercised the
    // builtin's own re-run): hold the serving loop's settle inside the
    // intent-computing wave, land an authored intrusion on the doc the
    // handler writes (a whole-doc set never commutes → the
    // event-handler contribution REQUEUES, and the per-event fold
    // takes the intent tx with it), release, and require the wave-2
    // re-run to re-issue the intent. Store-derived state must govern
    // the served arm: the builtin instance and its closure are REUSED
    // across the re-run (runner.ts's startWithTx cancels-guard), so a
    // closure `navigated` guard would suppress the re-issue forever —
    // the defect this test pins red-first.
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const bob = openClient(bobSigner);
    extraManagers.push(bob.manager);
    extraRuntimes.push(bob.runtime);
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(
      clientRuntime,
      NAVIGATE_PATTERN,
      { arg: "m2-arg", result: "m2-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    // Activate the space with a benign authored write so the serving
    // runtime exists before the gate is installed (the LT8 shape).
    {
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "m2-activation-kick",
        undefined,
      );
      await kick.sync();
      const tx = clientRuntime.edit();
      kick.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => servingManager !== undefined,
      "the serving runtime to come up",
    );
    const gate = Promise.withResolvers<void>();
    servingManager!.settleGate = gate.promise;
    servingManager!.settleGateWhen = () => sidecarIdsIn(engine).length > 0;
    try {
      result.key("go").send({});
      // The event's append is durable — the gate predicate is armed, so
      // the wave that drains it holds open at its settle while the
      // handler has already run and the intent tx has sealed into it.
      await waitUntil(
        () => sidecarIdsIn(engine).length === 1,
        "the fired append to land",
      );
      // The drain RAN inside the held wave (events.processed counts at
      // queue time; the settle then runs the handler, the deferred
      // start, the builtin, and the intent seal to quiescence BEFORE
      // the gated input barrier) — without this the intrusion below
      // can land as ordinary next-wave input and no conflict ever
      // happens (a vacuously green schedule).
      await waitUntil(
        () => (host!.stats().events.processed ?? 0) >= 1,
        "the held wave to drain the event",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The mid-wave intrusion: an authored whole-doc set of the
      // argument doc the handler writes (`value.set(get() + 1)`). A
      // whole-doc set never commutes, so the handler's contribution
      // requeues at the wave commit — and the per-event fold rolls the
      // intent tx back with it. The intruder is a SECOND client: the
      // firing client's own replica holds its speculative handler echo
      // on this doc, so ITS authored write would export overlay-only
      // pending-read deps and be refused (the known leg-C adjacency) —
      // bob's replica is echo-free and commits cleanly.
      {
        const bobArgument = bob.runtime.getCell<{ value: number }>(
          space,
          "m2-arg",
          undefined,
        );
        await bobArgument.sync();
        const tx = bob.runtime.edit();
        bobArgument.withTx(tx).set({ value: 100 });
        expect((await tx.commit()).error).toBeUndefined();
      }
    } finally {
      // ALWAYS release (a throw above with the gate still armed would
      // wedge afterEach's host.close() behind the held settle).
      servingManager!.settleGate = undefined;
      servingManager!.settleGateWhen = undefined;
      gate.resolve();
    }

    // The REQUEUE ENGAGED (the deterministic schedule witness): the
    // wave-2 re-drain queues the event again, so the processed count
    // reaches 2 — without a conflict it stays 1 and this times out (a
    // schedule failure, distinct from the defect under test).
    await waitUntil(
      () => (host!.stats().events.processed ?? 0) >= 2,
      "the requeued event to re-drain in wave 2",
    );
    // The handler re-ran OVER the intrusion: 100 + 1.
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 101;
      },
      "the wave-2 re-run to land the handler consequence over the intrusion",
    );

    // The re-issued intent lands (alice is headless here, so nothing
    // acks it and the entry persists — stable to read).
    const sessionId = clientManager.id;
    await waitUntil(
      () => intentsOf(engine, aliceSigner.did(), sessionId).length === 1,
      "the wave-2 re-run to re-issue the intent",
      15_000,
    );
    // Exactly once: the engine's stored-nonce dedupe absorbs any
    // further re-append; give the loop a settle window and re-count.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(intentsOf(engine, aliceSigner.did(), sessionId).length).toBe(1);
    // The event consequenced exactly once too (wave 2's mark).
    const sidecarId = sidecarIdsIn(engine)[0];
    const stored = (Engine.read(engine, { id: sidecarId })?.value ??
      {}) as StreamEventsDocValue;
    expect(
      (stored.entries ?? []).filter((entry) => entry?.consequenced === true)
        .length,
    ).toBe(1);

    cancelDemand();
  });

  it("the LT8 reload journey: a reload between intent and ack re-enacts (accepted), acks once, retires once, nothing resurrects", async () => {
    // "Reload" here = the RUNTIME dies and is rebuilt over the same
    // live session: the speculation overlay, the effects channel, and
    // its enacted-nonce record — LT8's "reload-wiped overlay" — are all
    // process state of the Runtime, and the session persists across
    // reloads by protocol.md §5. (The full browser journey — the SAME
    // sessionId re-OPENED from a cold process — additionally needs the
    // client-side session persistence protocol §5 owes, which carries
    // the resume token: the registry refuses a token-less re-open by
    // design. That adapter is the OW20-adjacent follow-up; this test
    // pins the channel's half of the journey.)
    const firstLife: string[] = [];
    const pinnedSession = crypto.randomUUID();
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations: firstLife, sessionId: pinnedSession },
    ));
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, NAVIGATE_PATTERN, {
      arg: "reload-arg",
      result: "reload-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    // Activate the space (the host activates on admission): a benign
    // authored write, so the serving runtime exists BEFORE the gate is
    // installed.
    {
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "reload-activation-kick",
        undefined,
      );
      await kick.sync();
      const tx = clientRuntime.edit();
      kick.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    // Hold the serving loop's settle: the wave that computes the intent
    // stays OPEN while the first runtime life optimistically enacts and
    // is then disposed — the intent commits only after the reload, so
    // no ack can precede it (the deterministic LT8 window).
    await waitUntil(
      () => servingManager !== undefined,
      "the serving runtime to come up",
    );
    const gate = Promise.withResolvers<void>();
    servingManager!.settleGate = gate.promise;
    servingManager!.settleGateWhen = () => sidecarIdsIn(engine).length > 0;

    result.key("go").send({});
    // The OPTIMISTIC enactment (speculation.md §2) fires client-side
    // while the authoritative wave is held open.
    await waitUntil(
      () => firstLife.length === 1,
      "the optimistic enactment in the first life",
    );
    cancelDemand();
    // RELOAD before intent-and-ack: dispose the RUNTIME (the overlay,
    // the channel, and the enacted-nonce record die with it — LT8's
    // reload-wiped overlay); `closeStorage: false` keeps the manager
    // and its session alive for the second life. Then release the wave.
    await clientRuntime.dispose({ closeStorage: false });
    servingManager!.settleGate = undefined;
    servingManager!.settleGateWhen = undefined;
    gate.resolve();

    await waitUntil(
      () => intentsOf(engine, aliceSigner.did(), pinnedSession).length === 1,
      "the intent to commit after the reload",
    );

    // Life 2: a fresh Runtime over the persisted session — fresh
    // (empty) enacted record. Its effects channel resubscribes (the
    // construction sweep covers the already-open space), re-reads the
    // unacked intent, and RE-ENACTS — LT8's accepted window — then
    // acks once; the next wave retires once.
    const secondLife: string[] = [];
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
      navigateCallback: (target) => {
        secondLife.push(target.getAsNormalizedFullLink().id);
      },
    });

    await waitUntil(
      () => secondLife.length === 1,
      "the second life to re-enact the unacked intent",
    );
    await waitUntil(
      () => {
        const value = effectsInstanceOf(
          engine,
          aliceSigner.did(),
          pinnedSession,
        );
        const entries = Array.isArray(value.entries) ? value.entries : [];
        const acks = value.acks ?? {};
        return entries.length === 0 && Object.keys(acks).length === 0;
      },
      "the ack to land and the entry to retire",
    );

    // Exactly-once per nonce WITHIN each life; the re-enactment took a
    // reload (LT8's bound: enactments ≤ 1 + reloads). No further
    // navigation after retirement.
    await clientRuntime.idle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(firstLife.length).toBe(1);
    expect(secondLife.length).toBe(1);
  });

  it("the receipt-race divert pin (review MINOR-3): the flag-ON client's navigate-deferred start commits NOTHING authored — zero authored-class commits ever touch the served navigation's target doc", async () => {
    // The structural pin the divert lacked: neutralizing the
    // speculative-consequence stamp (runner.ts's deferred-start
    // `speculativeConsequence` — the event-handler kind that routes
    // the startTx into the overlay) left the FULL runner suite green,
    // because every existing assertion tolerated the client's authored
    // receipt create racing the serving side (a ~1-in-3 live flake,
    // not a deterministic red). This assert is deterministic: with the
    // divert intact, NO authored-class commit ever writes the target
    // doc (the overlay is process-local; the serving side's create is
    // derived-class); with it neutralized, the client's deferred start
    // ALWAYS commits the result pattern's docs authored — win or lose
    // the race — and the count goes positive.
    const navigations: string[] = [];
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations },
    ));
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, NAVIGATE_PATTERN, {
      arg: "divert-arg",
      result: "divert-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("go").send({});
    const sessionId = clientManager.id;
    let target: string | undefined;
    await waitUntil(
      () => {
        const intents = intentsOf(engine, aliceSigner.did(), sessionId);
        if (intents.length === 1) {
          target = String(intents[0].args?.target?.id ?? "");
          return true;
        }
        return false;
      },
      "the served intent (with its target) to land",
    );
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // THE STAMP WITNESS (deterministic): the client half diverted
    // exactly TWO event-handler-kind seals — the handler's speculative
    // echo AND the navigate-deferred start (the startTx stamped as a
    // speculative handler consequence). With the divert neutralized
    // (the startTx stamped bookkeeping) the second seal disappears —
    // and the authored-commit assert below CANNOT catch that alone,
    // because the neutralized start's authored commit usually LOSES
    // its create-only race against the serving side's own create and
    // is rejected whole, leaving no authored trace (the ~1-in-3 live
    // flake was the winning arm).
    expect(clientRuntime.speculationOverlay?.eventEchoSealCount).toBe(2);

    // Non-vacuity: the target doc EXISTS, created server-side
    // (derived-class revisions present)…
    const targetRevisions = engine.database.prepare(
      `SELECT c.class AS class, COUNT(*) AS n
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id = :id GROUP BY c.class`,
    ).all({ id: target }) as Array<{ class: string; n: number }>;
    expect(
      targetRevisions.filter((row) => row.class === "derived").length,
    ).toBeGreaterThan(0);
    // …and NOT ONE of its revisions rode an authored-class commit: the
    // client's navigate-deferred start diverted (protocol.md §1's
    // "client commits nothing but intent" posture) — the belt over the
    // client-WINS arm of the race, where a neutralized divert's
    // authored create lands and this query goes positive.
    expect(
      targetRevisions.filter((row) => row.class === "authored"),
    ).toEqual([]);

    cancelDemand();
  });

  it("same-principal two-session isolation, the client half (review MINOR-5): s2's channel neither enacts nor acks s1's intent — and stays live for its own", async () => {
    // The sharpest instance pair — `session:p:s1` vs `session:p:s2`
    // differ ONLY in the session segment. The store half (rows land in
    // s1's instance only) is pinned memory-side (v2-scoped-push /
    // v2-effects-doc); this is the CLIENT twin: the second session's
    // channel must not enact s1's intent (no navigation) and must not
    // ack it (an ack is an authored write into the ACKER's OWN
    // instance — a stray s2 ack would materialize s2's instance).
    const s1Navigations: string[] = [];
    const s2Navigations: string[] = [];
    const s1Session = crypto.randomUUID();
    const s2Session = crypto.randomUUID();
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
      { navigations: s1Navigations, sessionId: s1Session },
    ));
    const s2 = openClient(aliceSigner, {
      navigations: s2Navigations,
      sessionId: s2Session,
    });
    extraManagers.push(s2.manager);
    extraRuntimes.push(s2.runtime);

    const engine = await server.engineForSpace(space);
    const { result } = await standUp(clientRuntime, NAVIGATE_PATTERN, {
      arg: "twin-arg",
      result: "twin-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    // s2 joins the same piece (its channel subscribes to this space).
    const s2Result = s2.runtime.getCell<Record<string, unknown>>(
      space,
      "twin-result",
      undefined,
    );
    await s2Result.sync();

    host = newHost();
    // s1 clicks: intent → s1's instance; s1 enacts + acks; retirement.
    result.key("go").send({});
    await waitUntil(
      () => {
        if (s1Navigations.length === 0) return false;
        const value = effectsInstanceOf(engine, aliceSigner.did(), s1Session);
        const entries = Array.isArray(value.entries) ? value.entries : [];
        const acks = value.acks ?? {};
        return entries.length === 0 && Object.keys(acks).length === 0;
      },
      "s1's intent to land, enact, ack, and retire",
    );
    await s2.runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The twin: s2 never navigated, never recorded an enactment, and
    // its OWN instance was never materialized by a stray ack.
    expect(s2Navigations.length).toBe(0);
    expect(s2.runtime.effectsChannel?.enactedNonceCount).toBe(0);
    const s2Value = effectsInstanceOf(engine, aliceSigner.did(), s2Session);
    expect(Array.isArray(s2Value.entries) ? s2Value.entries : []).toEqual([]);
    expect(Object.keys(s2Value.acks ?? {})).toEqual([]);

    // Liveness (the twin is not vacuous): s2's OWN fire navigates on
    // s2 and lands in s2's instance lifecycle. The serving drain can
    // transiently DEFER a fresh append behind a lagging sidecar view
    // (the pre-existing event-view-lag arm; its retry is input-driven
    // and re-syncs per attempt), and this space is otherwise quiet —
    // so nudge the loop with benign authored kicks while waiting, the
    // same recovery any real space gets from ambient traffic.
    s2Result.key("go").send({});
    {
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "twin-drain-kick",
        undefined,
      );
      await kick.sync();
      const deadline = Date.now() + 20_000;
      let nudges = 0;
      while (s2Navigations.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for s2's own fire to enact");
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (s2Navigations.length === 0 && nudges < 8) {
          nudges += 1;
          const tx = clientRuntime.edit();
          kick.withTx(tx).set({ n: nudges });
          await tx.commit();
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    // …and s1 stayed at exactly its own single navigation.
    expect(s1Navigations.length).toBe(1);

    cancelDemand();
  });

  it("the NO-CONTEXT refusal (builtins.md §4): a navigateTo outside any client-fired event's consequences writes no intent and does not wedge the wave", async () => {
    // A STATICALLY wired navigateTo (not handler-returned): its target
    // arrives via an ordinary authored write, so the served run carries
    // no firing-event context — the split contract's refusal arm
    // (implemented as a loud refusal-without-throw: a re-instantiated
    // past instance is indistinguishable at the action — the Phase-4
    // PR's flagged surface iii).
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const STATIC_NAVIGATE_PATTERN = [
      "import { navigateTo, pattern } from 'commonfabric';",
      "export default pattern<",
      "  { target: unknown },",
      "  { nav: boolean }",
      ">(({ target }) => ({ nav: navigateTo(target) }));",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: STATIC_NAVIGATE_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ target: unknown }>(
      space,
      "noctx-arg",
      undefined,
    );
    const destination = clientRuntime.getCell<{ label: string }>(
      space,
      "noctx-destination",
      undefined,
    );
    const result = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "noctx-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await destination.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      destination.withTx(seed).set({ label: "somewhere" });
      argument.withTx(seed).set({ target: destination as never });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    // Kick the serving side (activation + demand): an authored write.
    {
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "noctx-kick",
        undefined,
      );
      await kick.sync();
      const tx = clientRuntime.edit();
      kick.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    // Let the serving side settle a few cycles, then assert: NO intent
    // exists in ANY effects instance (the refusal wrote nothing), and
    // the loop is healthy (the watermark advanced past the kick).
    await waitUntil(
      () => (host!.spaceServer(space)?.watermark ?? 0) > 0,
      "the serving loop to settle the kick",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const instances = engine.database.prepare(
      `SELECT scope_key FROM head WHERE id = :id AND op != 'delete'`,
    ).all({ id: SERVER_EXECUTION_EFFECTS_DOC_ID }) as Array<
      { scope_key: string }
    >;
    for (const row of instances) {
      const value = Engine.readState(engine, {
        id: SERVER_EXECUTION_EFFECTS_DOC_ID,
        scopeKey: row.scope_key,
      })?.document?.value as SessionEffectsDocValue | undefined;
      expect(value?.entries ?? []).toEqual([]);
    }
    cancelDemand();
  });

  it("the SESSIONLESS refusal (builtins.md §4): a chain with no acting session reaches navigateTo — no intent is written anywhere", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(
      clientRuntime,
      NAVIGATE_PATTERN,
      { arg: "sessionless-arg", result: "sessionless-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    // Prime: a real fire so the sidecar and stream link exist.
    result.key("go").send({});
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the primed append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0]?.consequenced === true;
      },
      "the primed event to consequence",
    );
    const primed =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries![0];
    const intentsBefore =
      intentsOf(engine, aliceSigner.did(), clientManager.id).length;

    // A delegated append with an acting USER but NO acting session —
    // the sessionless chain (`firedAt.session = "server"`,
    // events.md §2). Its handler runs; the navigateTo it returns MUST
    // refuse (no client exists to enact).
    await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: sidecarId,
      targetStreamLink: primed.stream,
      eventId: `sessionless-${crypto.randomUUID()}`,
      payload: {},
      actingPrincipal: aliceSigner.did(),
      capabilityRef: "cap-sessionless",
      sessionId: `service:${space}`,
      localSeq: 999_101,
    });

    // The handler's own consequence still lands (value += 1) — the
    // refusal is the BUILTIN's, not the event's.
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) >= 2;
      },
      "the sessionless event's handler consequence to land",
    );
    // Let the wave family settle, then assert: no NEW intent anywhere —
    // not in alice's instance, not in a service-keyed one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      intentsOf(engine, aliceSigner.did(), clientManager.id).length,
    ).toBe(intentsBefore);
    const sessionInstances = engine.database.prepare(
      `SELECT scope_key FROM head WHERE id = :id AND op != 'delete'`,
    ).all({ id: SERVER_EXECUTION_EFFECTS_DOC_ID }) as Array<
      { scope_key: string }
    >;
    for (const row of sessionInstances) {
      expect(row.scope_key.includes("server")).toBe(false);
    }

    cancelDemand();
  });

  it("the LT3 refusal: an acting session NOT connected to the computing space gets no intent (cross-space navigateTo deferred)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(
      clientRuntime,
      NAVIGATE_PATTERN,
      { arg: "lt3-arg", result: "lt3-result" },
    );
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("go").send({});
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the primed append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0]?.consequenced === true;
      },
      "the primed event to consequence",
    );
    const primed =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries![0];

    // A delegated append carrying a session that never connected to
    // THIS space (the cross-space delivery shape): the acting session
    // has no channel here — the intent write refuses (LT3).
    await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: sidecarId,
      targetStreamLink: primed.stream,
      eventId: `lt3-${crypto.randomUUID()}`,
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "ghost-session-never-connected",
      capabilityRef: "cap-lt3",
      sessionId: `service:${space}`,
      localSeq: 999_201,
    });

    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) >= 2;
      },
      "the LT3 event's handler consequence to land",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      intentsOf(
        engine,
        aliceSigner.did(),
        "ghost-session-never-connected",
      ).length,
    ).toBe(0);

    cancelDemand();
  });
});
