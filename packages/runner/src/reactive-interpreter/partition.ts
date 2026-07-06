/**
 * Coalescing PARTITIONER v2 — the pure-region partition (v1 07 §4.2/§4.7),
 * ported from PR #4298's partition.ts and adapted to IR v2 + the builder-born
 * side-car (BuiltRog):
 *
 * - `internal` refs resolve producers via the Rog's own internals table
 *   (`producedBy`) — a missing producer is now a PRINCIPLED "externally
 *   written cell" (handler state / defaults), not v1's ambiguous fail-open.
 * - Inner recursion is STRUCTURAL: collection elements and nested-pattern
 *   children are inline Rogs (+ recursive BuiltRogs) — no injected resolver.
 * - A nested `pattern` op whose child is COMPLETE and recursively pure is NOT
 *   a boundary: it lives inside a segment (evalRog inlines it — the v1 W5a
 *   win, by construction).
 * - Result-self-references fail closed (dispatch support pending).
 *
 * F4 (boundary write-back cut edges) is DELIBERATELY deferred: v1 shipped
 * green without them; naive edges cycle through handler-binding constructs
 * (a handler's input construct references the very cell the handler writes);
 * and the hazard is re-run churn / conflict surface, not value correctness
 * under pull scheduling. The IR carries `effect.writeTargets`, so adding the
 * edges (excluding each boundary's own binding constructs) is a cheap,
 * measurement-driven follow-up. See DECISIONS D-V2-F4-DEFER.
 *
 * FAIL-CLOSED (OQ-C1): any op the partitioner cannot soundly place — a cycle,
 * an opOut ref naming a missing op, an incomplete child — returns
 * `{ partitionable: false, reason }`; the dispatch legacy-instantiates the
 * whole pattern. The partitioner NEVER silently misplaces an op.
 */

import {
  type ConstructTemplate,
  inputsOf,
  type Op,
  type OpId,
  type ValueRef,
} from "./rog.ts";
import { type BuiltRog, getBuiltRogResolved } from "./from-builder.ts";

// ---------------------------------------------------------------------------
// Output contract (consumed by the dispatch — kept from v1, proven shape).
// ---------------------------------------------------------------------------

/** A maximal pure region within one layer — one interpreter segment node. */
export interface Segment {
  /** Stable segment id: `seg${layer}_${componentIndexWithinLayer}`. */
  id: string;
  /** 0-based layer — depth past the boundaries it transitively depends on. */
  layer: number;
  /** Op ids coalesced into this segment (pure ops only), in `rog.ops` order. */
  opIds: OpId[];
  /** ValueRefs read from OUTSIDE the segment (args/consts, boundary outputs,
   * earlier-segment outputs, externally-written internals). The exact
   * read-set. Deduplicated structurally. */
  inputs: ValueRef[];
  /** ValueRefs this segment must MATERIALIZE (read by a downstream boundary,
   * a later segment, or the pattern result). Deduplicated by op id. */
  outputs: ValueRef[];
}

/** A boundary op kept as a legacy-instantiated scheduler node. */
export interface Boundary {
  /** Stable boundary id: `bnd${opId}`. */
  id: string;
  opId: OpId;
  kind:
    | "effect"
    | "collection"
    | "pattern"
    | "control"
    | "unresolved-leaf"
    | "gated-leaf";
  /** The boundary's READ inputs (its `boundary←producer` edges). */
  inputs: ValueRef[];
  /** For a collection/pattern boundary with an inlinable body, the
   * recursively-computed sub-partition. */
  inner?: PartitionResult;
}

/** A producer→consumer edge in the coarsened DAG (`Segment.id`/`Boundary.id`).
 * `bnd->bnd` is the effect→effect hop — the labeled read-through obligation
 * (v1 07 §4.5). `seg->seg` occurs only across layers. */
export interface PartitionEdge {
  from: string;
  to: string;
  kind: "seg->bnd" | "bnd->seg" | "bnd->bnd" | "seg->seg";
}

