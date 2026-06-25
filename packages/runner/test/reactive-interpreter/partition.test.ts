/**
 * Coalescing PARTITIONER tests (step 2 of the coalescing track).
 *
 * Covers `src/reactive-interpreter/partition.ts` — the §4.2 / §4.7 pure-region
 * partition (docs/specs/reactive-interpreter/07-coalescing-architecture.md).
 *
 * Two layers of coverage:
 *
 *  1. HAND-BUILT ROGs — small, exact graphs that pin every documented behavior:
 *     pure ops grouped into the right segments, boundaries cut, segment ordering
 *     (a segment feeding a boundary precedes it; a segment consuming a boundary's
 *     output follows it), connected-component segment granularity (choice (ii)),
 *     external input / materialized output ref sets, the R-SEAM-1 fan-out flag,
 *     §4.7 recursion, and fail-closed on an unplaceable op (a cycle / a dangling
 *     producer ref).
 *
 *  2. REAL-EXTRACTED CROSS-CHECK — compile the SAME corpus patterns the static
 *     probe (`packages/patterns/tools/coalescing-partition-probe.ts`) measures,
 *     run them through the production `extractRog` + this partitioner, and assert
 *     the partitioner AGREES with the probe. The BOUNDARY SET matches the probe
 *     EXACTLY (edge-independent — read off op kind). The probe counts segments
 *     under choice (i) (layer = one segment); this module uses choice (ii) (one
 *     segment per connected component within a layer), so the cross-check
 *     compares the partitioner's DISTINCT LAYER count to the probe's per-graph
 *     segment count (<= probe, within 1) and asserts segment count >= probe. The
 *     probe's raw `node.inputs` walk is defer-agnostic and recovers a few edges
 *     the production `inputsOf` graph's `defer` gate drops, so fan-out and the
 *     deepest layer can be slightly lower on the production graph (documented
 *     at the cross-check below).
 *
 * Run (the runner test task globs `test/*.test.ts`; this subdir test runs
 * explicitly):
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/partition.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  extractRog,
  resolveLeafImpls,
} from "../../src/reactive-interpreter/extract.ts";
import {
  type InnerRog,
  partition,
  type PartitionOk,
  type PartitionResult,
  type Segment,
} from "../../src/reactive-interpreter/partition.ts";
import type {
  Op,
  OpId,
  Rog,
  ValueRef,
} from "../../src/reactive-interpreter/rog.ts";

setGlobalLogFloor("error");

// Schema placeholder — the partitioner never inspects schemas.
const T = true as unknown as Rog["resultSchema"];

// ---------------------------------------------------------------------------
// Hand-built ROG helpers.
// ---------------------------------------------------------------------------

const leaf = (id: OpId, ...inputs: ValueRef[]): Op => ({
  id,
  kind: "leaf",
  inputs,
  outSchema: T,
  detail: { kind: "leaf" },
});

const effect = (id: OpId, ...inputs: ValueRef[]): Op => ({
  id,
  kind: "effect",
  inputs,
  outSchema: T,
  detail: { kind: "effect", sink: "handler" },
});

const constructObj = (
  id: OpId,
  fields: Record<string, ValueRef>,
): Op => ({
  id,
  kind: "construct",
  inputs: [],
  outSchema: T,
  detail: { kind: "construct", template: { shape: "object", fields } },
});

/** A `map` collection boundary reading `listInput` (its element ROG is opaque to
 * the top-level partition at LEVEL-1 — no `resolveInner`). */
const collectionMap = (id: OpId, listInput: ValueRef): Op => ({
  id,
  kind: "collection",
  inputs: [],
  outSchema: T,
  detail: {
    kind: "collection",
    op: "map",
    elementRog: { identity: "<inline>", symbol: "op" },
    listInput,
  },
});

const arg = (...path: string[]): ValueRef => ({ kind: "argument", path });
const opOut = (op: OpId, ...path: string[]): ValueRef => ({
  kind: "opOut",
  op,
  path,
});

/** Build a fresh PartitionInput over a ROG with no boundaries-by-leaf and a
 * given internal map (usually empty for opOut-only hand-built ROGs). */
