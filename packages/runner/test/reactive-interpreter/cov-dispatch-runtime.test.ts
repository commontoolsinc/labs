/**
 * Coverage: dispatch.ts + collection-inline.ts branches that only execute
 * while the interpreter runs FLAG-ON through the real Runtime — segment
 * error isolation (a throwing collapsed leaf), the inline-collection refusal
 * ladder (`op_pending` / `uses_array` / `element_not_inlinable`), and the
 * runtime edges of the inline map/filter coordinators (non-array loud error,
 * predicate-kept subset, zero-kept). Every case runs the SAME builder-built
 * pattern flag-off and flag-on and asserts byte-equal results (the
 * differential oracle from dispatch.test.ts), plus a census assertion that
 * the flag-on run engaged the intended path (never green-via-fallback).
 *
 * OUT OF SCOPE (needs a two-runtime reload / awaitSync harness, exercised by
 * the resume/list integration suites): the resume-republish and stale-basis
 * degrade machinery around collection-inline.ts ~254-322 / ~500-545, and the
 * `RI2_DEBUG` trace lines.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import type { Pattern } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import { trustExecutable } from "../support/trusted-builder.ts";
// NOTE: this file deliberately keeps the raw `JSON.parse(JSON.stringify(...))`
// idiom rather than `pullSnapshot`. Its segment-error-isolation tests rely on a
// JSON quirk: a throwing leaf yields an `undefined` slot, and `JSON.stringify`
// DROPS undefined-valued properties, so the throwing slots come out "absent"
// (e.g. `{ good: 2 }`). `pullSnapshot` (via `nativeFromFabricValue`) correctly
// PRESERVES `undefined`, which is more faithful but would surface the slots as
// `{ boomA: undefined, ... }` and break those deliberate assertions.

const signer = await Identity.fromPassphrase("ri2 cov-dispatch-runtime");
const space = signer.did();

interface RunOutcome {
  initial: unknown;
  afterEdit: unknown;
  /** Distinct scheduler error messages surfaced during the run (deduped). */
  errors: string[];
}

/**
 * Build the pattern INSIDE a runtime frame, run it, pull the result, apply an
 * argument edit, pull again — one flag state per call. Mirrors
 * dispatch.test.ts's `runOnce`, but installs a scheduler.onError sink so a
 * throwing collapsed leaf (segment error isolation) surfaces without
 * crashing the run, and records the error messages for assertion.
 */
async function runOnce(
  interpreter: boolean,
  buildPattern: () => Pattern,
  argument: Record<string, unknown>,
  edit: { path: string[]; value: unknown },
): Promise<RunOutcome> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: interpreter },
  });
  const errorSet = new Set<string>();
  runtime.scheduler.onError((error: unknown) => {
    const message = (error as { message?: unknown } | null)?.message;
    errorSet.add(String(message ?? error));
  });
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    const factory = buildPattern();
    const resultCell = runtime.getCell(
      space,
      `ri2-cov-dispatch-runtime-${interpreter}`,
    );
    const result = runtime.run(
      undefined,
      trustExecutable(runtime, factory) as never,
      argument as never,
      resultCell as never,
    );
    const initial = JSON.parse(JSON.stringify(await result.pull()));

    const argCell = resultCell.getArgumentCell()!;
    const tx = runtime.edit();
    let target = argCell.withTx(tx) as unknown as {
      key: (k: string) => unknown;
      set: (v: unknown) => void;
    };
    for (const key of edit.path) {
      target = (target as { key: (k: string) => unknown }).key(key) as never;
    }
    (target as { set: (v: unknown) => void }).set(edit.value);
    tx.commit();
    await runtime.idle();
    const afterEdit = JSON.parse(JSON.stringify(await result.pull()));

    return { initial, afterEdit, errors: [...errorSet].sort() };
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

const ELEMENT_SCHEMA = {
  type: "object",
  properties: {
    element: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    },
  },
  required: ["element"],
} as const;

