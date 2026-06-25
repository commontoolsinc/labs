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
import type { JSONSchema } from "../../src/builder/types.ts";

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
async function runCounter(
  experimentalInterpreter: boolean,
): Promise<RunOutcome> {
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
    const r = runtime.run(
      tx,
      counterPattern,
      { counter: { value: 3 } },
      resultCell,
    );
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

// ---------------------------------------------------------------------------
// COLLECTION-BOUNDARY engagement (INC3 LEVEL-1).
// ---------------------------------------------------------------------------

interface CollectionOutcome {
  interpretedOk: number;
  initialHeadline: unknown;
  initialLabels: unknown;
  afterHeadline: unknown;
  afterLabels: unknown;
}

/** Run a pattern that combines a reactive `.map` (a `collection` BOUNDARY) with
 * surrounding PURE compute (a `str` headline segment) and a HANDLER boundary that
 * mutates the list. At LEVEL-1 the map node is kept verbatim (its per-element
 * render runs as legacy) while the headline segment interprets; firing the
 * handler grows the list, and both the mapped `labels` and the `headline` must
 * re-derive reactively THROUGH the boundaries. */
async function runCollection(
  experimentalInterpreter: boolean,
): Promise<CollectionOutcome> {
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

  const num = { type: "number" } as const;
  try {
    // The map ELEMENT pattern: a PURE render of one entry → kept in the legacy
    // map node verbatim at LEVEL-1. `mapWithPattern` is the builder-direct form
    // of an authored `.map(...)` (which the TS transformer lowers — here we call
    // the builder API directly, so we supply the element pattern explicitly).
    const elementPattern = cf.pattern(
      ({ element }: { element: number }) => ({
        label: cf.str`item ${element}`,
      }),
      { type: "object", properties: { element: num }, required: ["element"] },
      {
        type: "object",
        properties: { label: { type: "string" } },
      },
    );
    // A pure `str` headline over the list LENGTH → an interpreted SEGMENT that is
    // SEPARATE from the map boundary (no fan-out: it reads `count`, not the map).
    const lengthOf = cf.lift(
      (raw: number[] | undefined) => (Array.isArray(raw) ? raw.length : 0),
      { type: "array", items: num } as JSONSchema,
      num,
    );
    // The handler grows the shared list → a legacy BOUNDARY node.
    const pushHandler = cf.handler(
      (
        { n }: { n: number },
        { history }: { history: number[] },
      ) => {
        history.push(n);
      },
      { proxy: true },
    );

    const collectionPattern = cf.pattern(
      ({ history }: { history: number[] }) => {
        // A reactive map over the list → a `collection` BOUNDARY. Its per-element
        // render stays in the legacy map node verbatim.
        const labels = (history as unknown as {
          mapWithPattern(p: unknown, params: unknown): unknown;
        }).mapWithPattern(elementPattern, {});
        const count = lengthOf(history);
        const headline = cf.str`history has ${count} entries`;
        return {
          history,
          labels,
          headline,
          push: pushHandler({ history }),
        };
      },
      {
        type: "object",
        properties: { history: { type: "array", items: num } },
        required: ["history"],
      } as JSONSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "coalescing-spike-collection",
      undefined,
    );
    const tx = runtime.edit();
    const r = runtime.run(
      tx,
      collectionPattern,
      { history: [1, 2] },
      resultCell,
    );
    await tx.commit();
    await runtime.idle();
    // deno-lint-ignore no-explicit-any
    const headlineCell = r.key("headline") as any;
    // deno-lint-ignore no-explicit-any
    const labelsCell = r.key("labels") as any;
    const cancelH = headlineCell.sink(() => {});
    const cancelL = labelsCell.sink(() => {});
    await runtime.idle();
    await headlineCell.pull();
    await labelsCell.pull();
    await runtime.idle();

    // Read settled values via the typed cell `.get()` (NOT `r.pull()`, which
    // returns query-result-proxies that defeat structural `toEqual`). Round-trip
    // through JSON so the comparison is over plain JSON.
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
    const initialHeadline = norm(headlineCell.get());
    const initialLabels = norm(labelsCell.get());

    // Fire the handler boundary: history [1,2] -> [1,2,3]. The map boundary must
    // emit a 3rd label and the headline segment must re-derive "3 entries"
    // (reactivity THROUGH both boundaries).
    r.key("push").send({ n: 3 });
    await runtime.idle();
    await headlineCell.pull();
    await labelsCell.pull();
    await runtime.idle();
    const afterHeadline = norm(headlineCell.get());
    const afterLabels = norm(labelsCell.get());
    cancelH();
    cancelL();

    return {
      interpretedOk: runtime.runner.getInterpreterCensus().interpreted_ok,
      initialHeadline,
      initialLabels,
      afterHeadline,
      afterLabels,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("coalescing spike — collection boundary engages (INC3 LEVEL-1)", () => {
  it("interprets the surrounding pure region while the map stays a boundary node", async () => {
    const legacy = await runCollection(false);
    const interpreted = await runCollection(true);

    // ENGAGEMENT: a collection-bearing pattern (a reactive `.map` ALONGSIDE pure
    // compute + a handler) now PARTITIONS — the headline segment interprets while
    // the map + handler stay legacy boundaries. Before INC3 this fell back
    // wholesale on the `ineligible_opkind` collection gate (`interpreted_ok == 0`).
    expect(legacy.interpretedOk).toBe(0);
    expect(interpreted.interpretedOk).toBeGreaterThanOrEqual(1);

    // CORRECTNESS (differential oracle): the interpreted headline + mapped labels
    // are IDENTICAL to legacy, both initially and after the handler grows the list
    // (the map boundary and headline segment re-derive reactively).
    expect(interpreted.initialHeadline).toEqual(legacy.initialHeadline);
    expect(interpreted.initialLabels).toEqual(legacy.initialLabels);
    expect(interpreted.afterHeadline).toEqual(legacy.afterHeadline);
    expect(interpreted.afterLabels).toEqual(legacy.afterLabels);

    // And the EXPECTED settled values: 3 entries after the push, with the map
    // having emitted a per-element render (`{ label }`) per entry.
    expect(interpreted.afterHeadline).toBe("history has 3 entries");
    expect(interpreted.afterLabels).toEqual([
      { label: "item 1" },
      { label: "item 2" },
      { label: "item 3" },
    ]);
  });
});
