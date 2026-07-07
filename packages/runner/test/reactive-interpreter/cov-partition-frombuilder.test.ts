/**
 * Coverage-directed unit tests for partition.ts + from-builder.ts.
 *
 * partition.ts is exercised two ways:
 *  - SYNTHETIC BuiltRogs (hand-built Rog + side-tables) drive the branches the
 *    real builder cannot easily reach: gated-leaf / unresolved-leaf boundary
 *    classification, control-as-boundary, collection vs inlinable-collection,
 *    pattern vs inlinable-pattern, cross-layer edges + fixpoint layering,
 *    missing-op / result-self-ref fail-closed, and the structural recursion
 *    into a collection element / nested-pattern child (inner partition).
 *  - REAL builder ROGs for the end-to-end shapes.
 *
 * from-builder.ts is exercised through the REAL builder for the classification
 * / incomplete branches (function_in_input, cyclic_value, non_fixed_point_const
 * for bigint/NaN/undefined-in-array, handler effect sink, computed ungated
 * leaf, control/collection ops, external cells), plus direct census calls.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { computed, handler, lift } from "../../src/builder/module.ts";
import { fetchJson, ifElse, str } from "../../src/builder/built-in.ts";
import type { Frame } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  type BuiltRog,
  getBuiltRog,
  getBuiltRogResolved,
  getRogConstructionCensus,
  resetRogConstructionCensus,
  setBuiltRog as setBuiltRogViaModule,
} from "../../src/reactive-interpreter/from-builder.ts";
import { partition } from "../../src/reactive-interpreter/partition.ts";
import type {
  Op,
  OpId,
  Rog,
  ValueRef,
} from "../../src/reactive-interpreter/rog.ts";
import { ROG_VERSION } from "../../src/reactive-interpreter/rog.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// ---------------------------------------------------------------------------
// Synthetic-Rog helpers (no builder needed — precise branch control).
// ---------------------------------------------------------------------------

function emptyRog(ops: Op[], result: ValueRef): Rog {
  return {
    v: ROG_VERSION,
    argumentSchema: {},
    resultSchema: {},
    result,
    ops,
    internals: [],
  };
}

function builtOfRog(
  rog: Rog,
  opts: {
    leafImpls?: Map<OpId, (input: unknown) => unknown>;
    children?: Map<OpId, BuiltRog>;
    collectionElements?: Map<OpId, unknown>;
  } = {},
): BuiltRog {
  return {
    rog,
    leafImpls: opts.leafImpls ?? new Map(),
    children: opts.children ?? new Map(),
    leafArgSchemas: new Map(),
    collectionElements: opts.collectionElements ?? new Map(),
  };
}

/** A pure leaf op reading its single input. */
function leafOp(id: OpId, input: ValueRef): Op {
  return {
    id,
    kind: "leaf",
    inputs: [input],
    outSchema: {},
    detail: { kind: "leaf" },
  };
}

function opOut(op: OpId): ValueRef {
  return { kind: "opOut", op, path: [] };
}

const argRef: ValueRef = { kind: "argument", path: ["a"] };

// ---------------------------------------------------------------------------

