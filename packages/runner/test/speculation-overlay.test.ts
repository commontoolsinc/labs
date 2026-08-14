// Server-execution v2 Phase 2: the client speculation overlay
// (speculation.md), end to end against a real memory server, a live
// ExecutorHost (the serving side), and a CLIENT runtime whose flag-ON
// posture is the phase's whole point:
//
// - a client derivation run REDIRECTS its writes into the overlay — the
//   echo renders immediately, the client commits NOTHING for it, and
//   the store's only derivation results are the SpaceServer's
//   derived-class commits (the by-construction removal of the client
//   derivation-commit path);
// - `synced()` never waits on a live overlay entry (the overlay is
//   process-memory only — speculation.md §1);
// - retirement is watermark-driven (speculation.md §4): the pushed
//   derived commit + the replicated watermark doc cover the entry, the
//   overlay empties, and the STORE value renders;
// - client HANDLER writes still commit authored-class (F10 — the
//   Phase-3 interim, protocol.md §1), and UI-binding/imperative writes
//   are untouched authorship;
// - a speculative run's post-commit effects follow the egress rule:
//   external-sink kinds are DROPPED (the client never performs egress
//   under the flag — README §3.5), while the reversible `navigateTo`
//   kind still enacts (optimistic navigation, speculation.md §2).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { waitForSettled } from "../src/executor/watermark.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";
import { isTerminalRejection } from "../src/storage/rejection.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";