export interface PartitionOk {
  partitionable: true;
  segments: Segment[];
  boundaries: Boundary[];
  edges: PartitionEdge[];
  /** Segments whose outputs feed >1 boundary (R-SEAM-1/F2 fan-out exposure —
   * the dispatch uses the container-of-links convention). */
  fanoutSegmentIds: string[];
}

export interface PartitionFail {
  partitionable: false;
  reason: string;
}

export type PartitionResult = PartitionOk | PartitionFail;

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

const PURE_KINDS: ReadonlySet<Op["kind"]> = new Set([
  "leaf",
  "access",
  "construct",
  "control",
  "interpolate",
  "expr",
  "call",
]);

/** Is this nested-pattern op fully pure and inlinable (child complete, all
 * leaves resolved, recursively pure)? Then it is NOT a boundary — evalRog
 * evaluates it inside a segment. */
function isPureInlinablePattern(built: BuiltRog, opId: OpId): boolean {
  const child = built.children.get(opId);
  if (!child || child.rog.incomplete?.length) return false;
  return rogIsFullyPure(child);
}

function rogIsFullyPure(built: BuiltRog): boolean {
  for (const op of built.rog.ops) {
    if (op.kind === "pattern") {
      if (!isPureInlinablePattern(built, op.id)) return false;
      continue;
    }
    if (!PURE_KINDS.has(op.kind)) return false;
    if (op.kind === "leaf" && !built.leafImpls.has(op.id)) return false;
  }
  return true;
}

function boundaryKindOf(
  built: BuiltRog,
  op: Op,
  inlinePurePatterns: boolean,
  boundaryLeafOps: ReadonlySet<OpId> | undefined,
  controlAsBoundary: boolean,
  inlinablePatternOps: ReadonlySet<OpId> | undefined,
  inlinableCollectionOps: ReadonlySet<OpId> | undefined,
): Boundary["kind"] | null {
  if (op.kind === "effect") return "effect";
  if (op.kind === "collection") {
    // TRANSIENT collections (D-V2-TRANSIENT-COLLECTIONS): the dispatch
    // proved the output value-consumed and the element fully inlinable —
    // segment-resident, zero docs.
    return inlinableCollectionOps?.has(op.id) ? null : "collection";
  }
  if (op.kind === "pattern") {
    if (inlinablePatternOps?.has(op.id)) return null;
    return inlinePurePatterns && isPureInlinablePattern(built, op.id)
      ? null
      : "pattern";
  }
  if (op.kind === "control" && controlAsBoundary) return "control";
  if (op.kind === "leaf") {
    if (!built.leafImpls.has(op.id)) return "unresolved-leaf";
    if (boundaryLeafOps?.has(op.id)) return "gated-leaf";
  }
  return null;
}

/** An op's FULL data-flow dependency refs: `inputsOf` plus construct template
 * refs (which `inputsOf` intentionally omits). */
