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
// - the DROP arm: an event with no runnable handler gets the
//   `{status: "dropped", reason}` notice (events.md §5's predicate);
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
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

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

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
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
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    extraManagers = [];
    extraRuntimes = [];
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
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

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
    const sidecar = Engine.read(engine, { id: sidecarId })?.value as
      StreamEventsDocValue;
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
      () =>
        (clientRuntime.speculationOverlay?.entryCount(space) ?? 0) === 0,
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
    // Give the loop a settle: the value must never reach 2.
    await new Promise((resolve) => setTimeout(resolve, 500));
    {
      const doc = Engine.read(engine, {
        id: argument.getAsNormalizedFullLink().id,
      });
      expect((doc?.value as { value?: number })?.value).toBe(1);
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
    const value = Engine.read(engine, { id: sidecarId })?.value as
      StreamEventsDocValue;
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
    const original = (Engine.read(engine, { id: sidecarId })?.value as
      StreamEventsDocValue).entries![0];

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
    const entries = (Engine.read(engine, { id: sidecarId })?.value as
      StreamEventsDocValue).entries!;
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
});
