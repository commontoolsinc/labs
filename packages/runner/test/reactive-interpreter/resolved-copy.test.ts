/**
 * DERIVED-COPY resolved-ROG dispatch (false-rejection fix + hardening).
 *
 * A pattern instantiated as a DERIVED COPY (reload rehydration, embedded /
 * serialized sub-pattern) misses the STRICT getBuiltRog WeakMap key but
 * resolves to its canonical ROG via the derivation chain. Binding against
 * that canonical ROG is sound ONLY when the copy is POSITIONALLY FAITHFUL,
 * enforced by validatePositionalCorrespondence:
 *   (1) length,  (2) per-position module KIND,  (3) per-position ALIAS
 *   TARGET correspondence (the hardening — canonicalizing away the two
 *   lossless copy transforms: defer-count bumps + scope folded into schema).
 *
 * This file proves (A) the alias comparator canonicalizes the lossless
 * transforms yet FAILS closed on a reorder/retarget (the REORDER-OF-EQUALS
 * hole), and (B) a real serialized copy interprets via the resolved path
 * byte-identically to legacy, counted distinctly in the census.
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
  getBuiltRog,
  getBuiltRogResolved,
} from "../../src/reactive-interpreter/from-builder.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
  sameBindingSkeleton,
} from "../../src/reactive-interpreter/dispatch.ts";
import { serializePatternGraph } from "../../src/builder/json-utils.ts";
import { noteDerivedCopy } from "../../src/builder/pattern-metadata.ts";
import { trustExecutable } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("ri2 resolved-copy");
const space = signer.did();

describe("resolved-copy alias comparator (the hardening)", () => {
  const alias = (extra: Record<string, unknown>) => ({
    $alias: { cell: "argument", path: ["a"], ...extra },
  });

  it("passes IDENTICAL bindings", () => {
    assert(sameBindingSkeleton(alias({}), alias({})));
    assert(sameBindingSkeleton(
      { x: alias({}), y: [1, "s", true, null] },
      { x: alias({}), y: [1, "s", true, null] },
    ));
  });

  it("passes the two LOSSLESS transforms (defer bump, scope→schema)", () => {
    // Round-trip bumps the nesting level; target unchanged.
    assert(sameBindingSkeleton(alias({ defer: 0 }), alias({ defer: 2 })));
    // Scope folded into schema is an annotation, not the target.
    assert(sameBindingSkeleton(
      alias({ scope: "user" }),
      alias({ schema: { type: "number", scope: "user" } }),
    ));
    // Both at once.
    assert(sameBindingSkeleton(
      alias({ defer: 0, scope: "session" }),
      alias({ defer: 3, schema: { scope: "session" } }),
    ));
  });

  it("FAILS on a retargeted alias (REORDER-OF-EQUALS hole)", () => {
    // Same kind/shape, DIFFERENT target path — must fail closed.
    assert(
      !sameBindingSkeleton(
        alias({}),
        { $alias: { cell: "argument", path: ["b"] } },
      ),
    );
    // Different cell classification.
    assert(
      !sameBindingSkeleton(
        alias({}),
        { $alias: { cell: "result", path: ["a"] } },
      ),
    );
    // Different internal partialCause target.
    assert(
      !sameBindingSkeleton(
        { $alias: { partialCause: { x: 1 }, path: [] } },
        { $alias: { partialCause: { x: 2 }, path: [] } },
      ),
    );
  });

  it("FAILS on divergent const literals / container shape", () => {
    assert(!sameBindingSkeleton({ k: 1 }, { k: 2 }));
    assert(!sameBindingSkeleton([alias({})], [alias({}), alias({})]));
    // An alias where the other side is a plain value.
    assert(!sameBindingSkeleton(alias({}), { cell: "argument", path: ["a"] }));
  });
});

interface RunOutcome {
  initial: unknown;
  afterEdit: unknown;
}

/** Run one pattern object (canonical or derived copy) through the runtime. */
async function runPattern(
  interpreter: boolean,
  factory: Pattern,
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
    const resultCell = runtime.getCell(
      space,
      `ri2-resolved-copy-${interpreter}`,
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
    return { initial, afterEdit };
  } finally {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("resolved-copy runtime differential", () => {
  it("a serialized derived copy interprets via the resolved ROG, byte-equal to legacy", async () => {
    // A ≥2-lift chain so the interpreted plan clears the cost gate.
    const buildCanonical = () =>
      pattern<{ a: number; b: number }>((input) => {
        const sum = lift((v: { a: number; b: number }) => v.a + v.b)({
          a: input.a,
          b: input.b,
        });
        const doubled = lift((v: { s: number }) => v.s * 2)({ s: sum });
        const shifted = lift((v: { d: number }) => v.d + 1)({ d: doubled });
        return { sum, doubled, shifted };
      }) as unknown as Pattern;

    const argument = { a: 2, b: 3 };
    const edit = { path: ["a"], value: 10 };

    // LEGACY oracle from the CANONICAL (flag off).
    const frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime: new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
      }),
    });
    let copy: Pattern;
    try {
      const canonical = buildCanonical();
      // A derived copy: serialize the canonical graph and link it back.
      copy = serializePatternGraph(canonical) as unknown as Pattern;
      noteDerivedCopy(copy, canonical);
      // The copy takes the RESOLVED path (strict miss, resolved hit).
      assertEquals(getBuiltRog(copy), undefined);
      assert(
        getBuiltRogResolved(copy) !== undefined,
        "copy should resolve to the canonical ROG",
      );
    } finally {
      popFrame(frame);
    }

    const legacy = await runPattern(false, buildCanonical(), argument, edit);

    resetDispatchCensus();
    const interpreted = await runPattern(true, copy, argument, edit);
    const census = getDispatchCensus();

    // Byte-equal, initial and after the reactive edit.
    assertEquals(interpreted.initial, legacy.initial);
    assertEquals(interpreted.afterEdit, legacy.afterEdit);
    assertEquals(legacy.initial, { sum: 5, doubled: 10, shifted: 11 });
    assertEquals(legacy.afterEdit, { sum: 13, doubled: 26, shifted: 27 });

    // The engagement came via the RESOLVED path, counted distinctly.
    assert(
      census.interpretedViaResolved >= 1,
      `expected resolved-path engagement, census=${JSON.stringify(census)}`,
    );
    // And never mis-attributed: no no_rog / derived_* fallback for it.
    assertEquals(census.fallbackByReason["no_rog"] ?? 0, 0);
    assertEquals(census.fallbackByReason["derived_edge"] ?? 0, 0);
    assertEquals(census.fallbackByReason["derived_kind"] ?? 0, 0);
    assertEquals(census.fallbackByReason["derived_len"] ?? 0, 0);
  });
});