function dependencyRefs(op: Op): ValueRef[] {
  const refs = [...inputsOf(op)];
  if (op.detail.kind === "construct") {
    const t: ConstructTemplate = op.detail.template;
    if (t.shape === "object") refs.push(...Object.values(t.fields));
    else refs.push(...t.items);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// The partition.
// ---------------------------------------------------------------------------

export interface PartitionInput {
  built: BuiltRog;
  /** Treat a COMPLETE, recursively-pure nested `pattern` op as a pure op
   * evalRog inlines (D-V2-PURE-PATTERN-INLINE). Default FALSE: a child
   * pattern's result cell can itself be the observable (a handler-built
   * child pushed into a list must be a real, addressable PIECE — the
   * launched-child contract), and the dispatch cannot yet distinguish
   * consumed-as-value children from retained-as-piece ones. Inlining
   * returns with that analysis. */
  inlinePurePatterns?: boolean;
  /** Leaf op ids the DISPATCH demoted to boundaries (untrusted impls,
   * capability-bearing bodies): kept as verbatim legacy javascript nodes,
   * with the pure region coalescing around them. */
  boundaryLeafOps?: ReadonlySet<OpId>;
  /** Treat control ops (ifElse/when/unless nodes) as boundaries — the
   * legacy builtins write branch LINKS (reference semantics) the evaluator
   * does not reproduce; preserving the original node is exactly faithful
   * (D-V2-CONTROL-MODERNIZE: no builtin-fidelity chase). Default TRUE until
   * native control emission writes links. */
  controlAsBoundary?: boolean;
  /** SPECIFIC nested-pattern ops the dispatch proved CONSUMED-AS-VALUE
   * (every reference is a value read by a pure op — never retained in the
   * result tree or by an effect) with a fully-inlinable child: these are
   * PURE (evalRog inlines the child; zero child docs). Supersedes the
   * all-or-nothing `inlinePurePatterns` for per-op precision. */
  inlinablePatternOps?: ReadonlySet<OpId>;
  /** SPECIFIC collection ops the dispatch proved TRANSIENT (value-consumed
   * output + fully-inlinable element): segment-resident in-memory
   * evaluation, zero docs (D-V2-TRANSIENT-COLLECTIONS). */
  inlinableCollectionOps?: ReadonlySet<OpId>;
}

/**
 * Partition one builder-born ROG into pure segments + boundary nodes + the
 * coarsened DAG. Pure function — no side effects.
 *
 * Algorithm (v1, unchanged in structure):
 *  1. producer edges from dependencyRefs (`opOut` → op; `internal` →
 *     internals[cell].producedBy, absent ⇒ external input; `argument`/`const`
 *     ⇒ none; `result` ⇒ fail closed).
 *  2. boundaries per `boundaryKindOf`.
 *  3. layer to a fixpoint: placed = max(avail of producers); a boundary's
 *     output is available one layer later; pure output in its own layer.
 *  4. segment = maximal connected component of pure ops within a layer
 *     (union-find over same-layer pure↔pure edges) — choice (ii), tighter
 *     read/write sets (OQ-C4).
 *  5. edges + exact per-segment external inputs / materialized outputs.
 *  6. recurse structurally into collection elements / non-pure pattern
 *     children; attach `inner`. Fail-closed propagates.
 */
export function partition(input: PartitionInput): PartitionResult {
  const built = input.built;
  const inlinePurePatterns = input.inlinePurePatterns ?? false;
  const controlAsBoundary = input.controlAsBoundary ?? true;
  const rog = built.rog;
  const ops = rog.ops;
  const n = ops.length;

  if (rog.incomplete?.length) {
    return {
      partitionable: false,
      reason: `rog incomplete: ${rog.incomplete.join(", ")}`,
    };
  }

  const idToIdx = new Map<OpId, number>();
  for (let i = 0; i < n; i++) idToIdx.set(ops[i].id, i);

  const isBoundary = new Array<boolean>(n).fill(false);
  const boundaryKind = new Array<Boundary["kind"] | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const k = boundaryKindOf(
      built,
      ops[i],
      inlinePurePatterns,
      input.boundaryLeafOps,
      controlAsBoundary,
      input.inlinablePatternOps,
      input.inlinableCollectionOps,
    );
    if (k !== null) {
      isBoundary[i] = true;
      boundaryKind[i] = k;
    }
  }

  // Resolve a ValueRef to the producing op's array index:
  //   null      → no producer (argument/const/externally-written internal).
  //   undefined → structural failure (missing op / result-self-ref) — fail
  //               closed at the call site.
  let failReason: string | undefined;
  const refProducerIdx = (ref: ValueRef): number | null | undefined => {
    if (ref.kind === "opOut") {
      const idx = idToIdx.get(ref.op);
      if (idx === undefined) failReason = `opOut names missing op ${ref.op}`;
      return idx;
    }
    if (ref.kind === "internal") {
      const producer = rog.internals[ref.cell]?.producedBy;
      if (producer === undefined) return null; // externally-written cell
      const idx = idToIdx.get(producer);
      if (idx === undefined) {
        failReason = `internal ${ref.cell} producedBy missing op ${producer}`;
      }
      return idx;
    }
    if (ref.kind === "result") {
      failReason = "result-self-reference (dispatch support pending)";
      return undefined;
    }
    return null; // argument | const
  };

  const producers: Set<number>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const set = new Set<number>();
    for (const ref of dependencyRefs(ops[i])) {
      const p = refProducerIdx(ref);
      if (p === undefined) {
        return {
          partitionable: false,
          reason: `op #${ops[i].id} (${ops[i].kind}): ${
            failReason ?? "unresolvable ref"
          }`,
        };
      }
      if (p !== null && p !== i) set.add(p);
    }
    producers[i] = set;
  }

  // --- layer to a fixpoint ---------------------------------------------------
  const avail = new Array<number>(n).fill(-1);
  const placed = new Array<number>(n).fill(-1);
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= n + 2) {
    changed = false;
    for (let i = 0; i < n; i++) {
      let layer = 0;
      let ready = true;
      for (const p of producers[i]) {
        if (avail[p] < 0) {
          ready = false;
          break;
        }
        if (avail[p] > layer) layer = avail[p];
      }
      if (!ready) continue;
      if (placed[i] !== layer) {
        placed[i] = layer;
        avail[i] = isBoundary[i] ? layer + 1 : layer;
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (placed[i] < 0) {
      return {
        partitionable: false,
        reason: `op #${ops[i].id} (${
          ops[i].kind
        }) could not be placed (cycle or unresolved dependency)`,
      };
    }
  }

  // --- segments = connected components within a layer -------------------------
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra < rb ? ra : rb] = ra < rb ? rb : ra;
  };
  for (let i = 0; i < n; i++) {
    if (isBoundary[i]) continue;
    for (const p of producers[i]) {
      if (isBoundary[p]) continue;
      if (placed[p] === placed[i]) union(i, p);
    }
  }

  const compToSeg = new Map<number, Segment>();
  const segOfOpIdx = new Array<string | null>(n).fill(null);
  const layerCompCount = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (isBoundary[i]) continue;
    const root = find(i);
    let seg = compToSeg.get(root);
    if (!seg) {
      const layer = placed[i];
      const c = layerCompCount.get(layer) ?? 0;
      layerCompCount.set(layer, c + 1);
      seg = {
        id: `seg${layer}_${c}`,
        layer,
        opIds: [],
        inputs: [],
        outputs: [],
      };
      compToSeg.set(root, seg);
    }
    seg.opIds.push(ops[i].id);
    segOfOpIdx[i] = seg.id;
  }

  const boundaryIdOf = (opIdx: number): string => `bnd${ops[opIdx].id}`;
  const ownerNodeId = (opIdx: number): string =>
    isBoundary[opIdx] ? boundaryIdOf(opIdx) : (segOfOpIdx[opIdx] as string);

  // --- boundaries, edges, segment inputs/outputs ------------------------------
  const boundaries: Boundary[] = [];
  for (let i = 0; i < n; i++) {
    if (!isBoundary[i]) continue;
    boundaries.push({
      id: boundaryIdOf(i),
      opId: ops[i].id,
      kind: boundaryKind[i]!,
      inputs: [...inputsOf(ops[i])],
    });
  }

  const edgeKey = new Set<string>();
  const edges: PartitionEdge[] = [];
  const addEdge = (from: string, to: string, kind: PartitionEdge["kind"]) => {
    const key = `${from}|${to}|${kind}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    edges.push({ from, to, kind });
  };

  const segExternalInputs = new Map<string, ValueRef[]>();
  const segInputDedup = new Map<string, Set<string>>();
  const consumedOpIdx = new Set<number>();
  const refKey = (r: ValueRef): string => JSON.stringify(r);

  const recordSegInput = (consumerNode: string, ref: ValueRef): void => {
    let seen = segInputDedup.get(consumerNode);
    if (!seen) segInputDedup.set(consumerNode, seen = new Set());
    const k = refKey(ref);
    if (seen.has(k)) return;
    seen.add(k);
    let arr = segExternalInputs.get(consumerNode);
    if (!arr) segExternalInputs.set(consumerNode, arr = []);
    arr.push(ref);
  };

  for (let i = 0; i < n; i++) {
    const consumerNode = ownerNodeId(i);
    for (const ref of dependencyRefs(ops[i])) {
      const p = refProducerIdx(ref);
      if (p === null || p === undefined) {
        if (!isBoundary[i]) recordSegInput(consumerNode, ref);
        continue;
      }
      if (p === i) continue;
      const producerNode = ownerNodeId(p);
      if (producerNode === consumerNode) continue;

      const cBnd = isBoundary[i];
      const pBnd = isBoundary[p];
      if (!cBnd && pBnd) addEdge(producerNode, consumerNode, "bnd->seg");
      else if (cBnd && !pBnd) addEdge(producerNode, consumerNode, "seg->bnd");
      else if (cBnd && pBnd) addEdge(producerNode, consumerNode, "bnd->bnd");
      else addEdge(producerNode, consumerNode, "seg->seg");

      if (!pBnd) consumedOpIdx.add(p);
      if (!cBnd) recordSegInput(consumerNode, ref);
    }
  }

  // The pattern result must be materialized by its producing segment.
  {
    const p = refProducerIdx(rog.result);
    if (p === undefined) {
      return {
        partitionable: false,
        reason: `result: ${failReason ?? "unresolvable ref"}`,
      };
    }
    if (p !== null && !isBoundary[p]) consumedOpIdx.add(p);
  }

  for (const seg of compToSeg.values()) {
    seg.inputs = segExternalInputs.get(seg.id) ?? [];
    const outOpIds = new Set<OpId>();
    for (const opId of seg.opIds) {
      const idx = idToIdx.get(opId)!;
      if (consumedOpIdx.has(idx)) outOpIds.add(opId);
    }
    seg.outputs = [...outOpIds].map((op) => ({
      kind: "opOut" as const,
      op,
      path: [],
    }));
  }

  const segments = [...compToSeg.values()].sort((a, b) =>
    a.layer - b.layer || a.id.localeCompare(b.id)
  );

  // --- fan-out exposure (R-SEAM-1/F2) -----------------------------------------
  const segToBoundaries = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "seg->bnd") continue;
    let set = segToBoundaries.get(e.from);
    if (!set) segToBoundaries.set(e.from, set = new Set());
    set.add(e.to);
  }
  const fanoutSegmentIds: string[] = [];
  for (const [segId, bset] of segToBoundaries) {
    if (bset.size > 1) fanoutSegmentIds.push(segId);
  }
  fanoutSegmentIds.sort();

  // --- structural recursion into inlinable boundaries -------------------------
  for (const b of boundaries) {
    const idx = idToIdx.get(b.opId)!;
    const op = ops[idx];
    let innerBuilt: BuiltRog | undefined;
    if (b.kind === "pattern") {
      innerBuilt = built.children.get(op.id);
    } else if (b.kind === "collection" && op.detail.kind === "collection") {
      const elementFactory = built.collectionElements.get(op.id);
      // The element's BuiltRog is resolved by the dispatch (W4) via the
      // side-table; here we only recurse when the element Rog is inline.
      if (op.detail.element && elementFactory !== undefined) {
        innerBuilt = resolveElementBuilt(elementFactory);
      }
    }
    if (!innerBuilt) continue;
    if (innerBuilt.rog.incomplete?.length) {
      return {
        partitionable: false,
        reason: `inner rog of boundary #${b.opId} (${b.kind}) incomplete: ` +
          innerBuilt.rog.incomplete.join(", "),
      };
    }
    const innerResult = partition({ built: innerBuilt });
    if (!innerResult.partitionable) {
      return {
        partitionable: false,
        reason: `inner partition of boundary #${b.opId} (${b.kind}) failed: ` +
          innerResult.reason,
      };
    }
    b.inner = innerResult;
  }

  return {
    partitionable: true,
    segments,
    boundaries,
    edges,
    fanoutSegmentIds,
  };
}

function resolveElementBuilt(factory: unknown): BuiltRog | undefined {
  return getBuiltRogResolved(factory);
}
