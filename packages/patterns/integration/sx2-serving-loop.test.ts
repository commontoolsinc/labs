// Server-execution v2 Phase 2 gate: the serving loop, live
// (testing.md §5's `sx2-serving-loop` — counters, amplification, and
// the settle discipline). Headless: a PiecesController client drives
// the real counter pattern against toolshed; in the ON arm the
// toolshed's ExecutorHost serves the space and this test asserts the
// serving-loop gates from `/api/health/stats` COUNTERS — never logs,
// never text-polling (testing.md §3–§4):
//
// - the client settles via `waitForSettled` (the watermark doc — the
//   poll-loop replacement);
// - ONE authoritative run per upstream change, waves ≈ authored input
//   batches (ballpark, testing.md §4);
// - amplification `derivedCommits / (authoredSeen − effectAcks)` ≤ 2
//   on this pure workload (the §4 budget — a TRIGGER: a breach fails
//   with the numbers so a human inspects the why);
// - the pattern-update posture runs server-side against the REAL
//   toolshed routes (the plan's Phase 2 revisit (b)): the serving
//   loop's settle — with `systemPatternAutoUpdate` flipped ON in the
//   serving runtime by the toolshed factory — must reach quiescence
//   with the updater's network CHECK half able to complete, which the
//   stage-F unit fixture could not serve. This is machinery-level
//   verification (the check runs and nothing wedges idle/W); a full
//   stale-pointer roll-forward journey stays a follow-up.
//
// OFF arm: the same workload runs client-derived (today's posture,
// byte-identical); the servingLoop stats block is absent and the
// ON-arm assertions are skipped explicitly.

import { env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { waitForSettled } from "@commonfabric/runner/executor/watermark";
import type { MemorySpace } from "@commonfabric/runner";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, SPACE_NAME } = env;

const FLAG_ON = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";

type ServingLoopStats = {
  waves: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;
  structureLoadFailures: number;
};

const fetchServingLoopStats = async (): Promise<
  ServingLoopStats | undefined
> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: ServingLoopStats };
  return body.servingLoop;
};

describe("sx2 serving loop (Phase 2 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  let latestValue: number | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: `${SPACE_NAME}-sx2-loop`,
      apiUrl: new URL(API_URL),
      identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    piece = await cc.create(program, { start: true });
    // The live reader is the DEMAND (serving-loop.md §1): it keeps the
    // piece reactive locally AND is the client subscription the serving
    // loop maps to server-side demand in the ON arm.
    const resultCell = cc.manager().getResult(piece.getCell());
    sinkCancel = resultCell.sink((value) => {
      latestValue = (value as { value?: number } | undefined)?.value;
    });
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("serves authored inputs within the amplification budget, settling on waitForSettled (testing.md §3–§4)", async () => {
    const stats0 = await fetchServingLoopStats();
    if (!FLAG_ON) {
      // OFF arm: no serving loop exists; the workload still runs
      // client-derived, byte-identical to today.
      assertEquals(stats0, undefined);
      await piece.result.set(5, ["value"]);
      await cc.manager().runtime.storageManager.synced();
      assertEquals(await piece.result.get(["value"]), 5);
      return;
    }
    assert(
      stats0 !== undefined,
      "the ON arm must expose the servingLoop stats block",
    );

    const runtime = cc.manager().runtime;
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;

    // Three authored inputs — the steady-state interaction window the
    // §4 budget is measured over.
    for (const value of [10, 20, 30]) {
      await piece.result.set(value, ["value"]);
    }
    await runtime.storageManager.synced();

    // Settle via the WATERMARK, never text-polling: W must cover the
    // authored inputs (each advanced the space head by at least one).
    // waitForSettled subscribes the watermark doc — the same replicated
    // signal sync indicators read.
    const settledSeq = await waitForSettled(runtime, space, 3, {
      timeoutMs: 30_000,
    });
    assert(settledSeq >= 3, `W=${settledSeq} must cover the inputs`);

    // The value is authoritative AFTER settle (one-shot assertion — the
    // watermark answered "when", this answers "what").
    assertEquals(await piece.result.get(["value"]), 30);
    assertEquals(latestValue, 30);

    const stats1 = await fetchServingLoopStats();
    assert(stats1 !== undefined);
    const authored = stats1.authoredSeen - stats0.authoredSeen;
    const derived = stats1.derivedCommits - stats0.derivedCommits;
    const acks = stats1.effectAcks - stats0.effectAcks;
    const waves = stats1.waves - stats0.waves;
    assert(authored >= 3, `authoredSeen delta ${authored} must cover 3`);
    assert(derived >= 1, "the loop must have derived at least one wave");
    // ONE authoritative run per upstream change, coalescing allowed:
    // waves stay in the ballpark of authored input batches
    // (testing.md §4's single-run gate).
    assert(
      waves <= authored + 2,
      `waves delta ${waves} must stay in the ballpark of ` +
        `${authored} authored batches`,
    );
    // The §4 amplification budget — a TRIGGER, not a silent gate: a
    // breach fails WITH the numbers so a human inspects the why.
    const logicalWrites = authored - acks;
    const ratio = derived / Math.max(1, logicalWrites);
    assert(
      ratio <= 2,
      `amplification ${derived}/${logicalWrites} = ${ratio.toFixed(2)} ` +
        "exceeds the ≤2 pure-workload budget (testing.md §4) — inspect " +
        "before re-baselining",
    );
  });

  it("keeps the serving loop settled with the server-side pattern-update posture live (the Phase 2 revisit (b) surface)", async () => {
    if (!FLAG_ON) return;
    // The toolshed serving-runtime factory flips
    // `systemPatternAutoUpdate` ON (serving-loop.md §3e), so the
    // updater's network CHECK half runs HERE, against toolshed's real
    // pattern routes — the environment the stage-F unit fixture could
    // not provide. The verification is machinery-level and stated so:
    // the served piece above reached watermark-covered quiescence with
    // the updater active (a wedged or throwing check half would hold
    // idle()/W), and the demanded structure kept loading. A full
    // stale-pointer roll-forward journey is the named follow-up.
    const stats = await fetchServingLoopStats();
    assert(stats !== undefined);
    const runtime = cc.manager().runtime;
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;
    await piece.result.set(41, ["value"]);
    await runtime.storageManager.synced();
    const settledSeq = await waitForSettled(runtime, space, 4, {
      timeoutMs: 30_000,
    });
    assert(settledSeq >= 4);
    assertEquals(await piece.result.get(["value"]), 41);
    const after = await fetchServingLoopStats();
    assert(after !== undefined);
    assertEquals(
      after.structureLoadFailures,
      stats.structureLoadFailures,
      "the demanded-structure load path must stay clean under the " +
        "server-side updater posture",
    );
  });
});
