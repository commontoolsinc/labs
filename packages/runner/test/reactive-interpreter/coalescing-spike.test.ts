/**
 * COALESCING SPIKE engagement proof (coalescing track, step 3).
 *
 * Proves the partitioned dispatch ENGAGES end-to-end on a real handler-bearing
 * pattern: a counter whose PURE compute (`double(counter)`) is interpreted as a
 * SEGMENT while its HANDLER (`incHandler`) stays a legacy boundary node. Before
 * this wiring such a pattern fell back wholesale (`ineligible_opkind`, an effect
 * op in the single-node ELIGIBLE_KINDS gate) and `interpreted_ok` stayed 0.
 *
 * This is a DIFFERENTIAL ORACLE: the SAME pattern runs through the legacy path
 * (flag off) and the interpreter path (flag on), and asserts:
 *   - the flag-ON run actually went through the interpreter (census
 *     `interpreted_ok >= 1` — the segment node ran, not a silent whole-pattern
 *     fallback), AND
 *   - the interpreter's `doubled` value is IDENTICAL to legacy's, both initially
 *     and AFTER the handler fires (the pure segment re-derives reactively off the
 *     state the legacy handler boundary mutated).
 *
 * Flag-OFF parity for the rest of the suite is covered by `deno task test` (the
 * partition branch is unreachable when `experimentalInterpreter` is off).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-coalescing-spike");

interface RunOutcome {
  interpretedOk: number;
  initialDoubled: unknown;
  afterDoubled: unknown;
}

/** Run the counter pattern (handler boundary + pure `double` segment) through a
 * fresh runtime with the interpreter flag on or off, and report the census plus
 * the `doubled` value before and after firing the handler. */
async function runCounter(experimentalInterpreter: boolean): Promise<RunOutcome> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    experimental: { experimentalInterpreter },
  });
  const { commonfabric } = createTrustedBuilder(runtime);
  // deno-lint-ignore no-explicit-any
  const cf = commonfabric as any;
  const space = signer.did() as MemorySpace;

  try {
    // `double(counter)` is a PURE leaf → an interpreted SEGMENT.
    const double = cf.lift((c: { value?: number }) => (c?.value ?? 0) * 2);
    // `incHandler` mutates the shared counter state → a legacy BOUNDARY node.
    const incHandler = cf.handler(
      (
        { amount }: { amount: number },
        { counter }: { counter: { value: number } },
      ) => {
        counter.value += amount;
      },
      { proxy: true },
    );
    // ({ counter }) => ({ counter, doubled: double(counter), stream: handler })
    const counterPattern = cf.pattern(
      ({ counter }: { counter: { value: number } }) => ({
        counter,
        doubled: double(counter),
        stream: incHandler({ counter }),
      }),
    );

    const resultCell = runtime.getCell(space, "coalescing-spike", undefined);
    const tx = runtime.edit();
    const r = runtime.run(tx, counterPattern, { counter: { value: 3 } }, resultCell);
    await tx.commit();
    await runtime.idle();
    r.sink(() => {});
    await runtime.idle();

    const initial = await r.pull() as { doubled?: unknown };
    // Fire the handler boundary: counter.value 3 -> 4, so the pure segment must
    // re-derive doubled 6 -> 8 (reactivity THROUGH the boundary).
    r.key("stream").send({ amount: 1 });
    await runtime.idle();
    const after = await r.pull() as { doubled?: unknown };

    return {
      interpretedOk: runtime.runner.getInterpreterCensus().interpreted_ok,
      initialDoubled: initial.doubled,
      afterDoubled: after.doubled,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("coalescing spike — partitioned dispatch engages", () => {
  it("interprets the pure segment while the handler stays a boundary node", async () => {
    const legacy = await runCounter(false);
    const interpreted = await runCounter(true);

    // ENGAGEMENT: the flag-OFF run never touches the interpreter; the flag-ON run
    // instantiated a PARTITIONED pattern through the interpreter (the segment
    // node), bumping `interpreted_ok`. This is the whole point of the spike — the
    // interpreter now engages on a handler-bearing pattern.
    expect(legacy.interpretedOk).toBe(0);
    expect(interpreted.interpretedOk).toBeGreaterThanOrEqual(1);

    // CORRECTNESS (differential oracle): the interpreted `doubled` is IDENTICAL
    // to the legacy `doubled`, both initially and after the handler fires.
    expect(interpreted.initialDoubled).toEqual(legacy.initialDoubled);
    expect(interpreted.afterDoubled).toEqual(legacy.afterDoubled);

    // And it is the EXPECTED value: doubled = 2 * counter.value, with the handler
    // having driven counter.value to 4 by the time the result settles.
    expect(interpreted.afterDoubled).toBe(8);
  });
});
