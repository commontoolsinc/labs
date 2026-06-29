/**
 * CFC SOUNDNESS ORACLE for the operator → native `expr` op
 * (08-expression-interpretation §2/§3) — the per-path content-label gate (OQ-4)
 * AND the flag-off runtime byte-parity gate.
 *
 * The increment lowers a branded (`$builtin: "expr:<op>"`) arithmetic/comparison
 * lift leaf to a native `expr` op the evaluator computes directly — the opaque
 * operator lift body is NEVER resolved/invoked under the flag. Two properties are
 * soundness-critical (design §4):
 *
 *   (1) FLAG-OFF BYTE PARITY: legacy runs the branded module's identical operator
 *       body over the identical resolved operands, so the materialized value is
 *       byte-for-byte what the un-branded lift would compute. We assert flag-off
 *       == flag-on output (and == the raw JS).
 *   (2) PER-PATH LABEL JOIN: the per-path content-label of a labeled OPERAND must
 *       propagate into the operator result EXACTLY as the leaf does today — no
 *       SMEAR (over-label) and no DROP (under-label). The native `expr` op
 *       resolves the SAME operand refs out of the already-read in-memory argument
 *       the leaf body would have read; neither re-reads through the tx, so the
 *       journaled labeled set (hence `deriveFlowJoin`'s taint) is identical.
 *
 * Plus: under the flag the operator leaf is never resolved (`interpreted_ok`, no
 * `unresolved_leaf`), and the native op is what ran (the ROG carries an `expr`
 * op, no operator `leaf`).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import { extractRog } from "../../src/reactive-interpreter/extract.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-expr-interp-cfc");
const space = signer.did() as MemorySpace;

const num = { type: "number" } as const satisfies JSONSchema;
const bool = { type: "boolean" } as const satisfies JSONSchema;

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[] };
  origin?: string;
};

function derivedConfidentiality(
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): string[] {
  const replica = storageManager.open(space).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  const entries = replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  return entries
    .filter((e) => e.origin === "derived")
    .flatMap((e) => e.label.confidentiality ?? []);
}

/** A pattern whose result derives `sum = secret + 1` (BINARY +) and
 * `match = secret === threshold` (BINARY ===) via branded `expr` ops over a
 * labeled argument field. Mirrors what the transformer emits for `secret + 1`
 * and `secret === threshold`. */
// deno-lint-ignore no-explicit-any
function buildExprPattern(cf: any) {
  return cf.pattern(
    ({ secret, threshold }: { secret: number; threshold: number }) => ({
      // The `secret` operand carries a confidentiality atom; the literal `1` and
      // `threshold` are plain. Both results MUST inherit `secret`'s atom.
      sum: cf.exprLift("expr:+", ([a, b]: [number, number]) => a + b)([
        secret,
        1,
      ]),
      match: cf.exprLift(
        "expr:===",
        ([a, b]: [number, number]) => a === b,
      )([secret, threshold]),
    }),
    {
      type: "object",
      properties: { secret: num, threshold: num },
      required: ["secret", "threshold"],
    },
    { type: "object", properties: { sum: num, match: bool } },
  );
}