function inputOf(
  ops: Op[],
  result: ValueRef,
  opts: {
    internalToOp?: Map<string, OpId>;
    unresolvedLeafOps?: Set<OpId>;
    resolveInner?: (op: Op) => InnerRog | undefined;
  } = {},
): Parameters<typeof partition>[0] {
  return {
    rog: { argumentSchema: T, resultSchema: T, result, ops },
    internalToOp: opts.internalToOp ?? new Map(),
    unresolvedLeafOps: opts.unresolvedLeafOps ?? new Set(),
    resolveInner: opts.resolveInner,
  };
}

function ok(r: PartitionResult): PartitionOk {
  if (!r.partitionable) {
    throw new Error(`expected partitionable, got: ${r.reason}`);
  }
  return r;
}

/** The segment containing a given op id. */
function segWith(p: PartitionOk, opId: OpId): Segment {
  const s = p.segments.find((seg) => seg.opIds.includes(opId));
  if (!s) throw new Error(`no segment contains op ${opId}`);
  return s;
}

const opOutsOf = (refs: ValueRef[]): OpId[] =>
  refs.filter((r): r is Extract<ValueRef, { kind: "opOut" }> =>
    r.kind === "opOut"
  ).map((r) => r.op).sort((a, b) => a - b);

// ===========================================================================
// 1. Hand-built behavior.
// ===========================================================================