describe("partition.ts — boundaryKindOf + fail-closed (synthetic)", () => {
  it("a leaf without a live impl is an unresolved-leaf boundary", () => {
    // Leaf id 0 has NO entry in leafImpls → unresolved-leaf.
    const ops: Op[] = [leafOp(0, argRef)];
    const rog = emptyRog(ops, opOut(0));
    const result = partition({ built: builtOfRog(rog) });
    assert(result.partitionable, JSON.stringify(result));
    assertEquals(result.boundaries.length, 1);
    assertEquals(result.boundaries[0].kind, "unresolved-leaf");
    assertEquals(result.boundaries[0].opId, 0);
    // No segment (only op is a boundary).
    assertEquals(result.segments.length, 0);
  });

  it("a leaf WITH an impl demoted via boundaryLeafOps is a gated-leaf", () => {
    const ops: Op[] = [leafOp(0, argRef)];
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog(ops, opOut(0));
    const built = builtOfRog(rog, { leafImpls: impls });

    // Without the gate the leaf is pure → a segment, no boundary.
    const plain = partition({ built });
    assert(plain.partitionable);
    assertEquals(plain.boundaries.length, 0);
    assertEquals(plain.segments.length, 1);

    // Gated: kept as a legacy boundary node.
    const gated = partition({ built, boundaryLeafOps: new Set([0]) });
    assert(gated.partitionable);
    assertEquals(gated.boundaries.length, 1);
    assertEquals(gated.boundaries[0].kind, "gated-leaf");
  });

  it("controlAsBoundary=true classifies a control op as a boundary", () => {
    const ctrl: Op = {
      id: 0,
      kind: "control",
      inputs: [],
      outSchema: {},
      detail: {
        kind: "control",
        op: "ifElse",
        pred: argRef,
        then: { kind: "const", value: 1 },
        else: { kind: "const", value: 2 },
      },
    };
    const rog = emptyRog([ctrl], opOut(0));
    const built = builtOfRog(rog);

    const asBnd = partition({ built, controlAsBoundary: true });
    assert(asBnd.partitionable);
    assertEquals(asBnd.boundaries.length, 1);
    assertEquals(asBnd.boundaries[0].kind, "control");

    // When NOT treated as a boundary, control is pure (PURE_KINDS) → segment.
    const asPure = partition({ built, controlAsBoundary: false });
    assert(asPure.partitionable);
    assertEquals(asPure.boundaries.length, 0);
    assertEquals(asPure.segments.length, 1);
  });

  it("a collection op is a boundary unless listed inlinable", () => {
    const coll: Op = {
      id: 0,
      kind: "collection",
      inputs: [],
      outSchema: {},
      detail: { kind: "collection", op: "map", listInput: argRef },
    };
    const rog = emptyRog([coll], opOut(0));
    const built = builtOfRog(rog);

    const bnd = partition({ built });
    assert(bnd.partitionable);
    assertEquals(bnd.boundaries.length, 1);
    assertEquals(bnd.boundaries[0].kind, "collection");

    const inlined = partition({
      built,
      inlinableCollectionOps: new Set([0]),
    });
    assert(inlined.partitionable);
    assertEquals(inlined.boundaries.length, 0);
    assertEquals(inlined.segments.length, 1);
  });

  it("a pattern op inlinable via inlinablePatternOps drops the boundary", () => {
    // Child ROG must be present + fully pure so per-op inlining is valid.
    const childRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["x"] })],
      opOut(0),
    );
    const childBuilt = builtOfRog(childRog, {
      leafImpls: new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]),
    });
    const pat: Op = {
      id: 0,
      kind: "pattern",
      inputs: [],
      outSchema: {},
      detail: { kind: "pattern", argument: argRef, child: childRog },
    };
    const rog = emptyRog([pat], opOut(0));
    const built = builtOfRog(rog, {
      children: new Map<OpId, BuiltRog>([[0, childBuilt]]),
    });

    // Default: boundary.
    const bnd = partition({ built });
    assert(bnd.partitionable);
    assertEquals(bnd.boundaries[0].kind, "pattern");

    // Per-op inlinable → not a boundary.
    const inlined = partition({ built, inlinablePatternOps: new Set([0]) });
    assert(inlined.partitionable);
    assertEquals(inlined.boundaries.length, 0);
    assertEquals(inlined.segments.length, 1);
  });

  it("inlinePurePatterns=true inlines a recursively-pure child pattern", () => {
    const childRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["x"] })],
      opOut(0),
    );
    const childBuilt = builtOfRog(childRog, {
      leafImpls: new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]),
    });
    const pat: Op = {
      id: 0,
      kind: "pattern",
      inputs: [],
      outSchema: {},
      detail: { kind: "pattern", argument: argRef, child: childRog },
    };
    const rog = emptyRog([pat], opOut(0));
    const built = builtOfRog(rog, {
      children: new Map<OpId, BuiltRog>([[0, childBuilt]]),
    });

    const inlined = partition({ built, inlinePurePatterns: true });
    assert(inlined.partitionable);
    assertEquals(inlined.boundaries.length, 0);
  });

  it("an incomplete top-level ROG fails closed", () => {
    const rog = emptyRog([leafOp(0, argRef)], opOut(0));
    rog.incomplete = ["some_reason"];
    const result = partition({ built: builtOfRog(rog) });
    assert(!result.partitionable);
    assert(result.reason.includes("incomplete"));
    assert(result.reason.includes("some_reason"));
  });

  it("an opOut ref naming a missing op fails closed", () => {
    // Leaf reads opOut(99) which does not exist.
    const ops: Op[] = [leafOp(0, opOut(99))];
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog(ops, opOut(0));
    const result = partition({ built: builtOfRog(rog, { leafImpls: impls }) });
    assert(!result.partitionable);
    assert(result.reason.includes("missing op 99"), result.reason);
  });

  it("a result-self-reference fails closed", () => {
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog([leafOp(0, argRef)], {
      kind: "result",
      path: ["out"],
    });
    const result = partition({ built: builtOfRog(rog, { leafImpls: impls }) });
    assert(!result.partitionable);
    assert(result.reason.includes("result"), result.reason);
  });

  it("an internal ref with a missing producer op fails closed", () => {
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog(
      [leafOp(0, { kind: "internal", cell: 0, path: [] })],
      opOut(0),
    );
    // internals[0].producedBy points at a nonexistent op id.
    rog.internals = [{ partialCause: "x", producedBy: 42 }];
    const result = partition({ built: builtOfRog(rog, { leafImpls: impls }) });
    assert(!result.partitionable);
    assert(result.reason.includes("producedBy missing op 42"), result.reason);
  });

  it("an internal ref with NO producer is an externally-written input", () => {
    // internals[0] has no producedBy → treated like an argument (no producer),
    // recorded as a segment input, partition succeeds.
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog(
      [leafOp(0, { kind: "internal", cell: 0, path: [] })],
      opOut(0),
    );
    rog.internals = [{ partialCause: "handler-state" }];
    const result = partition({ built: builtOfRog(rog, { leafImpls: impls }) });
    assert(result.partitionable, JSON.stringify(result));
    assertEquals(result.segments.length, 1);
    // The external internal ref is the segment's read input.
    assertEquals(result.segments[0].inputs.length, 1);
    assertEquals(result.segments[0].inputs[0].kind, "internal");
  });
});

