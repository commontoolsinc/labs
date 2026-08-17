// Server-execution v2 Phase 3 (D-v2-1): events-down, end to end against
// a real memory server, a live ExecutorHost, and flag-ON clients.
//
// - the FULL loop: a client fire commits ONLY the event; the
//   SpaceServer drains it, runs the handler AUTHORITATIVELY, and
//   commits consequences in ONE derived commit carrying
//   `consequenceOf` — with the entry consequence-marked and the
//   per-stream `eventWatermark` advanced in the SAME transaction
//   (events.md §2, §4); the client's echo retires on the consequence
//   signal and the authoritative value renders;
// - exactly-once across restart (the plan's kill-between gate): an
//   append committed with NO serving host is drained once at
//   activation (serving-loop.md §6 step 4); a second activation
//   re-runs nothing (the consequenced mark + the watermark exclude
//   it);
// - the ERROR arm: a throwing handler's error IS the consequence
//   (events.md §5) — the entry carries it, the stream does not wedge;
// - the DROP arm: an event whose piece can NEVER start defers for the
//   bounded creation-race window, then hardens into the
//   `{status: "dropped", reason}` notice (events.md §5's predicate;
//   OW19's conflation caution bounds the deferral, it does not erase
//   the drop);
// - the SKIP arm: an at-or-below-horizon duplicate admission is
//   skipped at processing, counted `skippedIdempotent`, and passed by
//   the frontier (events.md §4/§5; the model's C2-dedupe pin);
// - LD1 at cardinality 2: two users' fires run as their OWN actors —
//   `firedAt` stamps distinct users, and the wave's attribution
//   annotations carry each event's actor on its consequence writes
//   (protocol.md §1/§2, scopes.md §5).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  decodeMemoryBoundary,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/** The serving-loop harness's settle-gate seam (see
 * executor-serving-loop.test.ts): when set, the loop's settle hangs at
 * its `inputSynced` barrier until the gate resolves — deterministically
 * holding an open (sealed, uncommitted) wave so a rival authored commit
 * can race a drained handler's consequence (the C8d raced-cascade
 * test). `settleGateWhen` scopes the hold: the serving loop runs a
 * settle in EVERY cycle (empty ones included), so an unconditional gate
 * would catch some idle cycle already in flight and starve the drain
 * the test needs — the predicate lets exactly the cycle that SEALED the
 * watched state hang. Undefined everywhere else. */
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

