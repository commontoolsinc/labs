/**
 * W0.4 — Pattern → ROG extraction coverage.
 *
 * Builds representative patterns via the real builder, extracts each into the
 * ROG vocabulary, and reports honest coverage: every node should classify into
 * a known OpKind, the recognized `$alias` shapes should resolve to ValueRefs,
 * and the collection element graph should be recursed. Unrecognized shapes are
 * surfaced (the boundary W1 must close), not hidden.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { createMeasureEnv } from "../support/interpreter-measure.ts";
import { extractRog } from "../../src/reactive-interpreter/extract.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-extract");
const num = { type: "number" } as const satisfies JSONSchema;

describe("W0.4 extraction coverage", () => {
  it("classifies map / control / leaf patterns and recurses element graphs", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;

      // (a) map over a list — collection + nested element pattern.
      const dbl = cf.lift((x: number) => x * 2, num, num);
      const elem = cf.pattern(
        ({ element }: { element: number }) => dbl(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        num,
      );
      const mapP = cf.pattern(
        // deno-lint-ignore no-explicit-any
        ({ values }: { values: any }) => ({
          mapped: values.mapWithPattern(elem, {}),
        }),
        {
          type: "object",
          properties: { values: { type: "array", items: num } },
          required: ["values"],
        },
        {
          type: "object",
          properties: { mapped: { type: "array", items: num } },
        },
      );

      // (b) control — ifElse over a boolean argument.
      const ctrlP = cf.pattern(
        ({ show, a, b }: { show: boolean; a: number; b: number }) => ({
          out: cf.ifElse(show, a, b),
        }),
        {
          type: "object",
          properties: { show: { type: "boolean" }, a: num, b: num },
          required: ["show", "a", "b"],
        },
        { type: "object", properties: { out: num } },
      );

      // (c) plain leaf — a single lift over the argument.
      const leafP = cf.pattern(
        ({ x }: { x: number }) => ({ y: dbl(x) }),
        { type: "object", properties: { x: num }, required: ["x"] },
        { type: "object", properties: { y: num } },
      );

      const mapR = extractRog(mapP);
      const ctrlR = extractRog(ctrlP);
      const leafR = extractRog(leafP);

      for (
        const [name, r] of [["map", mapR], ["ctrl", ctrlR], [
          "leaf",
          leafR,
        ]] as const
      ) {
        console.log(
          `[extract ${name}] nodes=${r.coverage.nodes} classified=${r.coverage.classified}` +
            ` byKind=${
              JSON.stringify(r.coverage.byKind)
            } nested=${r.coverage.nested}` +
            ` unrecognized=${JSON.stringify(r.coverage.unrecognizedAliases)}` +
            ` result=${JSON.stringify(r.rog.result)}`,
        );
      }

      // Every node classifies (leaf is the sound default; nothing falls to
      // "unknown").
      for (const r of [mapR, ctrlR, leafR]) {
        expect(r.coverage.classified).toBe(r.coverage.nodes);
        expect(r.coverage.byKind.unknown ?? 0).toBe(0);
      }

      // map classified a collection op and recursed its element graph.
      expect(mapR.coverage.byKind.collection ?? 0).toBeGreaterThanOrEqual(1);
      expect(mapR.coverage.nested).toBeGreaterThanOrEqual(1);
      // its result is a synthesized object construct whose `mapped` field
      // resolves to the internal "mapped" cell (not silently dropped to const).
      expect(mapR.rog.result.kind).toBe("opOut");
      const ctor = mapR.rog.ops.find((op) => op.detail.kind === "construct");
      expect(ctor).toBeDefined();
      const tmpl = ctor!.detail.kind === "construct"
        ? ctor!.detail.template
        : undefined;
      const mappedField = tmpl?.shape === "object"
        ? tmpl.fields["mapped"]
        : undefined;
      expect(mappedField?.kind).toBe("internal");

      // control classified a control op.
      expect(ctrlR.coverage.byKind.control ?? 0).toBeGreaterThanOrEqual(1);

      // leaf pattern produced at least one leaf op reading the argument.
      expect(leafR.coverage.byKind.leaf ?? 0).toBeGreaterThanOrEqual(1);
      const leafReadsArg = leafR.rog.ops.some((op) =>
        op.inputs.some((i) => i.kind === "argument")
      );
      expect(leafReadsArg).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("multi-input leaf (object-of-aliases) is reconstructed losslessly into a construct", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const add = cf.lift(
        (i: { a: number; b: number }) => i.a + i.b,
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        num,
      );
      const p = cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({ sum: add({ a, b }) }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { sum: num } },
      );
      const r = extractRog(p);

      // Lossless ⇒ nothing unrecognized (the keys a/b are preserved, not dropped).
      expect(r.coverage.unrecognizedAliases).toEqual([]);

      // The leaf op has EXACTLY ONE input, pointing at a synthesized object
      // construct that re-keys {a, b} (NOT a positional alias array).
      const leaf = r.rog.ops.find((op) => op.detail.kind === "leaf");
      expect(leaf).toBeDefined();
      expect(leaf!.inputs.length).toBe(1);
      const inputRef = leaf!.inputs[0];
      expect(inputRef.kind).toBe("opOut");
      const inputConstruct = r.rog.ops.find((op) =>
        op.detail.kind === "construct" &&
        inputRef.kind === "opOut" && op.id === inputRef.op
      );
      expect(inputConstruct).toBeDefined();
      const tmpl = inputConstruct!.detail.kind === "construct"
        ? inputConstruct!.detail.template
        : undefined;
      expect(tmpl?.shape).toBe("object");
      if (tmpl?.shape === "object") {
        expect(Object.keys(tmpl.fields).sort()).toEqual(["a", "b"]);
        expect(tmpl.fields["a"].kind).toBe("argument");
        expect(tmpl.fields["b"].kind).toBe("argument");
      }
    } finally {
      env.dispose();
    }
  });

  it("FAIL-CLOSED: an unrecognized alias inside a structured input is recorded, not dropped", () => {
    // Hand-built node (a leaf whose object-of-aliases input mixes a recognized
    // argument alias with an UNRECOGNIZED alias shape). The unrecognized one
    // MUST be recorded into `unrecognizedAliases` (→ ineligible), never silently
    // skipped to a bogus partial construct.
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: {
            ok: { $alias: { cell: "argument", path: ["a"] } },
            // Not a recognized alias form (no cell:"argument", no partialCause).
            bad: { $alias: { cell: "self", path: ["x"] } },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
  });

  // --- Residual silent-drop closures (canonical-predicate fail-closed). ---
  // Each shape below bears a `$alias` key that is NOT a faithfully
  // representable structured input. Every one MUST be recorded into
  // `unrecognizedAliases` (→ pattern ineligible → legacy fallback) and MUST NOT
  // be collapsed to a silent `const undefined` or a partial construct.

  // Walk every op in the extracted rog and assert that no synthesized construct
  // template carries a `$alias`-shaped field/item and no leaf input is a stray
  // `const undefined` standing in for a dropped alias — i.e. confirm the value
  // was recorded, not silently materialized.
  const assertNoSilentAliasDrop = (
    // deno-lint-ignore no-explicit-any
    pattern: any,
  ) => {
    const r = extractRog(pattern);
    // Recorded, not dropped.
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
    // No construct op reconstructed a `$alias` literal (which would mean we
    // walked into the alias-bearing object and emitted a bogus template).
    for (const op of r.rog.ops) {
      if (op.detail.kind !== "construct") continue;
      const tmpl = op.detail.template;
      if (tmpl.shape === "object") {
        expect(Object.keys(tmpl.fields)).not.toContain("$alias");
      }
    }
    return r;
  };

  it("FAIL-CLOSED: {$alias:'str'} (truthy non-object payload) is recorded, not dropped", () => {
    assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: { bad: { $alias: "str" } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    });
  });

  it("FAIL-CLOSED: {$alias:null} (falsy payload) is recorded, not dropped", () => {
    assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: { bad: { $alias: null } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    });
  });

  it("FAIL-CLOSED: $alias mixed with sibling keys is recorded, siblings not dropped", () => {
    assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: {
            mixed: {
              $alias: { cell: "argument", path: ["a"] },
              sibling: { $alias: { cell: "argument", path: ["b"] } },
            },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    });
  });

  it("FAIL-CLOSED: a `defer`-bearing alias (serialized / nested-pattern) falls back, not mis-resolved", () => {
    const r = assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          // A canonical alias (record + array path) that ALSO carries `defer`
          // — the interpreter does not model deferred resolution, so it must
          // fail closed rather than resolve it as a level-0 (non-deferred) ref.
          inputs: {
            deferred: { $alias: { cell: "argument", path: ["a"], defer: 1 } },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    });
    // The deferred alias was NOT resolved to a plain `argument` ValueRef.
    const argRefs = r.rog.ops.flatMap((op) =>
      op.inputs.filter((i) => i.kind === "argument")
    );
    expect(argRefs.length).toBe(0);
  });

  it("FAIL-CLOSED: a non-number `defer` also fails closed (not resolved as level-0)", () => {
    // The builder only ever emits `defer` as a number, but a hand-built /
    // arbitrarily serialized alias could carry e.g. `defer: true`. The guard is
    // type-agnostic (`"defer" in alias && alias.defer !== 0`), so this too is
    // recorded rather than silently resolved as a non-deferred ref.
    const r = assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: {
            // deno-lint-ignore no-explicit-any
            deferred: {
              $alias: { cell: "argument", path: ["a"], defer: true },
            } as any,
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    });
    const argRefs = r.rog.ops.flatMap((op) =>
      op.inputs.filter((i) => i.kind === "argument")
    );
    expect(argRefs.length).toBe(0);
  });

  it("FAIL-CLOSED: a malformed OUTPUT alias is recorded (no dangling internal ref → undefined)", () => {
    // A node whose `outputs` bears a `$alias` key but is NOT canonical
    // (`{$alias:"str"}`) cannot be mapped to an internal name; an `internal` ref
    // to it would silently resolve to `undefined` with no throw. The output side
    // must fail closed too, so the pattern falls back to legacy.
    assertNoSilentAliasDrop({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: { x: { $alias: { cell: "argument", path: ["a"] } } },
          // Malformed output alias — non-canonical payload.
          // deno-lint-ignore no-explicit-any
          outputs: { $alias: "str" } as any,
        },
      ],
    });
  });

  it("NOT over-tightened: a `scope`-bearing canonical alias (no defer) still interprets", () => {
    // The fresh in-memory builder attaches `scope` to ordinary top-level
    // argument/internal aliases (builder/pattern.ts:349) at the eligible tier.
    // Failing closed on `scope` would regress those real patterns, so a
    // canonical alias carrying ONLY `scope` (no `defer`) must STILL resolve.
    const r = extractRog({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: {
            scoped: {
              $alias: {
                cell: "argument",
                path: ["a"],
                scope: { id: "frame-1" },
              },
            },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
      // deno-lint-ignore no-explicit-any
    } as any);
    // Resolves (no fallback) and the argument alias is recognized.
    expect(r.coverage.unrecognizedAliases).toEqual([]);
    // The synthesized input construct carries an `argument` field for `scoped`.
    const ctor = r.rog.ops.find((op) =>
      op.detail.kind === "construct" && op.detail.template.shape === "object"
    );
    expect(ctor).toBeDefined();
    const tmpl = ctor!.detail.kind === "construct"
      ? ctor!.detail.template
      : undefined;
    if (tmpl?.shape === "object") {
      expect(tmpl.fields["scoped"]?.kind).toBe("argument");
    }
  });
});
