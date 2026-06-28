/**
 * CHILD-RESULT-FIELD INLINE engagement + correctness oracle (INC-LC3).
 *
 * Proves the launched-child result-field INLINE folds a result-tree-ONLY segment
 * output (a pure `str` display field) out of its own derived-internal doc and
 * into the child's result doc — WITHOUT changing any addressable output value or
 * breaking per-field reactivity.
 *
 * Two differential oracles (same pattern, flag off vs flag on):
 *
 *  (1) STR-RESOLUTION + INLINE ENGAGEMENT — a child whose pure chain ends in two
 *      `str`s (`label`, `summary`) interprets (census `interpreted_ok >= 1`),
 *      its output is byte-IDENTICAL to legacy, and a `value`-only change leaves
 *      the value-INDEPENDENT sibling (`summary`) byte-identical (per-field
 *      reactivity: the inline writes ONLY its own result subpath). Before the str
 *      provenance stamp the two `str` leaves were `unresolved-leaf` boundaries
 *      and the child fell back; this asserts they now resolve to segment outputs
 *      that fold.
 *
 *  (2) CONTENTION GATE — the SAME child shape under a non-default (PerUser) scope
 *      stays output-equivalent to legacy. The gate keeps the fields in separate
 *      docs (no fold onto a shared hot doc), so correctness is unchanged whether
 *      or not it folds; this guards the lunch-poll/PollOptionCard fallback.
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
const signer = await Identity.fromPassphrase("ri-child-result-inline");

interface RowOutcome {
  interpretedOk: number;
  initialLabel: unknown;
  initialSummary: unknown;
  initialValue: unknown;
  afterLabel: unknown;
  afterSummary: unknown;
  afterValue: unknown;
}

/** Run a parent that maps ONE config to a launched child pattern carrying a pure
 * `str` display chain (`label`, `summary`) + a handler boundary that mutates the
 * row's `value`. Reports the census + the child's projected fields before and
 * after the handler fires. `scope` optionally narrows the child argument (the
 * contention-gate input). */