/** Seed a labeled argument doc {secret, threshold}; `secret` carries `atom`. */
async function seedLabeledArg(
  runtime: Runtime,
  cause: string,
  atom: string,
): Promise<{ id: string }> {
  const seed = runtime.edit();
  const cell = runtime.getCell(
    space,
    cause,
    {
      type: "object",
      properties: { secret: num, threshold: num },
    },
    seed,
  );
  const id = cell.getAsNormalizedFullLink().id;
  seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
    value: { secret: 41, threshold: 41 },
    cfc: {
      version: 1,
      schemaHash: "seed-schema",
      labelMap: {
        version: 1,
        entries: [{ path: ["secret"], label: { confidentiality: [atom] } }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return { id };
}

interface VariantResult {
  output: unknown;
  derivedAtoms: string[];
  census: { interpreted_ok: number; unresolved_leaf: number };
}

async function runVariant(
  experimentalInterpreter: boolean,
  atom: string,
): Promise<VariantResult> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    experimental: { experimentalInterpreter },
    cfcEnforcementMode: "observe",
    cfcFlowLabels: "persist",
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const cf = commonfabric as any;
    await seedLabeledArg(
      runtime,
      `expr-cfc-arg-${experimentalInterpreter}`,
      atom,
    );

    const argCell = runtime.getCell(
      space,
      `expr-cfc-arg-${experimentalInterpreter}`,
      { type: "object", properties: { secret: num, threshold: num } },
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      `expr-cfc-result-${experimentalInterpreter}`,
      { type: "object", properties: { sum: num, match: bool } },
      tx,
    );
    const run = runtime.run(
      tx,
      buildExprPattern(cf),
      argCell,
      resultCell,
    );
    await tx.commit();
    await runtime.idle();
    run.sink(() => {});
    await runtime.idle();
    const output = await run.pull();

    const resultId = resultCell.getAsNormalizedFullLink().id;
    const derivedAtoms = derivedConfidentiality(storageManager, resultId);
    const c = runtime.runner.getInterpreterCensus();
    return {
      output,
      derivedAtoms,
      census: {
        interpreted_ok: c.interpreted_ok,
        unresolved_leaf: c.fallback_by_reason.unresolved_leaf,
      },
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("operator → native expr op: extraction + CFC label propagation (OQ-4)", () => {
  it("lowers branded operator leaves to `expr` ops (no operator leaf)", () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      experimental: { experimentalInterpreter: true },
    });
    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const cf = commonfabric as any;
      const pattern = buildExprPattern(cf);
      // deno-lint-ignore no-explicit-any
      const extracted = extractRog(pattern as any);
      const ops = extracted.rog.ops;
      const exprOps = ops.filter((o) => o.kind === "expr");
      // Two operator sites lowered to TWO expr ops.
      expect(exprOps.length).toBe(2);
      const opTokens = exprOps
        .map((o) => (o.detail.kind === "expr" ? o.detail.op : null))
        .sort();
      expect(opTokens).toEqual(["+", "==="]);
      // NO leaf op carries an operator impl: the operator leaves are gone.
      const leafOps = ops.filter((o) => o.kind === "leaf");
      expect(leafOps.length).toBe(0);
    } finally {
      void runtime.dispose();
      void storageManager.close();
    }
  });

  it("operand confidentiality propagates IDENTICALLY: leaf vs native + flag parity", async () => {
    const atom = "secret-atom-expr-9";
    const off = await runVariant(false, atom);
    const on = await runVariant(true, atom);

    // 1. FLAG PARITY + byte-equivalent output (operator semantics reproduced
    //    exactly; legacy runs the branded body identically to the native op).
    expect(on.output).toEqual(off.output);
    expect(on.output).toEqual({ sum: 42, match: true });

    // 2. The native op is what ran (not a silent fallback that trivially matches):
    //    interpreted_ok incremented, and no operator leaf was unresolved (it is no
    //    longer a leaf — it lowered to native expr ops).
    expect(on.census.interpreted_ok).toBeGreaterThanOrEqual(1);
    expect(on.census.unresolved_leaf).toBe(0);

    // 3. SOUNDNESS: the labeled `secret` operand's confidentiality atom flows into
    //    the result doc — IDENTICALLY under leaf (flag-off) and native (flag-on).
    //    No smear (no EXTRA atoms), no drop (the atom is present in both).
    expect(off.derivedAtoms).toContain(atom);
    expect(on.derivedAtoms).toContain(atom);
    // Same set of derived atoms — the native op neither over- nor under-labels.
    expect([...on.derivedAtoms].sort()).toEqual([...off.derivedAtoms].sort());
  });
});