describe("partition.ts — layering, edges, fan-out (synthetic)", () => {
  it("an effect between two leaves cuts layers and emits cross-layer edges", () => {
    // op0 leaf (arg) -> op1 effect(reads op0) -> op2 leaf(reads op1)
    const leaf0 = leafOp(0, argRef);
    const effect1: Op = {
      id: 1,
      kind: "effect",
      inputs: [opOut(0)],
      outSchema: {},
      detail: { kind: "effect", sink: "io", writeTargets: [] },
    };
    const leaf2 = leafOp(2, opOut(1));
    const impls = new Map<OpId, (i: unknown) => unknown>([
      [0, (v) => v],
      [2, (v) => v],
    ]);
    const rog = emptyRog([leaf0, effect1, leaf2], opOut(2));
    const result = partition({ built: builtOfRog(rog, { leafImpls: impls }) });
    assert(result.partitionable, JSON.stringify(result));

    assertEquals(result.boundaries.length, 1);
    assertEquals(result.boundaries[0].kind, "effect");
    // Two segments in two layers (upstream leaf, downstream leaf).
    assertEquals(result.segments.length, 2);
    assertEquals(result.segments[0].layer, 0);
    assertEquals(result.segments[1].layer, 1);

    const kinds = new Set(result.edges.map((e) => e.kind));
    assert(kinds.has("seg->bnd"), JSON.stringify(result.edges));
    assert(kinds.has("bnd->seg"), JSON.stringify(result.edges));

    // Upstream segment materializes the boundary input.
    assert(result.segments[0].outputs.length >= 1);
  });

  it("a segment feeding two effects is reported as a fan-out segment", () => {
    // op0 leaf -> effect1(reads op0), effect2(reads op0)
    const leaf0 = leafOp(0, argRef);
    const effect1: Op = {
      id: 1,
      kind: "effect",
      inputs: [opOut(0)],
      outSchema: {},
      detail: { kind: "effect", sink: "io", writeTargets: [] },
    };
    const effect2: Op = {
      id: 2,
      kind: "effect",
      inputs: [opOut(0)],
      outSchema: {},
      detail: { kind: "effect", sink: "io", writeTargets: [] },
    };
    const impls = new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]);
    const rog = emptyRog([leaf0, effect1, effect2], opOut(0));
    const result = partition({
      built: builtOfRog(rog, { leafImpls: impls }),
    });
    assert(result.partitionable, JSON.stringify(result));
    assertEquals(result.boundaries.length, 2);
    assertEquals(result.fanoutSegmentIds.length, 1);
    // The fan-out segment is seg0.
    assert(result.fanoutSegmentIds[0].startsWith("seg0"));
  });

  it("chained effects produce a bnd->bnd edge", () => {
    // effect0(arg) -> effect1(reads effect0)
    const effect0: Op = {
      id: 0,
      kind: "effect",
      inputs: [argRef],
      outSchema: {},
      detail: { kind: "effect", sink: "io", writeTargets: [] },
    };
    const effect1: Op = {
      id: 1,
      kind: "effect",
      inputs: [opOut(0)],
      outSchema: {},
      detail: { kind: "effect", sink: "io", writeTargets: [] },
    };
    const rog = emptyRog([effect0, effect1], opOut(1));
    const result = partition({ built: builtOfRog(rog) });
    assert(result.partitionable, JSON.stringify(result));
    const kinds = new Set(result.edges.map((e) => e.kind));
    assert(kinds.has("bnd->bnd"), JSON.stringify(result.edges));
  });
});