// ---------------------------------------------------------------------------
// TARGET 1 — segment error isolation (dispatch.ts makeSegmentImplementation).
// ---------------------------------------------------------------------------

describe("segment error isolation (flag-on dispatch)", () => {
  it("one throwing collapsed leaf: slot undefined, siblings survive, error surfaces", async () => {
    // Three sibling lifts over the argument collapse into ONE segment. The
    // middle one throws → its op slot is written `undefined` (evalRog
    // isolated it), the other two keep their values, and the segment
    // re-throws so scheduler.onError sees exactly one error.
    const buildPattern = () =>
      pattern<{ a: number }>((input) => {
        const ok1 = lift((v: { a: number }) => v.a + 1)({ a: input.a });
        const boom = lift((v: { a: number }) => {
          if (v.a >= 0) throw new Error("boom-1");
          return v.a;
        })({ a: input.a });
        const ok2 = lift((v: { a: number }) => v.a * 10)({ a: input.a });
        return { ok1, boom, ok2 };
      }) as unknown as Pattern;

    const argument = { a: 5 };
    const edit = { path: ["a"], value: 8 };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    // Differential oracle: identical shape both flags, including the absent
    // (undefined → dropped by JSON) throwing slot.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { ok1: 6, ok2: 50 });
    assertEquals(legacy.afterEdit, { ok1: 9, ok2: 80 });

    // Both flags surfaced the throw to onError.
    assert(
      legacy.errors.some((m) => m.includes("boom-1")),
      `legacy should surface boom-1, got ${JSON.stringify(legacy.errors)}`,
    );
    assert(
      interpreted.errors.some((m) => m.includes("boom-1")),
      `interpreted should surface boom-1, got ${
        JSON.stringify(interpreted.errors)
      }`,
    );
    // The throwing siblings collapsed into a real segment (not a fallback).
    assert(
      census.interpreted >= 1,
      `expected interpretation, census=${JSON.stringify(census)}`,
    );
    assert(
      census.nodeOpsCollapsed >= 3,
      `expected >=3 collapsed ops, census=${JSON.stringify(census)}`,
    );
  });

  it("two throwing leaves in one segment: multi-error logger.warn branch (errors.slice(1))", async () => {
    // Two independent throwing lifts + one good lift collapse together. The
    // segment reports BOTH errors; makeSegmentImplementation throws the first
    // and routes the rest through logger.warn (errors.slice(1)). Only the
    // first error re-throws to onError (a single action throws once).
    const buildPattern = () =>
      pattern<{ a: number }>((input) => {
        const boomA = lift((v: { a: number }) => {
          if (v.a >= 0) throw new Error("boom-A");
          return v.a;
        })({ a: input.a });
        const boomB = lift((v: { a: number }) => {
          if (v.a >= 0) throw new Error("boom-B");
          return v.a;
        })({ a: input.a });
        const good = lift((v: { a: number }) => v.a - 1)({ a: input.a });
        return { boomA, boomB, good };
      }) as unknown as Pattern;

    const argument = { a: 3 };
    const edit = { path: ["a"], value: 9 };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    // Both throwing slots absent, the good sibling computed — byte-equal.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { good: 2 });
    assertEquals(legacy.afterEdit, { good: 8 });

    // The interpreted run surfaced at least one of the two throws (the first;
    // the second went to logger.warn, exercising errors.slice(1)).
    assert(
      interpreted.errors.some((m) =>
        m.includes("boom-A") || m.includes("boom-B")
      ),
      `interpreted should surface a boom error, got ${
        JSON.stringify(interpreted.errors)
      }`,
    );
    assert(
      census.nodeOpsCollapsed >= 3,
      `expected the two throwers + good to collapse, census=${
        JSON.stringify(census)
      }`,
    );
  });
});

// ---------------------------------------------------------------------------
// TARGET 2 — tryBuildInlineCollectionNode refusals (dispatch.ts).
// Each refusal keeps the collection a VERBATIM legacy boundary, counted as
// boundariesByKind["collection"] (NOT "collection-inlined").
// ---------------------------------------------------------------------------

