/**
 * W3c — the differential oracle for the flag-on dispatch: the SAME
 * builder-built pattern runs through the REAL runtime with the interpreter
 * flag off and on; results must be deep-equal, reactivity (argument edit →
 * recompute) must match, and the census must show the pattern actually
 * INTERPRETED flag-on (never green-via-fallback — the v1 proxy-metric
 * lesson, made executable).
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { lift } from "../../src/builder/module.ts";
import { ifElse, str } from "../../src/builder/built-in.ts";
import type { Pattern } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import { trustExecutable } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

interface RunOutcome {
  initial: unknown;
  afterEdit: unknown;
}

/** Build the pattern INSIDE a runtime frame, run it, pull the result, apply
 * an argument edit, pull again — one flag state per call. */
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
      `ri2-dispatch-differential-${interpreter}`,
    );
    const result = runtime.run(
      undefined,
      trustExecutable(runtime, factory) as never,
      argument as never,
      resultCell as never,
    );
    // Snapshot IMMEDIATELY: pull() returns a live view that would otherwise
    // reflect the post-edit state by the time we serialize.
    const initial = JSON.parse(JSON.stringify(await result.pull()));

    // Reactivity: edit the argument, let the graph settle, re-read.
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

    return { initial, afterEdit };
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("interpreter dispatch differential (W3c)", () => {
  it("pure lift+str pattern: flag-on == flag-off, and it interprets", async () => {
    const buildPattern = () =>
      pattern<{ a: number; b: number }>((input) => {
        const sum = lift(({ a, b }: { a: number; b: number }) => a + b)({
          a: input.a,
          b: input.b,
        });
        const doubled = lift((v: { s: number }) => v.s * 2)({ s: sum });
        const label = str`sum=${sum}, doubled=${doubled}`;
        return { sum, doubled, label };
      }) as unknown as Pattern;

    const argument = { a: 2, b: 3 };
    const edit = { path: ["a"], value: 10 };

    const legacy = await runOnce(false, buildPattern, argument, edit);

    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    // The oracle: byte-equal results, initial and after the reactive edit.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);

    // Sanity on the actual values (not just mutual equality).
    assertEquals(legacy.initial, {
      sum: 5,
      doubled: 10,
      label: "sum=5, doubled=10",
    });
    assertEquals(legacy.afterEdit, {
      sum: 13,
      doubled: 26,
      label: "sum=13, doubled=26",
    });

    // Never green-via-fallback: the flag-on run must have interpreted.
    assert(
      census.interpreted >= 1,
      `expected interpreted>=1, census=${JSON.stringify(census)}`,
    );
  });

  it("multi-segment: segments coalesce around a preserved ifElse boundary", async () => {
    // seg0 (two lifts + str feeding the control inputs) → ifElse boundary
    // (the ORIGINAL node, verbatim — legacy branch-LINK semantics) → seg1
    // (a lift consuming the control output). Byte-equal both flags, and the
    // census proves real multi-segment engagement.
    const buildPattern = () =>
      pattern<{ flag: boolean; a: number; b: number }>((input) => {
        const doubled = lift((v: { a: number }) => v.a * 2)({ a: input.a });
        const tripled = lift((v: { b: number }) => v.b * 3)({ b: input.b });
        const picked = ifElse(input.flag, doubled, tripled);
        const label = str`picked=${picked}`;
        const shifted = lift((v: { p: number }) => v.p + 100)({ p: picked });
        return { picked, label, shifted };
      }) as unknown as Pattern;

    const argument = { flag: true, a: 1, b: 2 };
    const edit = { path: ["flag"], value: false };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, {
      picked: 2,
      label: "picked=2",
      shifted: 102,
    });
    assertEquals(legacy.afterEdit, {
      picked: 6,
      label: "picked=6",
      shifted: 106,
    });
    assert(
      census.interpreted >= 1,
      `expected multi-segment interpretation, census=${JSON.stringify(census)}`,
    );
    assert(
      (census.boundariesByKind["control"] ?? 0) >= 1,
      `expected a preserved control boundary, census=${JSON.stringify(census)}`,
    );
    assert(
      census.nodeOpsCollapsed >= 4,
      `expected >=4 collapsed node ops, census=${JSON.stringify(census)}`,
    );
  });

  it("consumed-as-value nested pattern inlines; result-retained stays a piece", async () => {
    // `inner` is consumed as a VALUE (only a downstream lift reads it) →
    // inlines, zero child docs. `retainedInner` is aliased DIRECTLY into
    // the result → its result cell is the observable piece → boundary.
    const buildPattern = () =>
      pattern<{ y: number; z: number }>((input) => {
        const inner = pattern<{ x: number }>((i) => ({
          doubled: lift((v: { x: number }) => v.x * 2)({ x: i.x }),
        }));
        const retainedInner = pattern<{ x: number }>((i) => ({
          tripled: lift((v: { x: number }) => v.x * 3)({ x: i.x }),
        }));
        const valueConsumed = inner({ x: input.y });
        const final = lift((v: { d: number }) => v.d + 1)({
          d: (valueConsumed as unknown as { doubled: number }).doubled,
        });
        return { final, retained: retainedInner({ x: input.z }) };
      }) as unknown as Pattern;

    const argument = { y: 20, z: 5 };
    const edit = { path: ["y"], value: 100 };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { final: 41, retained: { tripled: 15 } });
    assertEquals(legacy.afterEdit, {
      final: 201,
      retained: { tripled: 15 },
    });
    assert(
      census.interpreted >= 1,
      `expected interpretation, census=${JSON.stringify(census)}`,
    );
    // The retained child stays a preserved pattern boundary; the
    // value-consumed child is NOT among the boundaries (it inlined).
    assert(
      (census.boundariesByKind["pattern"] ?? 0) === 1,
      `expected exactly one pattern boundary, census=${JSON.stringify(census)}`,
    );
  });
});