describe("partition.ts — structural recursion into inner (synthetic)", () => {
  it("recurses into a nested-pattern child and attaches an inner partition", () => {
    // child ROG: single leaf. Non-inlined (default) → a pattern boundary whose
    // inner sub-partition is computed from built.children.
    const childRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["x"] })],
      opOut(0),
    );
    const childBuilt = builtOfRog(childRog, {
      leafImpls: new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]),
    });
    const pat: Op = {
      id: 0,
      kind: "pattern",
      inputs: [],
      outSchema: {},
      detail: { kind: "pattern", argument: argRef, child: childRog },
    };
    const rog = emptyRog([pat], opOut(0));
    const built = builtOfRog(rog, {
      children: new Map<OpId, BuiltRog>([[0, childBuilt]]),
    });
    const result = partition({ built });
    assert(result.partitionable);
    assertEquals(result.boundaries[0].kind, "pattern");
    assertExists(result.boundaries[0].inner, "inner partition attached");
    assert(result.boundaries[0].inner!.partitionable);
  });

  it("an incomplete nested-pattern child fails the whole partition closed", () => {
    const childRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["x"] })],
      opOut(0),
    );
    childRog.incomplete = ["child_bad"];
    const childBuilt = builtOfRog(childRog);
    const pat: Op = {
      id: 0,
      kind: "pattern",
      inputs: [],
      outSchema: {},
      detail: { kind: "pattern", argument: argRef, child: childRog },
    };
    const rog = emptyRog([pat], opOut(0));
    const built = builtOfRog(rog, {
      children: new Map<OpId, BuiltRog>([[0, childBuilt]]),
    });
    const result = partition({ built });
    assert(!result.partitionable);
    assert(result.reason.includes("child_bad"), result.reason);
  });

  it("recurses into a collection element via collectionElements + resolveElementBuilt", () => {
    // The element ROG resolves through getBuiltRogResolved(factory). We register
    // a factory object directly in the side-table so resolveElementBuilt finds
    // it, and set detail.element so the recursion branch is taken.
    const elementRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["element"] })],
      opOut(0),
    );
    const elementBuilt = builtOfRog(elementRog, {
      leafImpls: new Map<OpId, (i: unknown) => unknown>([[0, (v) => v]]),
    });
    // A stand-in factory object registered in the WeakMap side-table.
    const factory = {};
    setBuiltRogViaModule(factory, elementBuilt);

    const coll: Op = {
      id: 0,
      kind: "collection",
      inputs: [],
      outSchema: {},
      detail: {
        kind: "collection",
        op: "map",
        listInput: argRef,
        element: elementRog,
      },
    };
    const rog = emptyRog([coll], opOut(0));
    const built = builtOfRog(rog, {
      collectionElements: new Map<OpId, unknown>([[0, factory]]),
    });
    const result = partition({ built });
    assert(result.partitionable, JSON.stringify(result));
    assertEquals(result.boundaries[0].kind, "collection");
    assertExists(
      result.boundaries[0].inner,
      "collection element inner partition attached",
    );
    assert(result.boundaries[0].inner!.partitionable);
    // resolveElementBuilt found the registered factory.
    assert(getBuiltRogResolved(factory) !== undefined);
  });

  it("an incomplete collection element fails the partition closed", () => {
    const elementRog = emptyRog(
      [leafOp(0, { kind: "argument", path: ["element"] })],
      opOut(0),
    );
    elementRog.incomplete = ["element_bad"];
    const elementBuilt = builtOfRog(elementRog);
    const factory = {};
    setBuiltRogViaModule(factory, elementBuilt);

    const coll: Op = {
      id: 0,
      kind: "collection",
      inputs: [],
      outSchema: {},
      detail: {
        kind: "collection",
        op: "map",
        listInput: argRef,
        element: elementRog,
      },
    };
    const rog = emptyRog([coll], opOut(0));
    const built = builtOfRog(rog, {
      collectionElements: new Map<OpId, unknown>([[0, factory]]),
    });
    const result = partition({ built });
    assert(!result.partitionable);
    assert(result.reason.includes("element_bad"), result.reason);
  });
});

