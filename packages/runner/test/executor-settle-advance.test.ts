// Server-execution v2 stage C, W3.1 — S1: the drain-settle quiescence
// advance (RULED 2026-08-19; protocol.md §4's amendment). The swatch
// stall's fix seat (stage-c/swatch-stall-rootcause.md §4): on a quiet
// space the watermark froze BELOW the tail derivations' own seqs — W
// covered inputs only, so a client speculation layer whose floor
// includes a PUSHED derived commit's seq (a re-derivation that read a
// served value; the stall's diverged tombstone is the known producer)
// had no reachable retirement until the next authored commit anywhere
// in the space (probe-verified: one keystroke healed a 60-s stall
// within one 500 ms poll, while explicit settles did nothing).
//
// S1: at drain-settle — the serving loop reaching quiescence for the
// space (a true settle, no contributions, no pending events, the drain
// empty) — W advances over the space's own committed derived tail, so
// every retirement predicate gated on `W ≥ floor` fires without
// waiting for an unrelated authored commit. Pins:
//
//  1. frozen-W reproduction (the i10 shape): a served derivation
//     commits ABOVE the last authored coverage; the space quiesces; W
//     advances to cover it WITHOUT any new authored commit — and the
//     advance reaches the CLIENT through the ordinary watermark-doc
//     push (RED on the pre-S1 tip: W stays below the tail forever).
//     The client clause is PUSH-HALF honest (combined review
//     2026-08-19, F3): a watermark sink installed before any advance
//     exists must observe a delivered value above the authored
//     coverage — with the advance wave's `noteExecutorCommit` skipped
//     (probe S1-P1), `waitForSettled` self-satisfies through its own
//     fresh subscription's initial pull, and THIS clause goes red.
//  2. the diverged layer retires at quiescence (the report §5 probe
//     shape, minimal seam): a client re-derivation reads the PUSHED
//     derived value and seals a layer whose value DIVERGES from the
//     confirmed one under it; with no authored traffic at all the
//     layer retires on the quiescence advance and the healed confirmed
//     value renders (RED on the pre-S1 tip: masked indefinitely).
//  3. idempotence / no self-chase: once quiescence has advanced W, a
//     quiet space commits NOTHING further — the advance-only wave is
//     never chased (the #coverageHead comment's commit-storm class),
//     and the counter stays flat.
//  4. OFF witness: the advance lives inside SpaceServer's wave cycle —
//     the OFF arm constructs no SpaceServer, derives nothing, and
//     holds no watermark doc at all.
//  5. busy-space neutrality: under a continuous input stream the
//     advance never fires mid-stream (quiescence never holds); it
//     fires once at the trailing quiescence transition.
//  6. the latch survives a mid-seal content fold (combined review
//     2026-08-19, F2): content sealing into the advance wave's
//     still-open commit window (between the gate snapshot and the wave
//     detach) arms the latch and the seal-consume must NOT erase it —
//     the folded content's seq sits above the advance's target, so a
//     consumed latch strands it below W until the next authored input
//     (RED on the pre-fix code: W frozen below the folded seq). The
//     consume is gated on `contentContributionCount === 0`.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  readWatermarkSeq,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  waitForSettled,
  watermarkCell,
  watermarkDocLink,
} from "../src/executor/watermark.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("settle advance space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("settle advance service");
const aliceSigner = await Identity.fromPassphrase("settle advance alice");

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

