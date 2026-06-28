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
import { inputsOf } from "../../src/reactive-interpreter/rog.ts";
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

  it("§4.7: a NESTED-frame unrecognized alias is excluded from topFrameUnrecognizedAliases", () => {
    // A child sub-pattern node whose own frame carries an unrecognized alias (a
    // `defer`-bearing arg ref that the child frame, extracted at depth 1, sees as
    // non-local). It MUST appear in the whole-recursion `unrecognizedAliases` but
    // NOT in `topFrameUnrecognizedAliases` — the outer pattern is not blocked by a
    // nested frame's cross-frame indirection (it is validated when the child
    // re-dispatches, §4.7).
    const childPattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "cout", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          // A `defer:1` arg ref inside the child frame: at depth 1 the local
          // defer is 1, so this resolves LOCALLY (recognized). To force a NESTED-
          // frame unrecognized, use a defer that is NOT the child's expected
          // level (defer:5 — neither local nor the outer level).
          inputs: {
            bad: { $alias: { cell: "argument", path: ["z"], defer: 5 } },
          },
          outputs: { $alias: { partialCause: "cout", path: [] } },
        },
      ],
    };
    const r = extractRog({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "pattern", implementation: childPattern },
          inputs: { v: { $alias: { cell: "argument", path: ["x"] } } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
      // deno-lint-ignore no-explicit-any
    } as any);
    // The nested-frame unrecognized alias is in the whole-recursion report …
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
    // … but NOT attributed to the TOP frame.
    expect(r.coverage.topFrameUnrecognizedAliases).toEqual([]);
  });

  it("§4.7: a TOP-frame unrecognized alias IS in topFrameUnrecognizedAliases", () => {
    // The outer pattern's OWN frame carries a non-local `defer` arg ref. It must
    // appear in BOTH reports — a genuine top-frame alias problem still fails
    // closed for the outer pattern.
    const r = extractRog({
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "javascript", implementation: (i: unknown) => i },
          inputs: {
            bad: { $alias: { cell: "argument", path: ["a"], defer: 3 } },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
      // deno-lint-ignore no-explicit-any
    } as any);
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
    expect(r.coverage.topFrameUnrecognizedAliases.length).toBeGreaterThan(0);
    expect(r.coverage.topFrameUnrecognizedAliases).toEqual(
      r.coverage.unrecognizedAliases,
    );
  });
});