const spaceSigner = await Identity.fromPassphrase("speculation overlay space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "speculation overlay service",
);
const aliceSigner = await Identity.fromPassphrase("speculation overlay alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Phase 2 speculation overlay", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let _servingRuntime: Runtime | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;

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
        _servingRuntime = runtime;
        await onServingRuntime?.(runtime);
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

  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    _servingRuntime = undefined;
    onServingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // EXPLICITLY flag-ON (review thread r3739139533): relying on the
    // host having pinned the ambient flag made the test order-dependent
    // — under an unset ambient env this runtime would run the OFF path
    // and assert authored-class commits for the wrong reason. No
    // servingPosture: a flag-ON CLIENT, speculation overlay by default.
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  };

  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  it("a client derivation run diverts to the overlay: instant echo with NO client commit, then watermark-driven retirement to the store value once the server serves (speculation.md §1, §4; the by-construction gate)", async () => {
    // PHASE A — the echo, deterministically BEFORE any serving exists:
    // the client runs the graph locally under the flag; the result
    // renders from the overlay and the store receives no derivation
    // commit at all (there is no code path for one).
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "spec-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "spec-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    // A live reader IS the demand (pull-based laziness): without one
    // the computed never runs anywhere.
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const clientSessions = new Set<string>();
    for (
      const record of Engine.selectCommitsSince(engine, { fromSeq: 0 })
    ) {
      clientSessions.add(record.sessionId);
    }
    const commitsBefore = Engine.selectCommitsSince(engine, {
      fromSeq: 0,
    }).length;

    // The authored input: an imperative (unstamped) write — ordinary
    // authorship, committed as today.
    const editTx = clientRuntime.edit();
    clientArg.withTx(editTx).set({ n: 6 });
    expect((await editTx.commit()).error).toBeUndefined();
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The ECHO: the client's speculative run rendered 42 with no server
    // executor in existence.
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the speculative echo to render",
    );
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);

    // (synced() above already proved the overlay never wedges the
    // client durability barrier — it resolved with a live entry
    // outstanding; speculation.md §1.)

    // The by-construction half, pre-serving: the ONLY new commit since
    // the snapshot is the authored argument write. The derivation
    // committed NOTHING.
    const preServing = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    expect(preServing.length).toBe(commitsBefore + 1);
    expect(preServing.every((record) => record.class !== "derived")).toBe(
      true,
    );

    // PHASE B — the authoritative path arrives: stand up the executor;
    // a fresh authored poke activates the space, the SpaceServer
    // derives, ONE derived commit lands + pushes, and the replicated
    // watermark doc covers the entries — retirement.
    onServingRuntime = async (runtime) => {
      const served = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "spec-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "spec-result",
        served.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, served, argument, result);
        const committed = await tx.commit();
        if (committed.error === undefined) break;
        if (attempt >= 4) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.idle();
    };
    host = newHost();
    const pokeTx = clientRuntime.edit();
    clientArg.withTx(pokeTx).set({ n: 8 });
    expect((await pokeTx.commit()).error).toBeUndefined();
    const pokeSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space activation",
    );
    await waitForSettled(clientRuntime, space, pokeSeq, {
      timeoutMs: 30_000,
    });

    // Retirement (speculation.md §4): the covering watermark retires
    // every entry; the STORE value renders through the same path.
    await waitUntil(
      () => overlay!.entryCount(space) === 0,
      "overlay retirement after settle",
      30_000,
    );
    await waitUntil(
      () => clientResult.key("total").get() === 56,
      "the authoritative value to render",
    );

    // The single-deriver envelope (testing.md §4): every derived-class
    // commit is the lease holder's own — none from any client session.
    const all = Engine.selectCommitsSince(engine, { fromSeq: 0 });
    const derived = all.filter((record) => record.class === "derived");
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const record of derived) {
      // testing.md §4's single-deriver envelope, BOTH halves: the
      // holder IS the lease-holding SpaceServer's service identity
      // (the DR1 holder is minted from the service DID), and no
      // client session produced it.
      expect(String(record.holder).startsWith(serviceSigner.did())).toBe(
        true,
      );
      expect(clientSessions.has(record.sessionId)).toBe(false);
    }
    cancelDemand();
  });

  it("client handler writes still commit authored-class (F10: the Phase-3 interim stands)", async () => {
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const HANDLER_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const bump = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
      ");",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; bump: Stream<unknown> }",
      ">(({ value }) => ({ value, bump: bump({ value }) }));",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "handler-arg",
      undefined,
    );
    const result = clientRuntime.getCell<
      { value: number; bump: unknown }
    >(
      space,
      "handler-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
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

    // Fire the handler client-side: its write is AUTHORED-class and
    // must land in the store (F10 — the client is still the handler
    // authority until Phase 3).
    const before = Engine.serverSeq(engine);
    result.key("bump").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => {
        const records = Engine.selectCommitsSince(engine, {
          fromSeq: before,
        });
        return records.some((record) => record.class === "authored");
      },
      "an authored-class handler commit",
    );
    // The consequence renders — and it is durable state, not an
    // overlay entry (the store carries the authored write).
    await waitUntil(
      () => {
        const value = argument.key("value").get() as number | undefined;
        return (value ?? 0) >= 1;
      },
      "the handler consequence to be readable",
    );
    cancelDemand();
  });

  it("a speculative run's egress effects are dropped; navigateTo still enacts (the egress rule, README §1/§3.5; speculation.md §2)", async () => {
    // Destination-level pin: no server needed — the allowlist decision
    // is the unit under test.
    const runtime = {
      storageManager: { open: () => ({ replica: {} }) },
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);
    const flushed: string[] = [];
    const effectOf = (kind: string): PostCommitSideEffect => ({
      id: `${kind}:1`,
      kind,
      flush: () => {
        flushed.push(kind);
      },
    });
    const derivationTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(derivationTx, {
      actionId: "spec-test",
      kind: "derivation",
    });
    const owned = destination.deferSealedEffects(derivationTx, [
      effectOf("navigateTo"),
      effectOf("fetch"),
      effectOf("sqlite-query"),
    ]);
    expect(owned).toBe(true);
    await waitUntil(
      () => flushed.length === 1,
      "the navigateTo enactment to flush",
      2_000,
    );
    expect(flushed).toEqual(["navigateTo"]);

    // A handler-kind tx keeps today's inline flush (ownership refused).
    const handlerTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(handlerTx, {
      actionId: "spec-test-handler",
      kind: "event-handler",
    });
    expect(destination.deferSealedEffects(handlerTx, [effectOf("fetch")]))
      .toBe(false);
  });

  it("an authored tx that read a speculative echo is refused LOUDLY at the client, terminal, with no wire export (speculation.md §6; leg-C RULED 2026-08-13)", async () => {
    // Pre-fix: the commit exported the echo's overlay-only localSeq as
    // a wire pending-read dependency; the server — which cannot
    // distinguish never-coming from not-yet-arrived — rejected it
    // `pending dependency not resolved: <seq>` (observed here before
    // the fix), and the scheduler's convergence loop spun its whole
    // retry window against the same live echo.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "basis-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "basis-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the speculative echo to render",
    );
    const overlay = clientRuntime.speculationOverlay!;
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    const commitsBefore =
      Engine.selectCommitsSince(engine, { fromSeq: 0 }).length;

    // The authored act: an unstamped tx reads the echo and writes a
    // copy elsewhere.
    const copyCell = clientRuntime.getCell<{ copied: number }>(
      space,
      "basis-copy",
      undefined,
    );
    await copyCell.sync();
    const authoredTx = clientRuntime.edit();
    const observed = clientResult.withTx(authoredTx).key("total").get();
    expect(observed).toBe(42);
    copyCell.withTx(authoredTx).set({ copied: observed as number });
    const outcome = await authoredTx.commit();

    // LOUD and terminal-classified — the client's own refusal, not a
    // server round trip.
    expect(outcome.error).toBeDefined();
    expect(outcome.error!.name).toBe("SpeculativeBasisError");
    expect(outcome.error!.message).toContain("speculative overlay layer");
    expect(isTerminalRejection(outcome.error)).toBe(true);
    // Nothing reached the wire: the engine saw no commit attempt land,
    // and the echo is untouched (the refusal is not a withdrawal).
    expect(Engine.selectCommitsSince(engine, { fromSeq: 0 }).length).toBe(
      commitsBefore,
    );
    expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
    // The refused write never rendered (refusal precedes the
    // optimistic apply) — no flicker, no revert.
    expect(copyCell.get()?.copied).toBeUndefined();
    cancelDemand();
  });

  it("a handler that read a speculative echo fails terminal on the FIRST attempt — no convergence-retry loop against a dependency that is never coming (leg-C 1b)", async () => {
    // Pre-fix: 17+ re-runs in a 5s window (observed), each re-reading
    // the live echo, until CommitConvergenceError after the full 30s
    // retry window. Post-fix: the terminal refusal classifies the
    // commit `terminal` at the scheduler, so the handler runs ONCE.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // Handler-run counting rides the console channel: the pattern
    // sandbox's globalThis is isolated from the test's, but its
    // console routes through the runtime's consoleHandler.
    let handlerRuns = 0;
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
      consoleHandler: (message) => {
        if (String(message.args?.[0]).includes("leg-c-handler-run")) {
          handlerRuns += 1;
          return [];
        }
        return message.args ?? [];
      },
    });

    const HANDLER_COPY_PATTERN = [
      "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
      "const copy = handler<unknown, { total: number; copied: Writable<number> }>(",
      "  (_ev, { total, copied }) => {",
      "    console.log('leg-c-handler-run');",
      "    copied.set(total);",
      "  },",
      ");",
      "export default pattern<",
      "  { n: number; copied: Writable<number> },",
      "  { total: number; copy: Stream<unknown>; copied: number }",
      ">(({ n, copied }) => {",
      "  const total = computed(() => n * 7);",
      "  return { total, copy: copy({ total, copied }), copied };",
      "});",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: HANDLER_COPY_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number; copied: number }>(
      space,
      "loop-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<
      { total: number; copy: unknown; copied: number }
    >(
      space,
      "loop-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const seed = clientRuntime.edit();
      clientArg.withTx(seed).set({ n: 6, copied: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the speculative echo to render",
    );

    handlerRuns = 0;
    clientResult.key("copy").send({});
    await clientRuntime.idle();
    // Observation window: with the terminal refusal the handler runs
    // exactly once; the pre-fix backoff loop re-ran it 10+ times here.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await clientRuntime.idle();
    expect(handlerRuns).toBe(1);
    // The refused write dropped (never committed, never rendered).
    expect(clientArg.key("copied").get()).toBe(0);
    cancelDemand();
  });

  it("an entry whose origin's accept verdict lands AFTER the covering watermark still retires — the ack wake re-sweeps; no further watermark event needed (leg-C 1c)", async () => {
    // Destination-level pin with a scripted replica: deterministic
    // control over the verdict-vs-watermark race. Pre-fix: the sweep at
    // W ran while the origin was unacked (blocked), the verdict landed
    // after, and nothing re-swept — the entry stayed pending forever on
    // the then-quiet space.
    const doc = "of:verdict-race" as never;
    let ackedSeq: number | undefined = undefined;
    const pendingLocalSeqs = [10, 30];
    let watermarkCallback: ((value: unknown) => void) | undefined;
    const replica = {
      sealNative: (
        _native: unknown,
        _source: unknown,
        verdict: Promise<unknown>,
        options?: { speculative?: boolean },
      ) => {
        expect(options?.speculative).toBe(true);
        return {
          localSeq: 30,
          commit: {
            localSeq: 30,
            reads: {
              confirmed: [],
              // The origin layer BELOW the entry: localSeq 10, still
              // unacked at seal time.
              pending: [{ id: doc, localSeq: [10], basisSeq: 0 }],
            },
            operations: [],
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs,
      }),
      ackedSeqOf: (localSeq: number) => localSeq === 10 ? ackedSeq : undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
    };
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: () => ({
        sink: (callback: (value: unknown) => void) => {
          watermarkCallback = callback;
          return () => {};
        },
      }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);

    // Seal the speculative entry through the destination.
    const sealTx = {
      tx: {
        sealInto: (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          return collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined).then(() => ({ ok: {} }));
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(sealTx, {
      actionId: "verdict-race",
      kind: "derivation",
    });
    expect((await destination.seal(sealTx)).ok).toBeDefined();
    expect(destination.entryCount(space)).toBe(1);
    // The seal installed both hooks.
    expect(watermarkCallback).toBeDefined();
    expect(replica.speculationAckObserver).toBeDefined();

    // The covering watermark arrives FIRST (W=50 covers everything the
    // entry consumed) — but the origin's verdict is still in flight, so
    // the sweep skips the entry as blocked.
    watermarkCallback!({ seq: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(destination.entryCount(space)).toBe(1);

    // The verdict lands: origin 10 acked at store seq 5; its layer
    // promotes off the pending stack. NO further watermark event.
    ackedSeq = 5;
    pendingLocalSeqs.splice(0, pendingLocalSeqs.length, 30);
    replica.speculationAckObserver?.();
    await waitUntil(
      () => destination.entryCount(space) === 0,
      "the verdict-raced entry to retire on the ack wake",
      5_000,
    );
    destination.close();
  });

  it("a close() racing the seal neither resurrects entries nor enacts navigateTo; a REJECTED sealInto withdraws collected entries (threads r3739139501, r3739139536)", async () => {
    // Destination-level, scripted: hold sealInto mid-flight, close()
    // the overlay, then let the seal complete. Pre-fix the continuation
    // registered the entry after close() had swept (a resurrected entry
    // nothing would ever withdraw) and deferSealedEffects still flushed
    // the allowlisted navigateTo of the never-accepted commit.
    const verdicts: unknown[] = [];
    const replica = {
      sealNative: (
        _native: unknown,
        _source: unknown,
        verdict: Promise<unknown>,
      ) => {
        verdict.then((value) => verdicts.push(value), () => {});
        return {
          localSeq: 7,
          commit: {
            localSeq: 7,
            reads: { confirmed: [], pending: [] },
            operations: [],
          },
          settled: verdict.then(() => undefined, () => undefined),
        };
      },
      speculationRetirementView: () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [7],
      }),
      ackedSeqOf: () => undefined,
      speculationAckObserver: undefined as (() => void) | undefined,
    };
    const runtime = {
      storageManager: { open: () => ({ replica }) },
      getCellFromLink: () => ({ sink: () => () => {} }),
    } as unknown as Runtime;
    const destination = new SpeculationOverlayDestination(runtime);

    const gate = Promise.withResolvers<void>();
    const sealTx = {
      tx: {
        sealInto: async (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          await collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined);
          await gate.promise;
          return { ok: {} };
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(sealTx, {
      actionId: "close-race",
      kind: "derivation",
    });
    const sealResult = destination.seal(sealTx);
    // close() lands while sealInto is parked on the gate.
    destination.close();
    gate.resolve();
    expect((await sealResult).ok).toBeDefined();
    // NOT resurrected — and the entry's verdict was resolved (a
    // rollback withdrawal), not left dangling.
    expect(destination.entryCount(space)).toBe(0);
    expect(verdicts.length).toBe(1);
    expect(
      (verdicts[0] as { withdrawn?: unknown }).withdrawn,
    ).toBeDefined();

    // The effect half: a navigateTo of a derivation on the CLOSED
    // overlay is owned AND dropped.
    let flushed = 0;
    const effectTx = {} as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(effectTx, {
      actionId: "close-race-effect",
      kind: "derivation",
    });
    const owned = destination.deferSealedEffects(effectTx, [{
      id: "navigateTo:1",
      kind: "navigateTo",
      flush: () => {
        flushed += 1;
      },
    }]);
    expect(owned).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushed).toBe(0);

    // The rejection half (r3739139536), on a fresh destination: a
    // sealInto that REJECTS after collecting a space withdraws the
    // collected entry and surfaces a CommitError.
    const rejecting = new SpeculationOverlayDestination(runtime);
    const verdictsBefore = verdicts.length;
    const rejectTx = {
      tx: {
        sealInto: async (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          await collector.sealSpaceCommit(space, {
            operations: [],
            preconditions: [],
          }, undefined);
          throw new Error("transport fell over mid-seal");
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(rejectTx, {
      actionId: "seal-reject",
      kind: "derivation",
    });
    const rejected = await rejecting.seal(rejectTx);
    expect(rejected.error).toBeDefined();
    expect(rejected.error!.message).toContain("transport fell over");
    expect(rejecting.entryCount(space)).toBe(0);
    expect(verdicts.length).toBe(verdictsBefore + 1);
    expect(
      (verdicts[verdictsBefore] as { withdrawn?: unknown }).withdrawn,
    ).toBeDefined();
    rejecting.close();
  });

  it("an effectful builtin reached by client speculation never fires egress: pending renders, zero client fetch calls (README §3.5's never-execute rule)", async () => {
    // Client-only bring-up posture (no serving host): the flag is set
    // explicitly, and the client's fetch stub must never be called.
    const calls: string[] = [];
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify({ leaked: true }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
      experimental: { serverExecution: true },
    });
    const FETCH_PATTERN = [
      "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
      "export default pattern<{ url: string }, { fetch: any }>(",
      "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
      ");",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: FETCH_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ url: string }>(
      space,
      "client-fetch-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ fetch: { pending?: boolean } }>(
      space,
      "client-fetch-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const tx = clientRuntime.edit();
    argument.withTx(tx).set({ url: "https://phase-2.test/never" });
    expect((await tx.commit()).error).toBeUndefined();
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    // Give any (wrong) floating egress every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toEqual([]);
    // And the branch RENDERS PENDING (speculation.md §2: on a memo
    // miss the node reads as pending — the ordinary loading state —
    // until the server's result arrives).
    const rendered = result.key("fetch").get() as
      | { pending?: boolean; result?: unknown }
      | undefined;
    expect(rendered?.result).toBeUndefined();
    cancelDemand();
  });
});