describe("inline-collection refusals stay legacy boundaries", () => {
  it("materialized flatMap refuses inline (op_pending:flatMap), stays a collection boundary", async () => {
    // `fanned` is aliased DIRECTLY into the result → materialized (not
    // transient) → the boundary is a `collection` op whose op is flatMap →
    // tryBuildInlineCollectionNode refuses `op_pending:flatMap`. Two sibling
    // lifts collapse into a segment so the cost gate passes and the refused
    // collection boundary is RECORDED (boundariesByKind["collection"]).
    const buildPattern = () =>
      pattern<{ items: { n: number }[]; k: number }>((input) => {
        const Fan = pattern<{ element: { n: number } }>(
          (i) =>
            lift((v: { n: number }) => [v.n, v.n * 10])({ n: i.element.n }),
          ELEMENT_SCHEMA,
        );
        const fanned = (input.items as unknown as {
          flatMapWithPattern: (op: unknown, params: unknown) => unknown;
        }).flatMapWithPattern(Fan as unknown, {});
        const kPlus = lift((v: { k: number }) => v.k + 1)({ k: input.k });
        const kTimes = lift((v: { k: number }) => v.k * 2)({ k: input.k });
        return { fanned, kPlus, kTimes };
      }) as unknown as Pattern;

    const argument = { items: [{ n: 1 }, { n: 2 }], k: 7 };
    const edit = { path: ["items"], value: [{ n: 1 }, { n: 2 }, { n: 3 }] };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, {
      fanned: [1, 10, 2, 20],
      kPlus: 8,
      kTimes: 14,
    });
    assertEquals(legacy.afterEdit, {
      fanned: [1, 10, 2, 20, 3, 30],
      kPlus: 8,
      kTimes: 14,
    });

    // Refused inline → stayed a plain collection boundary, never inlined.
    assert(
      (census.boundariesByKind["collection"] ?? 0) >= 1,
      `expected a legacy collection boundary, census=${JSON.stringify(census)}`,
    );
    assertEquals(census.boundariesByKind["collection-inlined"] ?? 0, 0);
  });

  it("map whose element reads the whole `array` refuses inline (uses_array), stays a collection boundary", async () => {
    // Element reads `i.array` (the whole list) → elementArgumentUsage marks
    // usesArray → tryBuildInlineCollectionNode refuses `uses_array`. Result
    // is retained so the map materializes; two sibling lifts collapse so the
    // cost gate passes and the collection boundary is recorded.
    const buildPattern = () =>
      pattern<{ items: { n: number }[]; k: number }>((input) => {
        const WithLen = pattern<
          { element: { n: number }; array: { n: number }[] }
        >(
          (i) => ({
            len: lift((a: { arr: { n: number }[] }) => a.arr.length)({
              arr: i.array,
            }),
          }),
          {
            type: "object",
            properties: {
              element: {
                type: "object",
                properties: { n: { type: "number" } },
                required: ["n"],
              },
              array: { type: "array" },
            },
            required: ["element"],
          },
        );
        const mapped = (input.items as unknown as {
          mapWithPattern: (op: unknown, params: unknown) => unknown;
        }).mapWithPattern(WithLen as unknown, {});
        const kPlus = lift((v: { k: number }) => v.k + 1)({ k: input.k });
        const kTimes = lift((v: { k: number }) => v.k * 2)({ k: input.k });
        return { mapped, kPlus, kTimes };
      }) as unknown as Pattern;

    const argument = { items: [{ n: 1 }, { n: 2 }, { n: 3 }], k: 7 };
    const edit = { path: ["items"], value: [{ n: 10 }, { n: 20 }] };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    // Each element reports the whole-list length.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, {
      mapped: [{ len: 3 }, { len: 3 }, { len: 3 }],
      kPlus: 8,
      kTimes: 14,
    });
    assertEquals(legacy.afterEdit, {
      mapped: [{ len: 2 }, { len: 2 }],
      kPlus: 8,
      kTimes: 14,
    });

    assert(
      (census.boundariesByKind["collection"] ?? 0) >= 1,
      `expected uses_array refusal to keep a legacy collection boundary, census=${
        JSON.stringify(census)
      }`,
    );
    assertEquals(census.boundariesByKind["collection-inlined"] ?? 0, 0);
  });

  it("map whose element is not fully inlinable refuses inline (element_not_inlinable), stays a collection boundary", async () => {
    // The element contains a nested COLLECTION op (an inner map) →
    // rogFullyInlinable returns false → tryBuildInlineCollectionNode
    // refuses `element_not_inlinable`. (Control ops no longer disqualify an
    // element — W8 native control emission — so the fixture nests a map,
    // which stays deterministic without network I/O.)
    const PARTS_SCHEMA = {
      type: "object",
      properties: {
        element: {
          type: "object",
          properties: {
            parts: { type: "array", items: { type: "number" } },
          },
          required: ["parts"],
        },
      },
      required: ["element"],
    } as const;
    const buildPattern = () =>
      pattern<{ items: { parts: number[] }[]; k: number }>((input) => {
        const Double = pattern<{ element: number }>(
          (j) => ({ d: lift((v: { n: number }) => v.n * 2)({ n: j.element }) }),
          {
            type: "object",
            properties: { element: { type: "number" } },
            required: ["element"],
          } as const,
        );
        const Classify = pattern<{ element: { parts: number[] } }>(
          (i) => {
            const doubled = (i.element.parts as unknown as {
              mapWithPattern: (op: unknown, params: unknown) => unknown;
            }).mapWithPattern(Double as unknown, {});
            const total = lift((v: { list: { d: number }[] }) =>
              (v.list ?? []).reduce((a, x) => a + (x?.d ?? 0), 0)
            )({ list: doubled } as never);
            return { total };
          },
          PARTS_SCHEMA,
        );
        const labelled = (input.items as unknown as {
          mapWithPattern: (op: unknown, params: unknown) => unknown;
        }).mapWithPattern(Classify as unknown, {});
        const kPlus = lift((v: { k: number }) => v.k + 1)({ k: input.k });
        const kTimes = lift((v: { k: number }) => v.k * 2)({ k: input.k });
        return { labelled, kPlus, kTimes };
      }) as unknown as Pattern;

    const argument = { items: [{ parts: [1, 2] }, { parts: [10] }], k: 7 };
    const edit = { path: ["items"], value: [{ parts: [5] }] };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, {
      labelled: [{ total: 6 }, { total: 20 }],
      kPlus: 8,
      kTimes: 14,
    });
    assertEquals(legacy.afterEdit, {
      labelled: [{ total: 10 }],
      kPlus: 8,
      kTimes: 14,
    });

    assert(
      (census.boundariesByKind["collection"] ?? 0) >= 1,
      `expected element_not_inlinable refusal to keep a legacy collection boundary, census=${
        JSON.stringify(census)
      }`,
    );
    assertEquals(census.boundariesByKind["collection-inlined"] ?? 0, 0);
  });
});