const spaceSigner = await Identity.fromPassphrase("events down space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("events down service");
const aliceSigner = await Identity.fromPassphrase("events down alice");
const bobSigner = await Identity.fromPassphrase("events down bob");

/** The TRUE sidecar doc ids in the store (the client derives the id
 * from the RESOLVED stream link — a pattern's stream resolves into an
 * internal fid doc, so tests read the ids back from the head prefix
 * rather than re-deriving them). */
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

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

const CASCADE_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const secondHandler = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
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

const THROW_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const explode = handler<unknown, { value: Writable<number> }>(",
  "  () => { throw new Error('handler exploded deliberately'); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; explode: Stream<unknown> }",
  ">(({ value }) => ({ value, explode: explode({ value }) }));",
].join("\n");

describe("Phase 3 events-down (serving side)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let extraManagers: EmulatedStorageManager[];
  let extraRuntimes: Runtime[];
  /** The live serving runtime/manager (set by newHost's createRuntime)
   * — the C8d raced-cascade test reads sealed state through them and
   * closes the settle gate. */
  let servingRuntime: Runtime | undefined;
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
        servingRuntime = runtime;
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
    servingRuntime = undefined;
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
  ): { manager: EmulatedStorageManager; runtime: Runtime } => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
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

  it("the full loop: fire → drain → authoritative handler → ONE derived commit with consequenceOf + mark + watermark → echo retires", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "full-arg",
      result: "full-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    const before = Engine.serverSeq(engine);
    // The durable-ack coupling (verdict blocker, 2026-08-12): the send's
    // settle callback fires from the append + authoritative consequence
    // outcome — captured here, asserted after the consequence lands.
    let ackStatus: string | undefined;
    (result.key("bump") as unknown as {
      send(
        value: unknown,
        onCommit?: (tx: { status(): { status: string } }) => void,
      ): unknown;
    }).send({}, (ackTx) => {
      ackStatus = ackTx.status().status;
    });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    // The speculative echo alone is NOT the acknowledgment: nothing has
    // consequenced yet.
    expect(ackStatus).toBeUndefined();

    // The serving side processes the event: the sidecar entry is
    // marked consequenced and the per-stream watermark advances to its
    // seq — in the SAME derived commit as the handler's consequence
    // (events.md §4).
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true &&
          value?.eventWatermark === entry?.seq;
      },
      "the entry to consequence and the stream watermark to advance",
    );
    const sidecar = Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue;
    const entry = sidecar.entries![0];
    expect(entry.firedAt?.user).toBe(aliceSigner.did());
    expect(entry.error).toBeUndefined();
    expect(entry.status).toBeUndefined();

    // ONE derived commit carries consequenceOf = [the event] AND the
    // durable consequence (the argument doc's bump).
    const consequenceRows = engine.database.prepare(
      `SELECT seq, consequence_of FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { seq: number; consequence_of: string }
    >;
    const carrying = consequenceRows.filter((row) =>
      row.consequence_of.includes(entry.eventId)
    );
    expect(carrying.length).toBe(1);
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 1;
      },
      "the handler consequence to land durably",
    );

    // The client: the echo retired (the consequence signal — or the
    // watermark backstop — withdrew it) and the authoritative value
    // renders through the store.
    await waitUntil(
      () => (clientRuntime.speculationOverlay?.entryCount(space) ?? 0) === 0,
      "the echo to retire",
    );
    await waitUntil(
      () => (argument.key("value").get() as number | undefined) === 1,
      "the authoritative value to render",
    );

    // Counters (testing.md §4): the drain counted the event.
    const stats = host!.stats();
    expect(stats.events.appended).toBeGreaterThanOrEqual(1);
    expect(stats.events.processed).toBeGreaterThanOrEqual(1);
    // The durable ack settled — from the DELIVERED append and the
    // consequenced handling, not the local echo — and reads non-error.
    await waitUntil(
      () => ackStatus !== undefined,
      "the durable-ack settle callback",
    );
    expect(ackStatus).not.toBe("error");
    cancelDemand();
  });

  it("exactly-once across restart: an append committed with NO host drains once at activation; a second activation re-runs nothing (serving-loop §6 step 4)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "restart-arg",
      result: "restart-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Fire with NO serving host: the append commits durably; nothing
    // processes it — the kill-between-event-and-consequence window.
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    {
      const value = Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined;
      expect(value?.entries?.length).toBe(1);
      expect(value?.entries?.[0].consequenced).toBeUndefined();
    }

    // "Restart": the host comes up. A real restart's clients RECONNECT
    // (session open → the activation hook); the emulated fixture keeps
    // sessions alive across the host swap, so an authored poke stands
    // in for the reconnect. Activation's reprocess scan (§6 step 4)
    // then drains the undelivered event exactly once.
    host = newHost();
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "restart-activate", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 1;
      },
      "the recovered event's consequence",
    );
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.[0].consequenced === true;
      },
      "the recovered entry to be marked",
    );

    // Kill AFTER consequences; reactivate: the idempotency rule replays
    // nothing — the consequence value stays exactly-once.
    await host.close();
    host = newHost();
    // A fresh authored poke activates the space again.
    const poke = clientRuntime.edit();
    clientRuntime.getCell<number>(space, "restart-poke", undefined)
      .withTx(poke).set(1);
    expect((await poke.commit()).error).toBeUndefined();
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "reactivation",
    );
    // Give the loop a settle: the value must never reach 2. The
    // negative is sharpened past the bare value read (round-2 thread
    // T24): a wrong re-run's consequence commit carries
    // consequence_of = [the event] — so count those DIRECTLY. Exactly
    // ONE such commit may ever exist, whatever else the loop commits
    // (watermark advances move the seq legitimately, so seq stability
    // is NOT the observable).
    const eventId = (Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue).entries![0].eventId;
    const consequenceCommitsFor = () =>
      (engine.database.prepare(
        `SELECT consequence_of FROM "commit"
         WHERE class = 'derived' AND consequence_of IS NOT NULL`,
      ).all() as Array<{ consequence_of: string }>).filter((row) =>
        row.consequence_of.includes(eventId)
      ).length;
    expect(consequenceCommitsFor()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    {
      const doc = Engine.read(engine, {
        id: argument.getAsNormalizedFullLink().id,
      });
      expect((doc?.value as { value?: number })?.value).toBe(1);
      expect(consequenceCommitsFor()).toBe(1);
    }
    cancelDemand();
  });

  it("the ERROR arm: a throwing handler's error IS the consequence — the entry carries it and the stream does not wedge (events.md §5)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, THROW_PATTERN, {
      arg: "error-arg",
      result: "error-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("explode").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true &&
          typeof entry?.error === "string" &&
          value?.eventWatermark === entry?.seq;
      },
      "the error consequence + frontier advance",
    );
    const value = Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue;
    expect(value.entries![0].error).toContain("handler exploded");
    // No consequence write landed: the arg doc holds the seed value.
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(0);
    cancelDemand();
  });

  it("the SKIP arm: an at-or-below-horizon duplicate admission is skipped, counted, and passed by the frontier (events.md §4/§5; C2-dedupe)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "skip-arg",
      result: "skip-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("bump").send({});
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        const entry = value?.entries?.[0];
        return entry?.consequenced === true;
      },
      "the original to consequence",
    );
    const original =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries![0];

    // The at-or-below-horizon duplicate: redelivered via the delegated
    // path (the outbox's re-send shape) AFTER the watermark passed the
    // original — admission lets it through (events.md §4's horizon
    // bound), processing must skip it.
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: sidecarId,
      targetStreamLink: original.stream,
      eventId: original.eventId,
      payload: original.payload ?? {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "resend-session",
      capabilityRef: "cap-resend",
      sessionId: `service:${space}`,
      localSeq: 999_001,
    });
    expect(delivered.deduped).toBe(false);

    await waitUntil(
      () => (host!.stats().events.skippedIdempotent ?? 0) >= 1,
      "the duplicate to be skipped and counted",
    );
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return value?.entries?.length === 2 &&
          value.entries[1].consequenced === true &&
          value.eventWatermark === value.entries[1].seq;
      },
      "the duplicate to be passed by the frontier (non-wedging)",
    );
    // Exactly-once: the consequence ran ONCE.
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(1);
    cancelDemand();
  });

  it("LD1 at cardinality 2: two users' fires run as their OWN actors — firedAt stamps each, and the consequence commits carry each event's acting user (protocol.md §1/§2)", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient(
      aliceSigner,
    ));
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, BUMP_PATTERN, {
      arg: "ld1-arg",
      result: "ld1-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // Bob joins the same piece.
    const bob = openClient(bobSigner);
    extraManagers.push(bob.manager);
    extraRuntimes.push(bob.runtime);
    const bobResult = bob.runtime.getCell<Record<string, unknown>>(
      space,
      "ld1-result",
      undefined,
    );
    await bobResult.sync();

    host = newHost();
    const before = Engine.serverSeq(engine);
    result.key("bump").send({});
    bobResult.key("bump").send({});
    await clientRuntime.idle();
    await bob.runtime.idle();
    await clientRuntime.storageManager.synced();
    await bob.runtime.storageManager.synced();

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the appends to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    await waitUntil(
      () => {
        const value = Engine.read(engine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return (value?.entries?.length ?? 0) >= 2 &&
          value!.entries!.every((entry) => entry.consequenced === true);
      },
      "both events to consequence",
    );
    const entries =
      (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
        .entries!;
    const actors = new Set(entries.map((entry) => entry.firedAt?.user));
    expect(actors.has(aliceSigner.did())).toBe(true);
    expect(actors.has(bobSigner.did())).toBe(true);

    // The attribution half (protocol.md §1): each event's consequence
    // writes are annotated with ITS actor — the wave ran two handler
    // runs as two principals and never merged them.
    const attributed = new Map<string, string>();
    const derivedRows = engine.database.prepare(
      `SELECT consequence_of, annotations FROM "commit"
       WHERE seq > :from_seq AND class = 'derived'
         AND consequence_of IS NOT NULL AND annotations IS NOT NULL`,
    ).all({ from_seq: before }) as Array<
      { consequence_of: string; annotations: string }
    >;
    for (const row of derivedRows) {
      const consequenceOf = decodeMemoryBoundary(
        row.consequence_of,
      ) as string[];
      const annotations = decodeMemoryBoundary(row.annotations) as Array<
        { actingUser?: string }
      >;
      for (const eventId of consequenceOf) {
        const entry = entries.find((e) => e.eventId === eventId);
        for (const annotation of annotations) {
          if (
            annotation.actingUser !== undefined &&
            entry?.firedAt?.user === annotation.actingUser
          ) {
            attributed.set(eventId, annotation.actingUser);
          }
        }
      }
    }
    const aliceEvent = entries.find(
      (entry) => entry.firedAt?.user === aliceSigner.did(),
    )!;
    const bobEvent = entries.find(
      (entry) => entry.firedAt?.user === bobSigner.did(),
    )!;
    expect(attributed.get(aliceEvent.eventId)).toBe(aliceSigner.did());
    expect(attributed.get(bobEvent.eventId)).toBe(bobSigner.did());

    // Both bumps survived (the two-user semantics — each handler run
    // read the other's committed consequence or requeued and re-ran).
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 2;
      },
      "both consequences to land",
    );
    cancelDemand();
  });

  it("the DROP arm: an event whose piece can never start defers through the creation-race window, then drops with the events.md §5 notice", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    host = newHost();
    // An entry whose stream points at a doc that IS no piece and never
    // will be: the drain defers (cold-view creation race) for the
    // bounded window, then hardens into the drop notice.
    const neverAPieceStream = { id: "of:no-such-piece", path: ["stream"] };
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(neverAPieceStream),
      targetStreamLink: neverAPieceStream,
      eventId: "evt-unrunnable",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "drop-session",
      capabilityRef: "cap-drop",
      sessionId: `service:${space}`,
      localSeq: 990_100,
    });
    expect(delivered.deduped).toBe(false);
    await waitUntil(
      () => {
        const value = Engine.read(engine, {
          id: streamEntriesDocId(neverAPieceStream),
        })?.value as StreamEventsDocValue | undefined;
        const entry = value?.entries?.[0];
        return entry?.status === "dropped" &&
          entry?.consequenced === true &&
          value?.eventWatermark === entry?.seq;
      },
      "the dropped-event notice + frontier pass (non-wedging)",
      30_000,
    );
    const entry = (Engine.read(engine, {
      id: streamEntriesDocId(neverAPieceStream),
    })?.value as StreamEventsDocValue).entries![0];
    expect(entry.reason).toContain("no runnable handler");
    // The space can PARK again: the drop cleared the undelivered-events
    // criterion (a perpetual deferral would wedge it active forever).
    expect(Engine.selectPendingStreamEventDocs(engine).length).toBe(0);
  });

  it("a deferral consumes REAL TIME, never back-to-back waves: the drop cannot land inside the creation-race window (verdict blocker, 2026-08-12)", async () => {
    // Pre-fix, a deferral set #eventScanOwed synchronously, #hasWork()
    // spun the next wave at once, and the whole 8-slot budget burned
    // in immediate succession — an event whose creation input was
    // milliseconds away was permanently dropped. Post-fix each retry
    // waits for input or the 250ms backstop tick, so the budget spans
    // >= threshold * tick of wall clock. The pin: at +500ms the entry
    // must still be PENDING (at most ~2 ticks consumed); the drop
    // still arrives eventually (the DROP-arm test above).
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    host = newHost();
    const laggardStream = { id: "of:laggard-piece", path: ["stream"] };
    const delivered = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(laggardStream),
      targetStreamLink: laggardStream,
      eventId: "evt-laggard",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "laggard-session",
      capabilityRef: "cap-laggard",
      sessionId: `service:${space}`,
      localSeq: 990_200,
    });
    expect(delivered.deduped).toBe(false);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "activation on the delivered event",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const value = Engine.read(engine, {
      id: streamEntriesDocId(laggardStream),
    })?.value as StreamEventsDocValue | undefined;
    const entry = value?.entries?.[0];
    // Still pending: NOT consequenced, NOT dropped — the budget has
    // structurally not had time to exhaust (8 ticks x 250ms >> 500ms).
    expect(entry?.eventId).toBe("evt-laggard");
    expect(entry?.status).toBeUndefined();
    expect(entry?.consequenced).not.toBe(true);
    // The event is still discoverable work (nothing wedged, nothing
    // lost): the drop (or a late-arriving piece) resolves it later.
    expect(Engine.selectPendingStreamEventDocs(engine).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("an event-only admission RACING a park reactivates the space — the fire-time gate honors the undelivered-events criterion, not just live sessions (verdict blocker, 2026-08-12)", async () => {
    // Pre-fix, #reactivateAfterPark's fire-time gate required a live
    // client session: a delegated cross-space delivery (no client
    // anywhere) that raced a park chained the reactivation, which then
    // DECLINED — the delivered event sat unserved until some unrelated
    // trigger. serving-loop.md §1's ACTIVE criterion is sessions OR
    // undelivered events; the gate must check both.
    const engine = await server.engineForSpace(space);
    host = newHost();
    const parkRaceStream = { id: "of:park-race-piece", path: ["stream"] };
    const first = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(parkRaceStream),
      targetStreamLink: parkRaceStream,
      eventId: "evt-park-race-1",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "park-race-session",
      capabilityRef: "cap-park-race",
      sessionId: `service:${space}`,
      localSeq: 990_300,
    });
    expect(first.deduped).toBe(false);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "activation on the first delivered event",
    );
    const spaceServer = host!.spaceServer(space)!;
    // Start the park, then deliver DURING it: the admission hook sees a
    // registered, no-longer-active server and chains reactivation
    // behind the park.
    const parked = spaceServer.park("test-park-race");
    const second = await server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: streamEntriesDocId(parkRaceStream),
      targetStreamLink: parkRaceStream,
      eventId: "evt-park-race-2",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "park-race-session",
      capabilityRef: "cap-park-race",
      sessionId: `service:${space}`,
      localSeq: 990_301,
    });
    expect(second.deduped).toBe(false);
    await parked;
    // The chained reactivation must FIRE despite zero client sessions:
    // the engine holds undelivered events.
    expect(Engine.selectPendingStreamEventDocs(engine).length)
      .toBeGreaterThanOrEqual(1);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "reactivation on the event-only admission racing the park",
    );
  });

  it("same-space cascade (LT1): the served handler's send commits a durable wave-carried entry with the INHERITED actor — processed exactly once", async () => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(clientRuntime, CASCADE_PATTERN, {
      arg: "cascade-arg",
      result: "cascade-result",
    });
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    host = newHost();
    result.key("first").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // TWO sidecar docs materialize: the root fire's stream and the
    // cascade's — the served run of `first` emitted `second`'s entry as
    // a WRITE WITHIN its wave (LT1), engine-stamped and declared, and
    // a later wave drained it (the budget-exhausted fallback shape).
    await waitUntil(
      () => {
        const ids = sidecarIdsIn(engine);
        if (ids.length < 2) return false;
        return ids.every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every(
            (entry) =>
              entry.consequenced === true &&
              typeof entry.seq === "number" &&
              value?.eventWatermark === entry.seq,
          );
        });
      },
      "both streams' entries to consequence with stamped seqs",
      30_000,
    );
    // The cascade entry carries the INHERITED actor (events.md §2:
    // events run as the session they originated from) — the root
    // (user, session) preserved hop by hop.
    const cascadeEntries = sidecarIdsIn(engine).flatMap((
      id,
    ) => ((Engine.read(engine, { id })?.value as StreamEventsDocValue)
      .entries ?? [])
    );
    expect(cascadeEntries.length).toBe(2);
    for (const entry of cascadeEntries) {
      expect(entry.firedAt?.user).toBe(aliceSigner.did());
    }
    // Exactly once: 1 + 10, never doubled.
    await waitUntil(
      () => {
        const doc = Engine.read(engine, {
          id: argument.getAsNormalizedFullLink().id,
        });
        return ((doc?.value as { value?: number })?.value ?? 0) === 11;
      },
      "the cascade's consequences to land exactly once",
      30_000,
    );
    // Give a settle beat: the value must STAY 11 (no re-run).
    await new Promise((resolve) => setTimeout(resolve, 500));
    const doc = Engine.read(engine, {
      id: argument.getAsNormalizedFullLink().id,
    });
    expect((doc?.value as { value?: number })?.value).toBe(11);
    cancelDemand();
  });

  it("C8d through the PRODUCTION cascade path (review 2026-08-11 M2): a raced parent's requeue folds its same-wave cascade child — no orphan consequence, exactly-once on retry", async () => {
    // The reviewer's failure scenario at 71718250c: the C8d fold keyed
    // on `context.parentEventId`, which NOTHING in production set — the
    // LT1 same-space emission queued its cascade with only
    // {eventId, served:{firedAt}}. So when a drained parent P's
    // consequence raced into REQUEUE, its same-wave cascade child C
    // COMMITTED (the orphan), and P's retry re-emitted the cascade
    // under a FRESH id — C's consequence applied TWICE. This test
    // drives the WHOLE production chain (cell.ts's emission carriage →
    // the dispatch stamp → the SpaceServer's #stampRun → the wave
    // fold), deterministically: the settle gate holds the sealed wave
    // open while a rival authored commit races P's consequence.
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);

    // The CHILD piece: its handler bumps the CHILD's OWN arg doc by 10.
    // A separate doc from the parent's — only the cascade closure ties
    // the two runs' fates (the rival races the PARENT's doc only).
    const CHILD_TEN_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    // The PARENT piece: bumps its own arg doc AND sends on the child's
    // stream (carried in through an argument link) — the LT1 same-space
    // emission, produced by a DRAINED handler run.
    const PARENT_FIRE_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const fire = handler<",
      "  unknown,",
      "  { value: Writable<number>; target: Stream<unknown> }",
      ">((_ev, { value, target }) => {",
      "  value.set((value.get() ?? 0) + 1);",
      "  target.send({});",
      "});",
      "export default pattern<",
      "  { value: Writable<number>; target: Stream<unknown> },",
      "  { value: number; fire: Stream<unknown> }",
      ">(({ value, target }) => ({ value, fire: fire({ value, target }) }));",
    ].join("\n");

    const child = await standUp(clientRuntime, CHILD_TEN_PATTERN, {
      arg: "c8d-child-arg",
      result: "c8d-child-result",
    });
    const parentCompiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_FIRE_PATTERN }],
    }, { space });
    const parentArg = clientRuntime.getCell<{
      value: number;
      target: unknown;
    }>(space, "c8d-parent-arg", undefined);
    const parentResult = clientRuntime.getCell<Record<string, unknown>>(
      space,
      "c8d-parent-result",
      parentCompiled.resultSchema,
    );
    await parentArg.sync();
    await parentResult.sync();
    {
      const seed = clientRuntime.edit();
      parentArg.withTx(seed).set({
        value: 0,
        target: child.result.key("bump"),
      } as never);
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, parentCompiled, parentArg, parentResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelChildDemand = child.result.sink(() => {});
    const cancelParentDemand = parentResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // A LONG flush deadline: the gated wave must never exhaust while
    // the rival is being injected.
    host = newHost({ flushDeadlineMs: 30_000, idleParkMs: 600_000 });
    // The client's session predates the host — an authored poke
    // activates the space (the restart test's recipe).
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "c8d-activate", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "the space to activate",
    );

    const parentArgId = parentArg.getAsNormalizedFullLink().id;
    const childArgId = child.argument.getAsNormalizedFullLink().id;
    const engineValueOf = (id: string): number | undefined =>
      (Engine.read(engine, { id })?.value as { value?: number } | undefined)
        ?.value;

    // WARM-UP fire, ungated: proves the serving side has BOTH pieces
    // demand-loaded and the full cascade path works (parent +1, child
    // +10, everything consequenced). Without it the gated fire's first
    // drain would DEFER on the cold piece load — and the gate holds
    // the later wave the deferral needs.
    parentResult.key("fire").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () =>
        engineValueOf(parentArgId) === 1 && engineValueOf(childArgId) === 10,
      "the warm-up cascade to land",
      30_000,
    );
    await waitUntil(
      () =>
        sidecarIdsIn(engine).every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every((entry) =>
            entry.consequenced === true
          );
        }),
      "the warm-up entries to consequence",
      30_000,
    );
    // Let the loop settle into wait-for-input (NOT mid-settle) before
    // the gate closes — a gated PRIOR wave would absorb the rival
    // before the parent ever read. W chases AUTHORED inputs only, so
    // the probe is a fresh authored poke whose head seq W must claim.
    {
      const poke = clientRuntime.edit();
      clientRuntime.getCell<number>(space, "c8d-settle-poke", undefined)
        .withTx(poke).set(1);
      expect((await poke.commit()).error).toBeUndefined();
    }
    await clientRuntime.storageManager.synced();
    const pokeId = clientRuntime.getCell<number>(
      space,
      "c8d-settle-poke",
      undefined,
    ).getAsNormalizedFullLink().id;
    const pokeSeq = Engine.selectDocHead(engine, {
      id: pokeId,
      scopeKey: "space",
    });
    expect(pokeSeq).toBeGreaterThan(0);
    await waitUntil(
      () => readWatermarkSeq(engine) >= pokeSeq,
      "the warm-up cycles to settle",
      30_000,
    );

    // Serving-side views of both consequence docs (read through the
    // wave's sealed overlay), synced BEFORE the gate closes.
    const servingParentArg = servingRuntime!.getCell<{ value: number }>(
      space,
      "c8d-parent-arg",
      undefined,
    );
    const servingChildArg = servingRuntime!.getCell<{ value: number }>(
      space,
      "c8d-child-arg",
      undefined,
    );
    await servingParentArg.sync();
    await servingChildArg.sync();

    const gate = Promise.withResolvers<void>();
    servingManager!.settleGate = gate.promise;
    // Engage only in the cycle that SEALED the raced parent (an idle
    // cycle's settle passes through) — parent==2 is visible ONLY
    // through the open wave's sealed overlay.
    servingManager!.settleGateWhen = () =>
      (servingParentArg.key("value").get() as number | undefined) === 2;
    try {
      // The RACED fire: parent P drains, bumps its doc (1 → 2), emits
      // the cascade; the child C runs in the SAME wave (10 → 20 on its
      // own doc). Both seal; the gated settle holds the wave open.
      parentResult.key("fire").send({});
      await clientRuntime.idle();
      await clientRuntime.storageManager.synced();
      await waitUntil(
        () =>
          (servingParentArg.key("value").get() as number | undefined) === 2 &&
          (servingChildArg.key("value").get() as number | undefined) === 20,
        "parent and cascade child to SEAL into the open wave",
      );

      // The rival races P's consequence: a whole-doc set of the
      // PARENT's arg doc (target link preserved) — a semantic conflict
      // no rebase commutes, so P REQUEUES at the wave commit.
      const storedParentArg = Engine.read(engine, { id: parentArgId })
        ?.value as Record<string, unknown>;
      Engine.applyCommit(engine, {
        sessionId: "rival-session",
        principal: "user:rival",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: parentArgId as never,
            value: {
              value: { ...storedParentArg, value: 1000 },
            } as never,
          }],
        },
      });
      gate.resolve();
    } finally {
      gate.resolve();
      servingManager!.settleGate = undefined;
      servingManager!.settleGateWhen = undefined;
    }

    // The wave commits: P requeues (its consequence raced the rival);
    // C FOLDS with it — pre-fix C's +10 COMMITTED here (the orphan),
    // and P's retry re-emitted the cascade under a FRESH id, applying
    // it AGAIN (child 30). With the fold, the retry's re-emission is
    // the ONLY application: the child lands at 20, exactly once, and
    // every entry consequences. (The PARENT's final value is
    // deliberately not pinned tight: the retry's read races the rival
    // frame's integration into the serving view, so it lands as a
    // field-level rebase either over the rival (2) or of it (1001) —
    // C8b's territory, not this fold's.)
    await waitUntil(
      () =>
        engineValueOf(childArgId) === 20 &&
        sidecarIdsIn(engine).every((id) => {
          const value = Engine.read(engine, { id })?.value as
            | StreamEventsDocValue
            | undefined;
          return (value?.entries ?? []).every((entry) =>
            entry.consequenced === true
          );
        }),
      "the folded cascade to land exactly once, everything consequenced",
      30_000,
    );
    // The settle beat: the child value must STAY 20 — never 30 (the
    // pre-fix double: orphan commit + fresh-id re-emission re-apply).
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(engineValueOf(childArgId)).toBe(20);
    expect([2, 1001]).toContain(engineValueOf(parentArgId));
    cancelChildDemand();
    cancelParentDemand();
  });
});
