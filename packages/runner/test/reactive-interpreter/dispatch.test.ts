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

  it("control pattern: flag-on == flag-off via the reference-semantics fallback", async () => {
    // ifElse/when/unless are gated (`control_reference_semantics`) until
    // control emission writes branch LINKS like the legacy builtins. This
    // oracle pins that the gate is safe: equal outputs, census shows the
    // fallback (not an interpretation).
    const buildPattern = () =>
      pattern<{ flag: boolean; a: number; b: number }>((input) => ({
        picked: ifElse(input.flag, input.a, input.b),
      })) as unknown as Pattern;

    const argument = { flag: true, a: 1, b: 2 };
    const edit = { path: ["flag"], value: false };

    const legacy = await runOnce(false, buildPattern, argument, edit);
    resetDispatchCensus();
    const interpreted = await runOnce(true, buildPattern, argument, edit);
    const census = getDispatchCensus();

    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { picked: 1 });
    assertEquals(legacy.afterEdit, { picked: 2 });
    assert(
      (census.fallbackByReason["control_reference_semantics"] ?? 0) >= 1,
      `expected control fallback, census=${JSON.stringify(census)}`,
    );
  });
});