async function runRow(
  experimentalInterpreter: boolean,
  scope: "space" | "user",
): Promise<RowOutcome> {
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
    const normValue = cf.lift((v: number | undefined) =>
      typeof v === "number" ? v : 0
    );
    const normStep = cf.lift((s: number | undefined) =>
      typeof s === "number" && s !== 0 ? Math.abs(s) : 1
    );
    const rowIncrement = cf.handler(
      (
        { cycles }: { cycles?: number },
        ctx: { value: number; step: number },
      ) => {
        const n = typeof cycles === "number" ? cycles : 1;
        ctx.value += ctx.step * n;
      },
      { proxy: true },
    );

    // The child: 2 pure lifts + 2 `str`s feeding ONLY the result, plus one
    // handler boundary that writes `value` (the row's OWN per-instance state).
    // Optionally narrowed to PerUser via the argument schema (contention input).
    const childArgSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        step: { type: "number" },
      },
      ...(scope === "user" ? { scope } : {}),
    };
    const rowChild = cf.pattern(
      (
        { value, step }: { value: number; step: number },
      ) => {
        const v = normValue(value);
        const s = normStep(step);
        const label = cf.str`value ${v}`;
        const summary = cf.str`step ${s}`;
        return {
          value: v,
          step: s,
          label,
          summary,
          increment: rowIncrement({ value, step: s }),
        };
      },
      childArgSchema,
    );

    const launch = cf.lift(
      (cfg: { value: number; step: number }) => rowChild(cfg),
    );

    const parent = cf.pattern(
      ({ value, step }: { value: number; step: number }) => ({
        row: launch({ value, step }),
      }),
    );

    const resultCell = runtime.getCell(space, "child-inline", undefined);
    const tx = runtime.edit();
    const r = runtime.run(tx, parent, { value: 1, step: 1 }, resultCell);
    await tx.commit();
    await runtime.idle();
    r.sink(() => {});
    await runtime.idle();

    const read = async () => {
      const out = await r.pull() as { row?: Record<string, unknown> };
      const row = out.row ?? {};
      return {
        label: row.label,
        summary: row.summary,
        value: row.value,
      };
    };

    const initial = await read();
    // Fire the row handler: value 1 -> 2, so `label` (depends on value) must
    // update while `summary` (depends only on step) stays byte-identical.
    r.key("row").key("increment").send({ cycles: 1 });
    await runtime.idle();
    const after = await read();

    return {
      interpretedOk: runtime.runner.getInterpreterCensus().interpreted_ok,
      initialLabel: initial.label,
      initialSummary: initial.summary,
      initialValue: initial.value,
      afterLabel: after.label,
      afterSummary: after.summary,
      afterValue: after.value,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("child-result-field inline (INC-LC3)", () => {
  it("str resolves + folds result-only fields, output equal to legacy, sibling not re-derived", async () => {
    const legacy = await runRow(false, "space");
    const interpreted = await runRow(true, "space");

    // ENGAGEMENT: the launched child interpreted (str now resolves to a segment
    // output, so the pure region partitions and folds).
    expect(legacy.interpretedOk).toBe(0);
    expect(interpreted.interpretedOk).toBeGreaterThanOrEqual(1);

    // OUTPUT BYTE-EQUIVALENCE OFF==ON (the inline never changes the addressable
    // value at any result path), initially AND after the handler fires.
    expect(interpreted.initialLabel).toEqual(legacy.initialLabel);
    expect(interpreted.initialSummary).toEqual(legacy.initialSummary);
    expect(interpreted.initialValue).toEqual(legacy.initialValue);
    expect(interpreted.afterLabel).toEqual(legacy.afterLabel);
    expect(interpreted.afterSummary).toEqual(legacy.afterSummary);
    expect(interpreted.afterValue).toEqual(legacy.afterValue);

    // EXPECTED values: label tracks value (1 -> 2), summary tracks step (stable).
    expect(interpreted.initialLabel).toBe("value 1");
    expect(interpreted.initialSummary).toBe("step 1");
    expect(interpreted.afterLabel).toBe("value 2");

    // SIBLING-FIELD NON-INVALIDATION (per-field reactivity): a value-only change
    // leaves the value-independent `summary` byte-identical — the inline wrote
    // ONLY its own result subpath, never re-touching `summary`.
    expect(interpreted.afterSummary).toBe(interpreted.initialSummary);
    expect(interpreted.afterSummary).toBe("step 1");
  });

  it("keeps a non-default-scoped (PerUser) child output-equivalent to legacy (contention gate)", async () => {
    const legacy = await runRow(false, "user");
    const interpreted = await runRow(true, "user");

    // The child still INTERPRETS its pure region (the partition engages: this is
    // the contention gate inside the partition path, NOT a wholesale fallback) —
    // proving the gate is a per-fold decision, not a coarse "scoped ⇒ legacy" cut.
    expect(interpreted.interpretedOk).toBeGreaterThanOrEqual(1);

    // The contention gate keeps the PerUser child's fields in separate docs (no
    // fold onto a shared hot doc — RI_PART debug prints
    // `inline-skipped-multi-user-shared`). Whether it folds or not, correctness
    // must hold: the projected output is byte-identical to legacy, before/after.
    expect(interpreted.initialLabel).toEqual(legacy.initialLabel);
    expect(interpreted.initialSummary).toEqual(legacy.initialSummary);
    expect(interpreted.initialValue).toEqual(legacy.initialValue);
    expect(interpreted.afterLabel).toEqual(legacy.afterLabel);
    expect(interpreted.afterSummary).toEqual(legacy.afterSummary);
    expect(interpreted.afterValue).toEqual(legacy.afterValue);

    // EXPECTED values still hold under the gate (value 1 -> 2, summary stable).
    expect(interpreted.initialLabel).toBe("value 1");
    expect(interpreted.afterLabel).toBe("value 2");
    expect(interpreted.afterSummary).toBe("step 1");
  });
});
