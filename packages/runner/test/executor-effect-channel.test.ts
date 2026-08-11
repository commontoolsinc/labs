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
      () =>
        intentsOf(engine, aliceSigner.did(), aliceSession).length === 1,
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
    // instance…
    await waitUntil(
      () => intentsOf(engine, aliceSigner.did(), sessionId).length === 1,
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