// ---------------------------------------------------------------------------
// TARGET 3 — collection-inline.ts runtime edges (inline map/filter).
// ---------------------------------------------------------------------------

describe("inline collection runtime edges", () => {
  it("defined non-array input list is a loud error (map only supports arrays)", async () => {
    // A retained inline map over a DEFINED non-array value hits the
    // `!Array.isArray(rawList)` throw. Both flags fail the same way (legacy
    // map.ts parity) — assert the error surfaces on the flag-on run and the
    // pulled result is byte-equal between flags.
    const buildPattern = () =>
      pattern<{ items: { n: number }[] }>((input) => {
        const Double = pattern<{ element: { n: number } }>(
          (i) => ({
            d: lift((v: { n: number }) => v.n * 2)({ n: i.element.n }),
          }),
          ELEMENT_SCHEMA,
        );
        const mapped = (input.items as unknown as {
          mapWithPattern: (op: unknown, params: unknown) => unknown;
        }).mapWithPattern(Double as unknown, {});
        return { mapped };
      }) as unknown as Pattern;

    // Start valid, then edit to a DEFINED non-array (a number) — the loud
    // "only supports arrays" branch.
    const argument = { items: [{ n: 1 }, { n: 2 }] };
    const edit = { path: ["items"], value: 42 };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);

    // Initial (valid array) is byte-equal.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(legacy.initial, { mapped: [{ d: 2 }, { d: 4 }] });
    // After the non-array edit both flags surface the loud parity error
    // ("map currently only supports arrays"). The post-edit STALE state is
    // not asserted byte-equal: the partial write-through before the throw
    // differs harmlessly between the legacy coordinator and the inline map.
    assert(
      legacy.errors.some((m) => m.includes("only supports arrays")),
      `legacy should surface the non-array error, got ${
        JSON.stringify(legacy.errors)
      }`,
    );
    assert(
      interpreted.errors.some((m) => m.includes("only supports arrays")),
      `interpreted should surface the non-array error, got ${
        JSON.stringify(interpreted.errors)
      }`,
    );
  });

  it("filter keeps the predicate-true subset (contribute/kept path)", async () => {
    // A retained inline filter over a normal list with some false elements:
    // exercises the per-element contribute loop (included → kept.push) and
    // the final resultPresence.set(kept).
    const buildPattern = () =>
      pattern<{ items: { n: number }[] }>((input) => {
        const IsBig = pattern<{ element: { n: number } }>(
          (i) => lift((v: { n: number }) => v.n > 10)({ n: i.element.n }),
          ELEMENT_SCHEMA,
        );
        const big = (input.items as unknown as {
          filterWithPattern: (op: unknown, params: unknown) => unknown;
        }).filterWithPattern(IsBig as unknown, {});
        return { big };
      }) as unknown as Pattern;

    const argument = { items: [{ n: 5 }, { n: 20 }, { n: 7 }, { n: 30 }] };
    const edit = {
      path: ["items"],
      value: [{ n: 50 }, { n: 20 }, { n: 7 }, { n: 30 }],
    };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { big: [{ n: 20 }, { n: 30 }] });
    assertEquals(legacy.afterEdit, {
      big: [{ n: 50 }, { n: 20 }, { n: 30 }],
    });
    // The filter engaged the inline coordinator (materialized, retained).
    assert(
      (census.boundariesByKind["collection-inlined"] ?? 0) >= 1,
      `expected inline filter engagement, census=${JSON.stringify(census)}`,
    );
  });

  it("filter that keeps ZERO elements yields an empty container", async () => {
    // Every element fails the predicate → the contribute loop never pushes →
    // resultPresence.set([]) (kept stays empty). Byte-equal both flags.
    const buildPattern = () =>
      pattern<{ items: { n: number }[] }>((input) => {
        const IsBig = pattern<{ element: { n: number } }>(
          (i) => lift((v: { n: number }) => v.n > 100)({ n: i.element.n }),
          ELEMENT_SCHEMA,
        );
        const big = (input.items as unknown as {
          filterWithPattern: (op: unknown, params: unknown) => unknown;
        }).filterWithPattern(IsBig as unknown, {});
        return { big };
      }) as unknown as Pattern;

    const argument = { items: [{ n: 5 }, { n: 20 }, { n: 7 }] };
    // Still all below threshold after the edit → stays empty.
    const edit = { path: ["items"], value: [{ n: 1 }, { n: 2 }] };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { big: [] });
    assertEquals(legacy.afterEdit, { big: [] });
    assert(
      (census.boundariesByKind["collection-inlined"] ?? 0) >= 1,
      `expected inline filter engagement, census=${JSON.stringify(census)}`,
    );
  });
});