describe("partition (hand-built): segments, cuts, ordering", () => {
  it("a fully-pure ROG is one segment, no boundaries", () => {
    // ({x,y}) => obj{ a: f(x), b: g(a) }
    const ops = [
      leaf(0, arg("x")), // a
      leaf(1, opOut(0)), // b = g(a)
      constructObj(2, { a: opOut(0), b: opOut(1) }),
    ];
    const p = ok(partition(inputOf(ops, opOut(2))));
    expect(p.boundaries.length).toBe(0);
    expect(p.segments.length).toBe(1);
    expect(p.segments[0].layer).toBe(0);
    expect(p.segments[0].opIds.sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(p.edges.length).toBe(0);
    expect(p.fanoutSegmentIds).toEqual([]);
  });

  it("cuts at a boundary; pure-before in seg0, pure-after in seg1", () => {
    // a = f(arg.x); out = fetch(a); b = g(out); result = b
    // seg0 = {a}; bnd = {fetch}; seg1 = {b}; layering a<fetch<b.
    const ops = [
      leaf(0, arg("x")), // a  (pure, seg0)
      effect(1, opOut(0)), // fetch(a) (boundary)
      leaf(2, opOut(1)), // b = g(fetch output) (pure, seg1)
    ];
    const p = ok(partition(inputOf(ops, opOut(2))));
    expect(p.boundaries.map((b) => b.opId)).toEqual([1]);
    expect(p.boundaries[0].kind).toBe("effect");
    // a in seg0; b in a later segment.
    const segA = segWith(p, 0);
    const segB = segWith(p, 2);
    expect(segA.layer).toBe(0);
    expect(segB.layer).toBeGreaterThan(segA.layer);
    // The boundary reads a (its input ref points at op 0).
    expect(opOutsOf(p.boundaries[0].inputs)).toEqual([0]);
    // Edges: seg0 -> bnd1 (feeds its input); bnd1 -> seg1 (output consumed).
    const kinds = p.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(["bnd->seg", "seg->bnd"]);
    const feed = p.edges.find((e) => e.kind === "seg->bnd")!;
    const consume = p.edges.find((e) => e.kind === "bnd->seg")!;
    expect(feed.from).toBe(segA.id);
    expect(feed.to).toBe("bnd1");
    expect(consume.from).toBe("bnd1");
    expect(consume.to).toBe(segB.id);
  });

  it("a segment feeding a boundary precedes it (ordering invariant)", () => {
    // producer segment layer < boundary's placement; consumer segment layer >.
    const ops = [
      leaf(0, arg("x")),
      effect(1, opOut(0)),
      leaf(2, opOut(1)),
      effect(3, opOut(2)),
      leaf(4, opOut(3)),
    ];
    const p = ok(partition(inputOf(ops, opOut(4))));
    // Three pure ops in strictly increasing layers across two boundaries.
    const l0 = segWith(p, 0).layer;
    const l2 = segWith(p, 2).layer;
    const l4 = segWith(p, 4).layer;
    expect(l0).toBeLessThan(l2);
    expect(l2).toBeLessThan(l4);
    expect(p.boundaries.map((b) => b.opId).sort((a, b) => a - b)).toEqual([
      1,
      3,
    ]);
  });

  it("disconnected pure regions in one layer are SEPARATE segments (ii)", () => {
    // Two independent pure ops both at seg0, each feeding a different boundary.
    // Choice (ii): they are TWO segments (different connected components),
    // not one. (Choice (i) would coalesce the whole layer into one node.)
    const ops = [
      leaf(0, arg("x")), // region A
      leaf(1, arg("y")), // region B (no edge to A)
      effect(2, opOut(0)), // boundary A reads region A
      effect(3, opOut(1)), // boundary B reads region B
    ];
    const p = ok(partition(inputOf(ops, opOut(2))));
    const segA = segWith(p, 0);
    const segB = segWith(p, 1);
    expect(segA.id).not.toBe(segB.id);
    expect(segA.layer).toBe(0);
    expect(segB.layer).toBe(0);
    expect(p.segments.length).toBe(2);
    // No fan-out: each segment feeds exactly one boundary.
    expect(p.fanoutSegmentIds).toEqual([]);
  });

  it("connected pure ops in one layer COALESCE into one segment", () => {
    // a -> b -> c all pure, all seg0: one connected component => one segment.
    const ops = [
      leaf(0, arg("x")),
      leaf(1, opOut(0)),
      leaf(2, opOut(1)),
      effect(3, opOut(2)),
    ];
    const p = ok(partition(inputOf(ops, opOut(3))));
    const segIds = new Set(p.segments.map((s) => s.id));
    expect(segIds.size).toBe(1);
    expect([...p.segments[0].opIds].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("segment inputs = external reads; outputs = refs consumed downstream", () => {
    // a = f(arg.x); b = g(a, arg.y); fetch(b). seg0={a,b} (connected via a->b).
    // External inputs of seg0: arg.x, arg.y. Output: b (read by the boundary).
    const ops = [
      leaf(0, arg("x")), // a
      leaf(1, opOut(0), arg("y")), // b = g(a, y)
      effect(2, opOut(1)), // fetch(b)
    ];
    const p = ok(partition(inputOf(ops, opOut(2))));
    const seg = segWith(p, 0);
    expect(seg.opIds.sort((a, b) => a - b)).toEqual([0, 1]);
    // Inputs: the two argument refs (a is intra-segment, not external).
    const argPaths = seg.inputs
      .filter((r) => r.kind === "argument")
      .map((r) => (r as Extract<ValueRef, { kind: "argument" }>).path.join("."))
      .sort();
    expect(argPaths).toEqual(["x", "y"]);
    expect(seg.inputs.some((r) => r.kind === "opOut")).toBe(false);
    // Output: op 1 (b) — the boundary reads it; op 0 (a) is internal-only.
    expect(opOutsOf(seg.outputs)).toEqual([1]);
  });

  it("a segment producing the pattern RESULT materializes it as an output", () => {
    // a = f(arg.x); result = a. No boundary; a is the egress root => output.
    const ops = [leaf(0, arg("x"))];
    const p = ok(partition(inputOf(ops, opOut(0))));
    expect(p.boundaries.length).toBe(0);
    expect(p.segments.length).toBe(1);
    expect(opOutsOf(p.segments[0].outputs)).toEqual([0]);
  });

  it("R-SEAM-1 fan-out: one segment feeding >1 boundary is flagged", () => {
    // a feeds BOTH fetch1 and fetch2 -> segA is a fan-out segment.
    const ops = [
      leaf(0, arg("x")), // a
      effect(1, opOut(0)), // fetch1(a)
      effect(2, opOut(0)), // fetch2(a)
    ];
    const p = ok(partition(inputOf(ops, opOut(1))));
    const segA = segWith(p, 0);
    expect(p.fanoutSegmentIds).toEqual([segA.id]);
    // Two seg->bnd edges from the one segment.
    const seamEdges = p.edges.filter((e) =>
      e.kind === "seg->bnd" && e.from === segA.id
    );
    expect(seamEdges.map((e) => e.to).sort()).toEqual(["bnd1", "bnd2"]);
  });

  it("boundary->boundary hop is recorded as a bnd->bnd edge (§4.5 read-through)", () => {
    // fetch1 -> fetch2 with NO pure op reading fetch1's output: the effect->effect
    // hop the §4.5 hazard flags. The partition must SEE this edge (so step 3 can
    // wire a labeled read-through), not drop it.
    const ops = [
      effect(0, arg("x")), // fetch1
      effect(1, opOut(0)), // fetch2(fetch1)
    ];
    const p = ok(partition(inputOf(ops, opOut(1))));
    expect(p.segments.length).toBe(0); // no pure ops
    const bb = p.edges.filter((e) => e.kind === "bnd->bnd");
    expect(bb.length).toBe(1);
    expect(bb[0].from).toBe("bnd0");
    expect(bb[0].to).toBe("bnd1");
  });

  it("an unresolved leaf is a fail-closed boundary", () => {
    const ops = [
      leaf(0, arg("x")), // resolvable
      leaf(1, opOut(0)), // UNRESOLVED -> boundary
      leaf(2, opOut(1)), // depends on the boundary output -> later segment
    ];
    const p = ok(
      partition(inputOf(ops, opOut(2), { unresolvedLeafOps: new Set([1]) })),
    );
    expect(p.boundaries.map((b) => b.opId)).toEqual([1]);
    expect(p.boundaries[0].kind).toBe("unresolved-leaf");
    expect(segWith(p, 2).layer).toBeGreaterThan(segWith(p, 0).layer);
  });

  it("a `collection` (map) boundary cuts seg->bnd and bnd->seg around itself (INC3 LEVEL-1)", () => {
    // ({items}) => { const list = sanitize(items);     // seg0 feeds the map
    //                const mapped = list.map(...);      // collection BOUNDARY
    //                const label  = summarize(mapped);  // seg1 reads the map out
    //                return { mapped, label } }
    // A pure region BEFORE the map (the list sanitizer) and a pure region AFTER
    // the map (a summary over the mapped container) must each interpret as their
    // own segment, with the map kept as a verbatim `collection` boundary between
    // them — the exact LEVEL-1 shape this increment engages. The map output is a
    // NORMAL dataflow output, so the downstream read is a sound `bnd->seg` edge.
    const ops = [
      leaf(0, arg("items")), // sanitize(items) -> the list the map consumes
      collectionMap(1, opOut(0)), // map over the sanitized list (boundary)
      leaf(2, opOut(1)), // summarize(mapped) -> reads the map output
      constructObj(3, { mapped: opOut(1), label: opOut(2) }),
    ];
    const p = ok(partition(inputOf(ops, opOut(3))));

    // Exactly one collection boundary, kept verbatim (no inner — LEVEL-1).
    expect(p.boundaries.map((b) => b.kind)).toEqual(["collection"]);
    expect(p.boundaries[0].opId).toBe(1);
    expect(p.boundaries[0].inner).toBeUndefined();

    // The boundary reads op 0's output as its list input.
    expect(opOutsOf(p.boundaries[0].inputs)).toEqual([0]);

    // seg->bnd: the sanitizer segment (op 0) feeds the map boundary.
    expect(
      p.edges.some((e) =>
        e.kind === "seg->bnd" && e.from === segWith(p, 0).id && e.to === "bnd1"
      ),
    ).toBe(true);
    // bnd->seg: the summary/result segment (ops 2,3) reads the map output.
    expect(
      p.edges.some((e) =>
        e.kind === "bnd->seg" && e.from === "bnd1" &&
        e.to === segWith(p, 2).id
      ),
    ).toBe(true);
    // No bnd->bnd (the §4.5 read-through hazard) and no fan-out.
    expect(p.edges.some((e) => e.kind === "bnd->bnd")).toBe(false);
    expect(p.fanoutSegmentIds).toEqual([]);

    // The consumer segment is placed strictly after the producer segment.
    expect(segWith(p, 2).layer).toBeGreaterThan(segWith(p, 0).layer);
  });

  it("resolves `internal` refs through internalToOp for the data-flow DAG", () => {
    // op 0 produces internal cell "$c"; op 1 reads it via an `internal` ref.
    const internalToOp = new Map<string, OpId>([["$c", 0]]);
    const ops = [
      leaf(0, arg("x")), // produces $c (wired via internalToOp)
      leaf(1, { kind: "internal", name: "$c", path: [] }),
      effect(2, opOut(1)),
    ];
    const p = ok(partition(inputOf(ops, opOut(2), { internalToOp })));
    // 0 and 1 are connected (1 reads 0 via internal) => one segment.
    expect(segWith(p, 0).id).toBe(segWith(p, 1).id);
  });

  it("an `internal` ref to a cell NO op produces is treated as external (seg0)", () => {
    // A parent/external cell read: no producer edge, available at seg0.
    const ops = [
      leaf(0, { kind: "internal", name: "$external", path: [] }),
    ];
    const p = ok(partition(inputOf(ops, opOut(0)))); // empty internalToOp
    expect(p.partitionable).toBe(true);
    expect(p.segments[0].layer).toBe(0);
    // The external internal ref is recorded as a segment input.
    expect(
      p.segments[0].inputs.some((r) => r.kind === "internal"),
    ).toBe(true);
  });
});

describe("partition (hand-built): fail-closed (OQ-C1)", () => {
  it("returns not-partitionable on a dangling opOut producer ref", () => {
    // op 0 reads opOut(99) — no op 99 exists. FAIL CLOSED.
    const ops = [leaf(0, opOut(99))];
    const r = partition(inputOf(ops, opOut(0)));
    expect(r.partitionable).toBe(false);
    if (!r.partitionable) expect(r.reason).toContain("no op");
  });

  it("returns not-partitionable on a 2-cycle (unschedulable)", () => {
    // op0 reads op1 and op1 reads op0 — a cycle the layering can't resolve.
    const ops = [leaf(0, opOut(1)), leaf(1, opOut(0))];
    const r = partition(inputOf(ops, opOut(0)));
    expect(r.partitionable).toBe(false);
    if (!r.partitionable) expect(r.reason).toContain("could not be placed");
  });

  it("a failed INNER partition poisons the parent (fail-closed recursion)", () => {
    // The boundary's inner ROG has a cycle => the whole pattern falls back.
    const innerOps = [leaf(0, opOut(1)), leaf(1, opOut(0))];
    const innerRog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: opOut(0),
      ops: innerOps,
    };
    const ops = [
      // A collection boundary whose element ROG is the cyclic inner.
      {
        id: 0,
        kind: "collection" as const,
        inputs: [],
        outSchema: T,
        detail: {
          kind: "collection" as const,
          op: "map" as const,
          elementRog: { identity: "<inline>", symbol: "op" },
          listInput: arg("items"),
        },
      },
    ];
    const r = partition(inputOf(ops, opOut(0), {
      resolveInner: (op) =>
        op.id === 0
          ? {
            rog: innerRog,
            internalToOp: new Map(),
            unresolvedLeafOps: new Set(),
          }
          : undefined,
    }));
    expect(r.partitionable).toBe(false);
    if (!r.partitionable) expect(r.reason).toContain("inner partition");
  });
});

describe("partition (hand-built): §4.7 recursion", () => {
  it("recurses into a map element and attaches the inner PartitionResult", () => {
    // Top-level: a map collection boundary over arg.items, with a pure element
    // ROG (e = elemFn(arg)). The element partitions to one pure segment.
    const elementRog: Rog = {
      argumentSchema: T,
      resultSchema: T,
      result: opOut(0),
      ops: [leaf(0, arg())],
    };
    const ops = [
      {
        id: 0,
        kind: "collection" as const,
        inputs: [],
        outSchema: T,
        detail: {
          kind: "collection" as const,
          op: "map" as const,
          elementRog: { identity: "<inline>", symbol: "op" },
          listInput: arg("items"),
        },
      },
    ];
    const p = ok(partition(inputOf(ops, opOut(0), {
      resolveInner: (op) =>
        op.id === 0
          ? {
            rog: elementRog,
            internalToOp: new Map(),
            unresolvedLeafOps: new Set(),
          }
          : undefined,
    })));
    expect(p.boundaries.length).toBe(1);
    expect(p.boundaries[0].kind).toBe("collection");
    const inner = p.boundaries[0].inner;
    expect(inner).toBeDefined();
    const innerOk = ok(inner!);
    expect(innerOk.boundaries.length).toBe(0);
    expect(innerOk.segments.length).toBe(1);
    expect(innerOk.segments[0].opIds).toEqual([0]);
  });
});

// ===========================================================================
// 2. Real-extracted cross-check against the static probe.
// ===========================================================================
//
// The probe (coalescing-partition-probe.ts) models boundary-input edges by
// walking raw `node.inputs` and is intentionally DEFER-AGNOSTIC: it adds a
// producer edge whenever an alias names a cell produced in this graph, ignoring
// the `defer` nesting level. This partitioner reads the F1 edges off `inputsOf`
// on the PRODUCTION graph, which is subject to `extract.ts`'s `defer` fail-closed
// gate (an alias whose `defer` level doesn't match the frame is dropped as
// unrecognized — documented in extract.ts::aliasToValueRef and the probe header).
//
// Consequence (an HONEST, documented difference, not a bug): the production
// `inputsOf` edge set is a SUBSET of the probe's raw-walk edge set. Fewer edges
// can only:
//   - place a pure op in an EARLIER layer (so the distinct-layer count is <= the
//     probe's choice-(i) segment count — observed exact on 4/6 corpus patterns,
//     one lower on lunch-poll and cfc-row-label-mailbox), and
//   - reduce FAN-OUT (a segment feeds a boundary only via a present edge, so the
//     production fan-out is <= the probe's).
// The truly edge-INDEPENDENT invariant — the BOUNDARY SET (effect / collection /
// pattern / unresolved-leaf classification) — matches the probe EXACTLY, because
// it is read off the op KIND, not the edges. The cross-check asserts that
// exactly, and the edge-dependent metrics within their documented direction.

interface ProbeRow {
  /** Top-level segment count under the probe's choice (i) (= distinct layers). */
  segs: number;
  /** Top-level boundary op count (edge-independent — exact match expected). */
  boundaries: number;
  /** Top-level fan-out segment count. */
  fanout: number;
}

// Captured from `deno run -A tools/coalescing-partition-probe.ts` (the
// RECURSION BREAKDOWN top-level rows), 2026-06-24, boundary-edges-modeled.
const PROBE_TOPLEVEL: Record<string, ProbeRow> = {
  "lunch-poll": { segs: 5, boundaries: 30, fanout: 2 },
  "notes-list-bench": { segs: 2, boundaries: 2, fanout: 0 },
  "github-activity": { segs: 3, boundaries: 2, fanout: 0 },
  "cfc-row-label-mailbox": { segs: 4, boundaries: 8, fanout: 1 },
  "fair-share": { segs: 2, boundaries: 8, fanout: 0 },
  "profile-group-chat": { segs: 2, boundaries: 6, fanout: 0 },
};

// PollOptionCard (lunch-poll's trapped option card): the marquee case. The probe
// reports it (lunch-poll.map#21.elem.pattern#1) at 180 ops / 14 boundaries.
const POLL_OPTION_CARD = { ops: 180, boundaries: 14 };

const PATTERNS_ROOT = new URL("../../../patterns", import.meta.url).pathname
  .replace(/\/$/, "");

/** A frame-recursive resolver: bound to one raw Pattern frame; the InnerRog it
 * returns carries a resolver bound to the INNER body frame (§4.7 is multi-level).
 * Mirrors the probe's `partitionPattern` recursion exactly. */
// deno-lint-ignore no-explicit-any
function resolverFor(pattern: any): (op: Op) => InnerRog | undefined {
  return (op: Op) => {
    if (op.id < 0) return undefined;
    const node = (pattern.nodes ?? [])[op.id];
    if (!node) return undefined;
    // deno-lint-ignore no-explicit-any
    let body: any;
    if (op.detail.kind === "collection") {
      body = (node.inputs as { op?: unknown } | undefined)?.op;
    } else if (op.detail.kind === "pattern") {
      body = (node.module as { implementation?: unknown } | undefined)
        ?.implementation;
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.nodes)) {
      return undefined;
    }
    const ex = extractRog(body);
    let unresolved = new Set<OpId>();
    try {
      unresolved = new Set(resolveLeafImpls(body, ex.rog).unresolvedLeafOps);
    } catch {
      // resolution failure is its own boundary; leave the set empty.
    }
    return {
      rog: ex.rog,
      internalToOp: ex.internalToOp,
      unresolvedLeafOps: unresolved,
      resolveInner: resolverFor(body),
    };
  };
}

// deno-lint-ignore no-explicit-any
async function partitionCorpus(dir: string): Promise<{
  result: PartitionResult;
  // deno-lint-ignore no-explicit-any
  pattern: any;
  dispose: () => Promise<void>;
}> {
  const signer = await Identity.fromPassphrase("ri-partition-crosscheck");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(
      `${PATTERNS_ROOT}/${dir}/main.tsx`,
      PATTERNS_ROOT,
    ),
  );
  const pattern = await runtime.patternManager.compilePattern(program);
  const ex = extractRog(pattern);
  let unresolved = new Set<OpId>();
  try {
    unresolved = new Set(resolveLeafImpls(pattern, ex.rog).unresolvedLeafOps);
  } catch { /* leave empty */ }
  const result = partition({
    rog: ex.rog,
    internalToOp: ex.internalToOp,
    unresolvedLeafOps: unresolved,
    resolveInner: resolverFor(pattern),
  });
  return {
    result,
    pattern,
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

const distinctLayers = (p: PartitionOk): number =>
  new Set(p.segments.map((s) => s.layer)).size;

/** Find a boundary's inner partition by op kind + op id anywhere in the tree. */
function findInner(
  p: PartitionOk,
  predicate: (ops: number, bnds: number) => boolean,
): PartitionOk | undefined {
  const visit = (node: PartitionOk): PartitionOk | undefined => {
    for (const b of node.boundaries) {
      if (!b.inner || !b.inner.partitionable) continue;
      const inner = b.inner;
      const opCount = inner.segments.reduce((n, s) => n + s.opIds.length, 0) +
        inner.boundaries.length;
      if (predicate(opCount, inner.boundaries.length)) return inner;
      const deeper = visit(inner);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return visit(p);
}

describe("partition: real-extracted cross-check vs the static probe", () => {
  for (const [dir, probe] of Object.entries(PROBE_TOPLEVEL)) {
    it(`${dir}: boundary set matches probe exactly; layers/fan-out within tolerance`, async () => {
      const { result, dispose } = await partitionCorpus(dir);
      try {
        const p = ok(result);
        // Edge-INDEPENDENT invariant: the BOUNDARY SET matches the probe EXACTLY
        // (read off op KIND, not edges).
        expect(p.boundaries.length).toBe(probe.boundaries);
        // Edge-DEPENDENT, documented direction: the production `inputsOf` edge
        // set is a subset of the probe's defer-agnostic raw walk, so fan-out can
        // only be <= the probe's, and the layer count <= the probe's choice-(i)
        // segment count (a missing edge places a pure op no later, never later).
        expect(p.fanoutSegmentIds.length).toBeLessThanOrEqual(probe.fanout);
        const layers = distinctLayers(p);
        expect(layers).toBeLessThanOrEqual(probe.segs);
        // ...and within 1 layer of it (the edge gap is small in practice).
        expect(probe.segs - layers).toBeLessThanOrEqual(1);
        // Choice (ii) is FINER than choice (i): segment count >= probe segs.
        expect(p.segments.length).toBeGreaterThanOrEqual(probe.segs);
        // Every segment id is unique and every boundary id is unique.
        expect(new Set(p.segments.map((s) => s.id)).size).toBe(
          p.segments.length,
        );
        expect(new Set(p.boundaries.map((b) => b.id)).size).toBe(
          p.boundaries.length,
        );
      } finally {
        await dispose();
      }
    });
  }

  it("lunch-poll recurses into PollOptionCard (180 ops / 14 boundaries)", async () => {
    const { result, dispose } = await partitionCorpus("lunch-poll");
    try {
      const p = ok(result);
      const poc = findInner(
        p,
        (ops, bnds) =>
          ops === POLL_OPTION_CARD.ops && bnds === POLL_OPTION_CARD.boundaries,
      );
      expect(poc).toBeDefined();
      // The trapped case: 14 boundaries preserved, 166 pure ops coalesced into a
      // small number of segments (the un-trapping the design delivers).
      expect(poc!.boundaries.length).toBe(14);
      const pureOps = poc!.segments.reduce((n, s) => n + s.opIds.length, 0);
      expect(pureOps).toBe(POLL_OPTION_CARD.ops - POLL_OPTION_CARD.boundaries);
      // Far fewer segments than pure ops (coalescing happened).
      expect(poc!.segments.length).toBeLessThan(pureOps);
    } finally {
      await dispose();
    }
  });
});