describe("S1 drain-settle quiescence advance (RULED 2026-08-19)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;
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

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    onServingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  /** The serving graph: a real pattern run server-side at activation
   * (the loaded structure), same shape as the serving-loop E2E. */
  const servePattern = (argName: string, resultName: string) => {
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        argName,
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        resultName,
        compiled.resultSchema,
      );
      for (let attempt = 0;; attempt++) {
        await argument.sync();
        await result.sync();
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
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
  };

  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // A flag-ON CLIENT (no serving posture): the speculation overlay
    // exists, and the watermark doc arrives via ordinary push.
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  };

  /** Every derived-class commit's seq, ascending (the space's derived
   * tail is the last). */
  const derivedSeqs = (engine: Engine.Engine): number[] =>
    (engine.database.prepare(
      `SELECT seq FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number }[]).map((row) => row.seq);

  const authoredCount = (engine: Engine.Engine): number =>
    (engine.database.prepare(
      `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'authored'`,
    ).get() as { n: number }).n;

  const maxAuthoredSeq = (engine: Engine.Engine): number =>
    (engine.database.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
    ).get() as { n: number }).n;

  it("pin 1 — frozen-W (the i10 shape): the watermark advances over the tail derivation at drain-settle, with NO new authored commit, and the advance reaches the client via the ordinary push", async () => {
    servePattern("s1-arg", "s1-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    // F3 (combined review 2026-08-19): the PUSH-half witness. A sink on
    // the watermark doc installed BEFORE any advance exists observes
    // every LATER value only through the production push path — the
    // advance wave's `noteExecutorCommit` marks the watermark doc's
    // dirty key, and the refresh delivers exactly the dirty keys; the
    // initial sync pull at subscribe time can only see the pre-input
    // watermark (below every authored seq this test mints). So a
    // DELIVERED value above the authored coverage is push-half
    // evidence the `waitForSettled` clause below cannot give (probe
    // S1-P1: with the advance wave's `noteExecutorCommit` skipped,
    // `waitForSettled` self-satisfies through the initial pull of its
    // own fresh subscription — THIS clause is the one that goes red).
    const pushedWatermarks: number[] = [];
    const wmCell = watermarkCell(clientRuntime, space);
    await wmCell.sync();
    const cancelWmSink = wmCell.sink((value) => {
      if (typeof value?.seq === "number") pushedWatermarks.push(value.seq);
    });

    // The client's demand + the authored input (the wave's trigger).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 6 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The served derivation lands and is pushed (the client observes
    // the derived value) — the derived commit's seq is ABOVE the
    // authored input's.
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the served derivation to reach the client",
    );
    await waitUntil(
      () => derivedSeqs(engine).some((seq) => seq > authoredSeq),
      "a derived commit above the authored input",
    );
    const tail = Math.max(
      ...derivedSeqs(engine).filter((seq) => seq > authoredSeq),
    );
    const authoredBefore = authoredCount(engine);

    // THE PIN (RED pre-S1: W freezes at the authored coverage — the
    // report's i10: W 71 vs floor 72 — until the next authored commit
    // anywhere in the space; the input-driven advance can NEVER exceed
    // the highest authored seq, so `W > max authored` is exactly the
    // quiescence advance — both sides recomputed per poll, because the
    // serving side's own structure commits are authored too and can
    // land after this test's sample): at drain-settle the watermark
    // advances over the space's own derived tail. No authored traffic
    // from this test here.
    await waitUntil(
      () => readWatermarkSeq(engine) > maxAuthoredSeq(engine),
      "the drain-settle advance past the authored coverage " +
        `(W frozen at input coverage; derived tail ${tail})`,
    );
    const advancedW = readWatermarkSeq(engine);
    // The advance covers the CONTENT tail. `tail` was sampled above and
    // may itself be the advance's own bookkeeping-only commit (which W
    // definitionally never covers — chasing it would mint a successor,
    // the commit-storm class), hence the −1 tolerance.
    expect(advancedW).toBeGreaterThanOrEqual(tail - 1);
    // ... and the advance reached the CLIENT through the ordinary
    // watermark-doc push, with no other traffic (waitForSettled rides
    // the client's own subscription).
    const settled = await waitForSettled(clientRuntime, space, advancedW, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(advancedW);
    // No authored commit drove the advance (the heal needs no
    // keystroke): the advance-carrying commits are derived-class.
    expect(authoredCount(engine)).toBe(authoredBefore);

    // The counter: at least one quiescence advance, and the stats block
    // splits it from the per-input settle series (W4's metric reads
    // both).
    const stats = host.stats();
    expect(stats.settleAdvances.count).toBeGreaterThanOrEqual(1);
    expect(stats.settleAdvances.lastDelta).toBeGreaterThanOrEqual(1);
    // F3: the advance was DELIVERED to the pre-installed sink — a value
    // above the final authored coverage arrived through the push path
    // (both sides recomputed per poll, as above).
    await waitUntil(
      () => pushedWatermarks.some((seq) => seq > maxAuthoredSeq(engine)),
      "the quiescence advance to arrive at the client via the " +
        "production push (noteExecutorCommit → dirty key → refresh)",
    );
    cancelWmSink();
    cancelDemand();
  });

  it("pin 2 — the diverged layer retires at quiescence (the report §5 probe shape, minimal seam): a re-derivation over the PUSHED derived value seals a diverged layer; the quiescence advance retires it and the healed value renders — no authored traffic", async () => {
    servePattern("s1b-arg", "s1b-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1b-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1b-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 6 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The served value arrives (confirmed at the derived commit's seq,
    // ABOVE the authored coverage) and any first-generation echoes
    // retire (their floors sit at the authored input).
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the served derivation to reach the client",
    );
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    await waitUntil(
      () => overlay!.entryCount(space) === 0,
      "first-generation echoes to retire",
      30_000,
    );
    const derivedTail = Math.max(
      ...derivedSeqs(engine).filter((seq) => seq > authoredSeq),
    );
    const authoredBefore = authoredCount(engine);

    // The RE-DERIVATION over the pushed derived value (the stall's
    // poison, minimal seam): a stamped derivation-kind run — the real
    // client seal path; the flag-ON client's seal destination diverts
    // it into the overlay — READS the served result (confirmed at the
    // derived commit's seq, so the entry's floor sits ABOVE every W
    // the pre-S1 server can reach on a quiet space) and WRITES a
    // DIVERGED value over the same doc (the tombstone's shape: the
    // layer masks the healed confirmed value beneath it).
    const specTx = clientRuntime.edit();
    stampSpeculationRunContext(specTx, {
      actionId: "s1-pin2-regressed-rederivation",
      kind: "derivation",
    });
    const seen = clientResult.withTx(specTx).key("total").get();
    expect(seen).toBe(42);
    clientResult.withTx(specTx).key("total").set(999);
    expect((await specTx.commit()).error).toBeUndefined();
    // The diverged layer masks the confirmed value (the stall's render).
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);
    expect(clientResult.key("total").get()).toBe(999);

    // THE PIN (RED pre-S1: the layer lingers indefinitely — its floor
    // is the derived commit's seq, and W freezes below it; the sweep's
    // "each new input lifts the previous generation" premise required
    // an authored commit that never comes): the quiescence advance
    // covers the floor, the watermark sink re-sweeps, the layer
    // retires, and the HEALED confirmed value shows through.
    await waitUntil(
      () => overlay!.entryCount(space) === 0,
      "the diverged layer to retire on the quiescence advance",
      30_000,
    );
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the healed confirmed value to render",
    );
    // No authored commit drove the heal (the report's keystroke probe
    // is exactly what S1 makes unnecessary).
    expect(authoredCount(engine)).toBe(authoredBefore);
    // W covers the CONTENT tail. The engine's very last derived seq may
    // be the quiescence advance's own bookkeeping-only commit, which W
    // definitionally never covers (chasing it would mint a successor —
    // the commit-storm class); `derivedTail` was sampled before the
    // mint, so it is either the content commit (covered exactly) or
    // the advance commit (one above W).
    expect(readWatermarkSeq(engine)).toBeGreaterThanOrEqual(derivedTail - 1);
    cancelDemand();
  });

  it("pins 3+5 — idempotence and busy-space neutrality: the advance fires once per quiescence transition (never per wave, never chasing its own bookkeeping commit), and a quiet space then commits NOTHING further", async () => {
    servePattern("s1c-arg", "s1c-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1c-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1c-arg",
      undefined,
    );
    await clientArg.sync();

    // PIN 5 (busy neutrality): a continuous input stream — commits
    // fired back-to-back, unawaited settles — keeps the space busy;
    // the advance must not fire mid-stream (quiescence never holds
    // while the feed carries the next input).
    const EDITS = 10;
    for (let i = 1; i <= EDITS; i++) {
      const editTx = clientRuntime.edit();
      clientArg.withTx(editTx).set({ n: i });
      expect((await editTx.commit()).error).toBeUndefined();
    }
    const lastAuthored = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, lastAuthored, {
      timeoutMs: 30_000,
    });
    // Let the trailing quiescence transition land its advance.
    await waitUntil(
      () => host!.stats().settleAdvances.count >= 1,
      "the trailing quiescence advance",
    );
    const stats = host.stats();
    // Far below one-per-wave: the stream coalesces into waves whose
    // cycles end with the next input already in the feed — only real
    // quiescence transitions fire (the trailing one, plus at most a
    // couple of genuine mid-stream gaps on a slow box).
    expect(stats.settleAdvances.count).toBeLessThanOrEqual(4);
    expect(stats.settleAdvances.count).toBeGreaterThanOrEqual(1);

    // PIN 3 (idempotence / no self-chase): W now covers the derived
    // tail; the advance-only wave's own commit is NOT chased (the
    // #coverageHead commit-storm class), and a quiet space commits
    // NOTHING further — counters and the engine head stay flat.
    await waitUntil(
      () => {
        const seqs = derivedSeqs(engine);
        const tail = seqs.length === 0 ? 0 : seqs[seqs.length - 1];
        // Quiet: W has caught the last CONTENT commit. The advance
        // wave's own seq sits one above W, uncovered by design.
        return readWatermarkSeq(engine) >= tail - 1;
      },
      "W to cover the content tail",
    );
    const advancesBefore = host.stats().settleAdvances.count;
    const wavesBefore = host.stats().waves;
    const headBefore = Engine.serverSeq(engine);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(host.stats().settleAdvances.count).toBe(advancesBefore);
    expect(host.stats().waves).toBe(wavesBefore);
    expect(Engine.serverSeq(engine)).toBe(headBefore);
    cancelDemand();
  });

  it("pin 4 — OFF witness: the advance path is structurally unreached off the serving posture — no SpaceServer, no derived commits, no watermark doc", async () => {
    // No host at all (the OFF arm has no serving loop to run the
    // advance); an OFF client authors and derives locally.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      // OFF: no experimental.serverExecution.
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "off-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "off-result",
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
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the OFF client's own derivation",
    );
    // OFF derives client-side and commits as today: derived-class
    // commits and the watermark doc do not exist, so neither does any
    // advance (readWatermarkSeq's absent-doc read is 0).
    expect(derivedSeqs(engine).length).toBe(0);
    expect(readWatermarkSeq(engine)).toBe(0);
    cancelDemand();
  });

  it("pin 6 — the latch survives a mid-seal content fold (combined review 2026-08-19, F2): content sealing into the advance wave's still-open commit window leaves the latch ARMED, so the NEXT quiescence covers the folded tail — no stall until the next authored input", async () => {
    servePattern("s1f-arg", "s1f-result");
    // THE MID-SEAL INJECTION SEAM (the review's interleaving, made
    // deterministic): between the quiescence gate's snapshot and the
    // wave detach, the cycle awaits the watermark tx's commit — any
    // transaction sealing in that window joins the still-open closing
    // wave (`#openWave` reuses `#currentWave`; a serving-runtime
    // `commit()` resolves at SEAL acceptance, before the wave commits,
    // so awaiting it inside the window cannot deadlock). The wrapper
    // below intercepts the serving runtime's `edit()`: when an ARMED
    // one-shot sees a watermark ["seq"] write whose value exceeds every
    // authored seq (exactly pin 1's quiescence-advance discriminator —
    // an input-driven advance can never exceed the authored head), it
    // commits a DERIVATION-kind content write before letting the
    // watermark tx commit — the wave then carries BOTH the advance and
    // the content, and `advanceTo` (computed before the fold) sits
    // BELOW the folded commit's seq.
    const FOLD_DOC_ID = "of:s1-pin6-mid-seal-fold";
    let engineRef: Engine.Engine | undefined;
    let armed = false;
    let injectionDone = false;
    let foldError: string | undefined;
    const innerSetup = onServingRuntime;
    onServingRuntime = async (runtime) => {
      await innerSetup?.(runtime);
      const originalEdit = runtime.edit.bind(runtime);
      type Tx = ReturnType<Runtime["edit"]>;
      (runtime as { edit: () => Tx }).edit = () => {
        const tx = originalEdit();
        const origWrite = tx.writeValueOrThrow.bind(tx);
        let watermarkSeqValue: number | undefined;
        (tx as { writeValueOrThrow: typeof origWrite }).writeValueOrThrow = (
          link,
          value,
        ) => {
          if (
            link.id === SERVER_EXECUTION_WATERMARK_DOC_ID &&
            typeof value === "number"
          ) {
            watermarkSeqValue = value;
          }
          return origWrite(link, value);
        };
        const origCommit = tx.commit.bind(tx);
        (tx as { commit: typeof origCommit }).commit = async () => {
          if (
            armed && !injectionDone && engineRef !== undefined &&
            watermarkSeqValue !== undefined &&
            watermarkSeqValue > maxAuthoredSeq(engineRef)
          ) {
            injectionDone = true;
            const foldTx = originalEdit();
            stampWaveRunContext(foldTx, {
              actionId: "s1-pin6-mid-seal-fold",
              kind: "derivation",
            });
            foldTx.writeValueOrThrow(
              {
                ...watermarkDocLink(space),
                id: FOLD_DOC_ID as ReturnType<
                  typeof watermarkDocLink
                >["id"],
                path: [],
              },
              { folded: true },
            );
            const folded = await foldTx.commit();
            if (folded.error !== undefined) {
              foldError = folded.error.message;
            }
          }
          return origCommit();
        };
        return tx;
      };
    };
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);
    engineRef = engine;

    // The ordinary S1 flow first (pin 1's shape), UNARMED: input,
    // served derivation, the first quiescence advance completes clean.
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1f-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1f-arg",
      undefined,
    );
    await clientArg.sync();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => clientResult.key("total").get() === 42,
      "the served derivation to reach the client",
    );
    await waitUntil(
      () => readWatermarkSeq(engine) > maxAuthoredSeq(engine),
      "the first (clean) quiescence advance",
    );

    // ARM, then drive ONE more content generation: the quiescence
    // advance for ITS tail is the one the seam poisons. Arming happens
    // BEFORE the input exists, so the injection cannot race the
    // advance.
    armed = true;
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 7 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => clientResult.key("total").get() === 49,
      "the second served derivation to reach the client",
    );
    await waitUntil(() => injectionDone, "the mid-seal fold injection");
    expect(foldError).toBeUndefined();

    // The interleaving REALLY happened (loud abort, not a vacuous
    // green): the folded content write and the advance's watermark
    // write landed in the SAME wave commit.
    await waitUntil(
      () =>
        (Engine.selectCommitsSince(engine, {
          fromSeq: 0,
          limit: 10_000,
        }) as Array<{ seq: number; writes?: Array<{ id: string }> }>)
          .some((record) =>
            (record.writes ?? []).some((write) => write.id === FOLD_DOC_ID)
          ),
      "the folded commit to appear in the engine",
    );
    const commits = Engine.selectCommitsSince(engine, {
      fromSeq: 0,
      limit: 10_000,
    }) as Array<{ seq: number; writes?: Array<{ id: string }> }>;
    const foldCommits = commits.filter((record) =>
      (record.writes ?? []).some((write) => write.id === FOLD_DOC_ID)
    );
    expect(foldCommits.length).toBe(1);
    const foldSeq = foldCommits[0].seq;
    expect(
      (foldCommits[0].writes ?? []).some((write) =>
        write.id === SERVER_EXECUTION_WATERMARK_DOC_ID
      ),
    ).toBe(true);
    const authoredBefore = authoredCount(engine);

    // THE PIN (RED on the unfixed code: the fold's content ARMED the
    // latch and the advance's seal-consume immediately erased it —
    // `advanceTo` sits below the folded seq, the next echo cycle finds
    // the latch false, and W freezes below the folded content until
    // the next authored input, which never comes): with the consume
    // gated on the wave having stayed bookkeeping-only, the latch
    // stays armed and the NEXT quiescence covers the folded tail.
    await waitUntil(
      () => readWatermarkSeq(engine) >= foldSeq,
      `the next quiescence advance to cover the folded tail (folded ` +
        `content at seq ${foldSeq}; W frozen below it means the latch ` +
        "was consumed by the fold-carrying advance wave)",
    );
    // No authored commit drove the recovery.
    expect(authoredCount(engine)).toBe(authoredBefore);
    // And the client heals through the ordinary push.
    const settled = await waitForSettled(clientRuntime, space, foldSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(foldSeq);
    cancelDemand();
  });
});
