/**
 * CFC SOUNDNESS ORACLE for the str → native `interpolate` op
 * (08-expression-interpretation §2).
 *
 * The increment lowers a recognized `str\`...${x}...\`` leaf to a native
 * `interpolate` op the evaluator computes directly — NO `str` SES leaf is
 * resolved or invoked under the flag. The soundness-critical property (design
 * §4): the per-path content-label of an interpolated VALUE must propagate into
 * the str result EXACTLY as the str leaf does today — a label SMEAR (over-label)
 * or a label DROP (under-label) is a confidentiality regression.
 *
 * The proof from the code: the interpreter node reads the argument ONCE, deeply,
 * through the tx; `deriveFlowJoin` taints the output by the JOIN of every labeled
 * observation journaled through that tx. Both the str leaf (over its input
 * construct) and the native `interpolate` op resolve the SAME `${...}` value refs
 * out of that already-read in-memory argument — neither re-reads through the tx —
 * so the journaled labeled set is identical. This oracle pins that empirically:
 * the result doc carries the interpolated value's confidentiality atom IDENTICALLY
 * under flag-off (leaf) and flag-on (interpolate). Plus: under the flag the str
 * leaf is never resolved (census `interpreted_ok`, no `unresolved_leaf`), and the
 * native op is what ran (the ROG carries an `interpolate` op, no str `leaf`).
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
const signer = await Identity.fromPassphrase("ri-str-interpolate-cfc");
const space = signer.did() as MemorySpace;

const str = { type: "string" } as const satisfies JSONSchema;

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

/** A pattern whose result interpolates a labeled argument field via `str`. */
function buildStrPattern(cf: any) {
  return cf.pattern(
    ({ secret, n }: { secret: string; n: number }) => ({
      // The interpolated `${secret}` carries a confidentiality atom; `${n}` is
      // plain. The result MUST inherit `secret`'s atom (the value flowed in).
      summary: cf.str`secret=${secret} count=${n}`,
    }),
    {
      type: "object",
      properties: { secret: str, n: { type: "number" } },
      required: ["secret", "n"],
    },
    { type: "object", properties: { summary: str } },
  );
}

/** Seed a labeled argument doc {secret, n}; `secret` carries `atom`. */
async function seedLabeledArg(
  runtime: Runtime,
  cause: string,
  atom: string,
): Promise<{ id: string }> {
  const seed = runtime.edit();
  const cell = runtime.getCell(
    space,
    cause,
    { type: "object", properties: { secret: str, n: { type: "number" } } },
    seed,
  );
  const id = cell.getAsNormalizedFullLink().id;
  seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
    value: { secret: "s3cr3t", n: 7 },
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
      `str-cfc-arg-${experimentalInterpreter}`,
      atom,
    );

    const argCell = runtime.getCell(
      space,
      `str-cfc-arg-${experimentalInterpreter}`,
      { type: "object", properties: { secret: str, n: { type: "number" } } },
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      `str-cfc-result-${experimentalInterpreter}`,
      { type: "object", properties: { summary: str } },
      tx,
    );
    const run = runtime.run(
      tx,
      buildStrPattern(cf),
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

describe("str → native interpolate op: CFC per-path label propagation (OQ-4)", () => {
  it("lowers a static-template str leaf to an `interpolate` op (no str leaf)", () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      experimental: { experimentalInterpreter: true },
    });
    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const cf = commonfabric as any;
      const pattern = buildStrPattern(cf);
      // deno-lint-ignore no-explicit-any
      const extracted = extractRog(pattern as any);
      const ops = extracted.rog.ops;
      const interpolateOps = ops.filter((o) => o.kind === "interpolate");
      // The single `str\`...\`` site lowered to ONE interpolate op.
      expect(interpolateOps.length).toBe(1);
      const ip = interpolateOps[0];
      expect(ip.detail.kind).toBe("interpolate");
      if (ip.detail.kind === "interpolate") {
        // Static segments carried inline, byte-for-byte the template literals.
        expect(ip.detail.strings).toEqual(["secret=", " count=", ""]);
        // Two `${...}` value refs, mirrored into op.inputs.
        expect(ip.detail.values.length).toBe(2);
        expect(ip.inputs.length).toBe(2);
      }
      // NO leaf op carries a str impl: the str leaf is gone, replaced natively.
      // (extract.ts never emits a `leaf` for the recognized str site.)
      const leafOps = ops.filter((o) => o.kind === "leaf");
      expect(leafOps.length).toBe(0);
      // No object/array construct synthesized for the str input — the
      // serialized-boundary shrink. (The only construct is the result object.)
      const constructOps = ops.filter((o) => o.kind === "construct");
      // result construct only (the {summary} object); NO {strings,values} +
      // strings-array + values-array constructs the leaf path would synthesize.
      expect(constructOps.length).toBeLessThanOrEqual(1);
    } finally {
      // Synchronous-ish; dispose without awaiting commit churn.
      void runtime.dispose();
      void storageManager.close();
    }
  });

  it("interpolated value confidentiality propagates IDENTICALLY: leaf vs native", async () => {
    const atom = "secret-atom-7";
    const off = await runVariant(false, atom);
    const on = await runVariant(true, atom);

    // 1. Byte-equivalent output (the str semantics are reproduced exactly).
    expect(on.output).toEqual(off.output);
    expect(on.output).toEqual({ summary: "secret=s3cr3t count=7" });

    // 2. The native op is what ran (not a silent fallback that trivially matches):
    //    interpreted_ok incremented, and the str leaf was NEVER unresolved (it is
    //    no longer a leaf — it lowered to the native interpolate op).
    expect(on.census.interpreted_ok).toBeGreaterThanOrEqual(1);
    expect(on.census.unresolved_leaf).toBe(0);

    // 3. SOUNDNESS: the interpolated `${secret}`'s confidentiality atom flows into
    //    the result doc — IDENTICALLY under leaf (flag-off) and native (flag-on).
    //    No smear (no EXTRA atoms), no drop (the atom is present in both).
    expect(off.derivedAtoms).toContain(atom);
    expect(on.derivedAtoms).toContain(atom);
    // Same set of derived atoms — the native op neither over- nor under-labels.
    expect([...on.derivedAtoms].sort()).toEqual([...off.derivedAtoms].sort());
  });
});