// ---------------------------------------------------------------------------
// from-builder.ts — real builder ROGs.
// ---------------------------------------------------------------------------

describe("from-builder.ts — lookups + census (synthetic + direct)", () => {
  it("getBuiltRog / getBuiltRogResolved return undefined for non-objects", () => {
    assertEquals(getBuiltRog(undefined), undefined);
    assertEquals(getBuiltRog(42), undefined);
    assertEquals(getBuiltRog(null), undefined);
    assertEquals(getBuiltRogResolved("string"), undefined);
    assertEquals(getBuiltRogResolved(null), undefined);
  });

  it("getBuiltRogResolved returns undefined for an unregistered object", () => {
    assertEquals(getBuiltRogResolved({}), undefined);
  });

  it("resetRogConstructionCensus zeroes every counter", () => {
    resetRogConstructionCensus();
    const c = getRogConstructionCensus();
    assertEquals(c.patterns, 0);
    assertEquals(c.complete, 0);
    assertEquals(c.incomplete, 0);
    assertEquals(c.buildErrors, 0);
    assertEquals(Object.keys(c.opsByKind).length, 0);
    assertEquals(Object.keys(c.incompleteReasons).length, 0);
  });
});

describe("from-builder.ts — classification + incomplete via real builder", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("a function in the input tree marks function_in_input", () => {
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: unknown) => v)({ n: input.n, fn: () => 1 }),
    }));
    const rog = getBuiltRog(factory)!.rog;
    assert(
      rog.incomplete?.includes("function_in_input"),
      JSON.stringify(rog.incomplete),
    );
  });

  it("a cyclic object in the input tree marks cyclic_value", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: unknown) => v)({ n: input.n, weird: cyc }),
    }));
    const rog = getBuiltRog(factory)!.rog;
    assert(
      rog.incomplete?.includes("cyclic_value"),
      JSON.stringify(rog.incomplete),
    );
  });

  it("a bigint const marks non_fixed_point_const", () => {
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: unknown) => v)({ n: input.n, big: 10n }),
    }));
    const rog = getBuiltRog(factory)!.rog;
    assert(
      rog.incomplete?.includes("non_fixed_point_const"),
      JSON.stringify(rog.incomplete),
    );
  });

  it("NaN and undefined-in-array both refuse (non_fixed_point_const)", () => {
    for (const cfg of [{ v: NaN }, { arr: [1, undefined, 3] }]) {
      const factory = pattern<{ n: number }>((input) => ({
        out: lift((v: unknown) => v)({ n: input.n, cfg }),
      }));
      const built = getBuiltRog(factory);
      assert(
        built === undefined ||
          built.rog.incomplete?.includes("non_fixed_point_const"),
        `expected refusal for ${JSON.stringify(cfg)}`,
      );
    }
  });

  it("a handler emits an effect op with sink 'handler'", () => {
    const h = handler<{ x: number }, { n: number }>({}, {}, () => {});
    const factory = pattern<{ n: number }>((input) => ({
      // deno-lint-ignore no-explicit-any
      out: h({ n: input.n }) as any,
    }));
    const rog = getBuiltRog(factory)!.rog;
    assertEquals(rog.incomplete, undefined);
    const effect = rog.ops.find((o) => o.kind === "effect");
    assertExists(effect);
    assert(effect!.detail.kind === "effect");
    assertEquals(effect!.detail.sink, "handler");
  });

  it("a computed (argumentSchema false) emits an ungated leaf", () => {
    const factory = pattern<{ n: number }>((_input) => ({
      out: computed(() => 42),
    }));
    const built = getBuiltRog(factory)!;
    const leaf = built.rog.ops.find((o) => o.kind === "leaf");
    assertExists(leaf);
    assert(leaf!.detail.kind === "leaf");
    assertEquals(leaf!.detail.ungated, true);
    // The live impl is captured and runnable.
    assertEquals(built.leafImpls.get(leaf!.id)!(undefined), 42);
  });

  it("ifElse emits a control op; fetchJson emits an io effect boundary", () => {
    const factory = pattern<{ flag: boolean; url: string }>((input) => ({
      picked: ifElse(input.flag, "yes", "no"),
      data: fetchJson({ url: input.url }),
    }));
    const rog = getBuiltRog(factory)!.rog;
    assertEquals(rog.incomplete, undefined);
    const control = rog.ops.find((o) => o.kind === "control");
    assertExists(control);
    const effect = rog.ops.find((o) => o.kind === "effect");
    assertExists(effect);
    assert(effect!.detail.kind === "effect");
    assertEquals(effect!.detail.sink, "io");
    assertEquals(effect!.detail.builtin, "fetchJson");
  });

  it("a str interpolation lowers to a native interpolate op (no leaf)", () => {
    const factory = pattern<{ name: string }>((input) => ({
      greeting: str`Hi ${input.name}`,
    }));
    const built = getBuiltRog(factory)!;
    assertEquals(built.rog.incomplete, undefined);
    assertEquals(
      built.rog.ops.filter((o) => o.kind === "interpolate").length,
      1,
    );
    assertEquals(built.rog.ops.filter((o) => o.kind === "leaf").length, 0);
  });

  it("a nested pattern call emits a pattern op with an inlined child ROG", () => {
    const inner = pattern<{ x: number }>((i) => ({
      d: lift((v: { x: number }) => v.x * 2)({ x: i.x }),
    }));
    const outer = pattern<{ y: number }>((i) => ({ out: inner({ x: i.y }) }));
    const built = getBuiltRog(outer)!;
    assertEquals(built.rog.incomplete, undefined);
    const pat = built.rog.ops.find((o) => o.kind === "pattern");
    assertExists(pat);
    assert(pat!.detail.kind === "pattern");
    // The child's BuiltRog is captured for recursion, and the child Rog inlined.
    assertEquals(built.children.size, 1);
    assertExists(pat!.detail.child, "child ROG inlined");
    assertEquals(
      pat!.detail.child!.ops.filter((o) => o.kind === "leaf").length,
      1,
    );
  });

  it("a map collection records a collection op with an element factory", () => {
    const Row = pattern<{ element: { n: number } }>(
      (input) => ({
        doubled: lift((v: { n: number }) => v.n * 2)({ n: input.element.n }),
      }),
      {
        type: "object",
        properties: {
          element: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        required: ["element"],
      },
    );
    const factory = pattern<{ items: { n: number }[] }>((input) => {
      const rows = (input.items as unknown as {
        mapWithPattern: (op: unknown, params: unknown) => unknown;
      }).mapWithPattern(Row as unknown, {}) as never;
      return { rows };
    });
    const built = getBuiltRog(factory)!;
    assertEquals(built.rog.incomplete, undefined);
    const coll = built.rog.ops.find((o) => o.kind === "collection");
    assertExists(coll);
    assert(coll!.detail.kind === "collection");
    assertEquals(coll!.detail.op, "map");
    // A live element factory is captured for W4 resolution.
    assertEquals(built.collectionElements.size, 1);
    assertExists(getBuiltRogResolved(built.collectionElements.get(coll!.id)));
  });

  it("census counts a complete build and records its op kinds", () => {
    resetRogConstructionCensus();
    const before = getRogConstructionCensus().patterns;
    const factory = pattern<{ a: number }>((input) => ({
      out: lift((v: { a: number }) => v.a + 1)({ a: input.a }),
    }));
    // Building the ROG happens at finalization; force a lookup to be sure.
    assertExists(getBuiltRog(factory));
    const c = getRogConstructionCensus();
    assert(c.patterns > before, "census patterns bumped");
    assert(c.complete >= 1, "at least one complete build");
    assert((c.opsByKind.leaf ?? 0) >= 1, JSON.stringify(c.opsByKind));
  });

  it("census records an incomplete build with a reason key", () => {
    resetRogConstructionCensus();
    const factory = pattern<{ n: number }>((input) => ({
      out: lift((v: unknown) => v)({ n: input.n, fn: () => 1 }),
    }));
    assertExists(getBuiltRog(factory));
    const c = getRogConstructionCensus();
    assert(c.incomplete >= 1, "an incomplete build was counted");
    assert(
      (c.incompleteReasons.function_in_input ?? 0) >= 1,
      JSON.stringify(c.incompleteReasons),
    );
  });
});