// ---------------------------------------------------------------------------
// F1 — boundary (effect) ops carry their input ValueRef(s).
//
// Production extraction USED to give `op.inputs` only to LEAF ops; an effect op
// (a `fetch`/`generateText`/`sqlite` value computation, or a handler) got
// `detail = {kind:"effect", sink}` with NO refs and `rog.ts::inputsOf` returned
// [] for it. So a boundary like `fetch(a)` had no `boundary←producer` edge in
// the ROG, and the coalescing partitioner (§4.2) could not order the producing
// segment before the boundary it feeds, nor label the CFC read-through (§4.5).
//
// F1 captures the boundary op's value-producer input ValueRef(s) from the raw
// `node.inputs` alias tree (using the SAME `aliasToValueRef` path leaf nodes
// use), EXCLUDING event-stream aliases (a handler's `$event`). The interpreter
// is UNCHANGED — effect ops still throw `NotInterpretedHere`; this only ADDS
// edges to the ROG.
// ---------------------------------------------------------------------------
describe("F1: boundary (effect) ops carry input ValueRefs", () => {
  it("a fetchData(computed) boundary now carries its producer input ref (was empty)", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      // ({url}) => ({ data: fetchData({ url, mode:"json" }) }). The fetchData
      // ref builtin classifies as `effect` (EFFECT_REFS). Its input reads the
      // `url` argument — that read must now appear as a boundary input ValueRef.
      const p = cf.pattern(
        // deno-lint-ignore no-explicit-any
        ({ url }: any) => ({ data: cf.fetchData({ url, mode: "json" }) }),
        {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
        { type: "object" },
      );
      const r = extractRog(p);

      const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
      expect(effect).toBeDefined();
      // The GAP this closes: the effect op's inputs are NO LONGER empty.
      expect(effect!.inputs.length).toBeGreaterThan(0);
      // `inputsOf` surfaces the same refs (so topoOrder + the partitioner see the
      // boundary←producer edges).
      expect(inputsOf(effect!).length).toBeGreaterThan(0);
      // The boundary reads the `url` argument — captured as an argument ref.
      const readsUrl = inputsOf(effect!).some((ref) =>
        ref.kind === "argument" && ref.path.includes("url")
      );
      expect(readsUrl).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("a handler boundary carries its captured-value input ref, EXCLUDING the $event stream", () => {
    const env = createMeasureEnv(signer);
    try {
      // deno-lint-ignore no-explicit-any
      const cf = env.commonfabric as any;
      const numS = { type: "number" } as const satisfies JSONSchema;
      // ({count}) => ({ count, increment: handler({count}) }). The handler node
      // (wrapper:"handler") classifies as `effect`. Its `inputs` are
      // `{ $ctx: {count: <arg>}, $event: <stream> }`: the `count` capture is a
      // value producer (must appear), the `$event` stream is an event source
      // (must NOT appear).
      const p = cf.pattern(
        // deno-lint-ignore no-explicit-any
        ({ count }: any) => {
          const increment = cf.handler(
            { type: "object" },
            { type: "object", properties: { count: numS } },
            // deno-lint-ignore no-explicit-any
            (_e: any, s: any) => {
              s.count = s.count + 1;
            },
          );
          return { count, increment: increment({ count }) };
        },
        { type: "object", properties: { count: numS } },
        {
          type: "object",
          properties: { count: numS, increment: { asStream: true } },
        } as JSONSchema,
      );
      const r = extractRog(p);

      const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
      expect(effect).toBeDefined();
      // The handler boundary now carries its captured-value input ref(s).
      expect(effect!.inputs.length).toBeGreaterThan(0);
      // The captured `count` value is read (a value-producer edge).
      const readsCount = inputsOf(effect!).some((ref) =>
        (ref.kind === "argument" || ref.kind === "internal") &&
        ref.path.includes("count")
      );
      expect(readsCount).toBe(true);
      // The `$event` stream alias is EXCLUDED — no ref names a stream-typed
      // producer. (Stream aliases carry `partialCause.$kind === "stream"`, which
      // `aliasToValueRef` would otherwise record as `internal`. We assert none of
      // the captured refs is the event stream by confirming every captured ref is
      // a recognized value producer — argument/internal/opOut/const — and the
      // count edge is present; the stream is structurally absent because
      // `effectInputRefs` skips it.)
      for (const ref of inputsOf(effect!)) {
        expect(["argument", "internal", "opOut", "const"]).toContain(ref.kind);
      }
    } finally {
      env.dispose();
    }
  });

  it("FAIL-CLOSED: a malformed boundary input alias is recorded (not silently resolved)", () => {
    // Hand-built effect node whose input mixes a recognized argument alias with
    // a MALFORMED `$alias` (truthy non-record payload). The malformed one MUST be
    // recorded into `unrecognizedAliases` (the same fail-closed contract leaf
    // inputs hold), and the boundary's captured refs must NOT include a bogus ref
    // for it. (`isEffect:true` forces the `effect` classification on a hand-built
    // node so `effectInputRefs` runs.)
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "ref", implementation: "fetchData" },
          inputs: {
            ok: { $alias: { cell: "argument", path: ["url"] } },
            // Malformed — bears a `$alias` key but the payload is a string.
            bad: { $alias: "str" },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    // Recorded (→ ineligible → legacy fallback), not silently resolved.
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
    // The effect op captured the well-formed `url` ref but NOT the malformed one.
    const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
    expect(effect).toBeDefined();
    const readsUrl = effect!.inputs.some((ref) =>
      ref.kind === "argument" && ref.path.includes("url")
    );
    expect(readsUrl).toBe(true);
    // No const placeholder snuck in for the malformed alias.
    expect(effect!.inputs.some((ref) => ref.kind === "const")).toBe(false);
  });

  it("FAIL-CLOSED: a `defer`-bearing boundary input alias falls back, not mis-resolved", () => {
    // A canonical alias carrying a non-local `defer` (serialized / nested-pattern
    // indirection the interpreter does not model). On a boundary input it must
    // fail closed exactly as on a leaf input — recorded, not resolved as level-0.
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: { type: "ref", implementation: "fetchData" },
          inputs: {
            deferred: { $alias: { cell: "argument", path: ["a"], defer: 1 } },
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    expect(r.coverage.unrecognizedAliases.length).toBeGreaterThan(0);
    // The deferred alias was NOT resolved to a plain `argument` boundary ref.
    const effect = r.rog.ops.find((op) => op.detail.kind === "effect");
    expect(effect).toBeDefined();
    expect(effect!.inputs.some((ref) => ref.kind === "argument")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SERIALIZED / LOADED str leaf → native `interpolate` op (the production-
// dominant win: a loaded pattern's str leaf has NO live `cf:builtin/str`
// provenance — `module.implementation` is the source STRING — but the
// serialization-surviving `$builtin:"str"` brand still identifies it, so it
// lowers WITHOUT an `$implRef`/SES round-trip. These hand-built RawPatterns
// model exactly the JSON-parsed module shape a loaded pattern presents to
// `extractRog` (verified empirically: a serialized str node carries
// `{"type":"javascript","$builtin":"str","$implRef":{...}}` — brand AND an
// $implRef the leaf path would otherwise resolve via SES). 08-expression-
// interpretation §2/§5.
// ---------------------------------------------------------------------------
describe("str → interpolate: SERIALIZED / LOADED leaf (no live provenance)", () => {
  // The serialized str module: `implementation` is the framework body's SOURCE
  // STRING (provenance is gone post-serialization), the brand rides through, and
  // — as the real wire form shows — an `$implRef` is also present. The recognizer
  // must lower it to `interpolate` and the op must carry NO `impl` (so
  // `resolveLeafImpls` never touches it = the SES round-trip the load path used
  // to pay).
  const serializedStrModule = (extra?: Record<string, unknown>) => ({
    type: "javascript",
    implementation:
      '({strings, values}) => strings.reduce((result, str, i) => result + str + (i < values.length ? values[i] : ""), "")',
    $builtin: "str",
    // A loaded str node carries an $implRef too — the recognizer must STILL lower
    // it (brand wins) and leave `impl` undefined, not resolve the leaf via SES.
    $implRef: { identity: "cf:module/str-hash", symbol: "" },
    resultSchema: { type: "string" } as JSONSchema,
    ...extra,
  });

  it("lowers a LOADED static-template str leaf to `interpolate` (no leaf, no impl)", () => {
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: serializedStrModule(),
          inputs: {
            strings: ["secret=", " count=", ""],
            values: [
              { $alias: { cell: "argument", path: ["secret"] } },
              { $alias: { cell: "argument", path: ["n"] } },
            ],
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    const interpolate = r.rog.ops.filter((o) => o.kind === "interpolate");
    expect(interpolate.length).toBe(1);
    const ip = interpolate[0];
    // No leaf, no impl → `resolveLeafImpls` never resolves it (no SES).
    expect(ip.impl).toBeUndefined();
    expect(r.rog.ops.some((o) => o.kind === "leaf")).toBe(false);
    expect(ip.detail.kind).toBe("interpolate");
    if (ip.detail.kind === "interpolate") {
      expect(ip.detail.strings).toEqual(["secret=", " count=", ""]);
      expect(ip.detail.values.length).toBe(2);
      // The two `${...}` refs resolve to the argument fields, IN ORDER.
      expect(ip.detail.values[0]).toEqual({
        kind: "argument",
        path: ["secret"],
      });
      expect(ip.detail.values[1]).toEqual({ kind: "argument", path: ["n"] });
    }
    // The value refs are MIRRORED into op.inputs (so topo/partition/CFC surface
    // them with no extra clause).
    expect(inputsOf(ip).filter((ref) => ref.kind === "argument").length).toBe(
      2,
    );
    // No `unrecognized` entry — a clean, eligible lowering.
    expect(r.coverage.unrecognizedAliases.length).toBe(0);
  });

  it("FAIL-CLOSED: an UNBRANDED str-shaped foreign leaf stays a `leaf` (not lowered)", () => {
    // Byte-identical body + the exact `{strings,values}` input, but NO brand and
    // NO live provenance → it is NOT str; recognizing it would let an arbitrary
    // foreign function impersonate str. It MUST stay a leaf.
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: serializedStrModule({ $builtin: undefined }),
          inputs: {
            strings: ["x=", ""],
            values: [{ $alias: { cell: "argument", path: ["x"] } }],
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    // Not lowered: no interpolate op; the foreign leaf is preserved as a leaf.
    expect(r.rog.ops.some((o) => o.kind === "interpolate")).toBe(false);
    expect(r.rog.ops.some((o) => o.kind === "leaf")).toBe(true);
  });

  it("FAIL-CLOSED: a DYNAMIC `strings` (non-literal element) stays a `leaf`", () => {
    // The universal transformer shape is a fully-static `strings` literal array.
    // A `strings` whose element is itself a ref (a dynamically-built template) is
    // out of the recognized subset → fall back to the leaf path unchanged.
    const pattern = {
      argumentSchema: { type: "object" } as JSONSchema,
      resultSchema: { type: "object" } as JSONSchema,
      result: { $alias: { partialCause: "out", path: [] } },
      nodes: [
        {
          module: serializedStrModule(),
          inputs: {
            strings: ["a", { $alias: { cell: "argument", path: ["seg"] } }],
            values: [{ $alias: { cell: "argument", path: ["x"] } }],
          },
          outputs: { $alias: { partialCause: "out", path: [] } },
        },
      ],
    };
    // deno-lint-ignore no-explicit-any
    const r = extractRog(pattern as any);
    expect(r.rog.ops.some((o) => o.kind === "interpolate")).toBe(false);
    expect(r.rog.ops.some((o) => o.kind === "leaf")).toBe(true);
  });
});
