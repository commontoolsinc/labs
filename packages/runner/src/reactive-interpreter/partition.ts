/**
 * Coalescing PARTITIONER (step 2 of the coalescing track) — the §4.2 / §4.7
 * pure-region partition as a PRODUCTION module.
 *
 * Design: docs/specs/reactive-interpreter/07-coalescing-architecture.md §4.2
 * (the layered partition) + §4.7 (recursion into map elements / nested
 * patterns). This module is the ALGORITHM only: a PURE function that, given an
 * extracted ROG (with the F1 boundary-input edges now carried on `op.inputs` and
 * surfaced by `inputsOf`) plus the boundary classification, computes the
 * segment↔boundary DAG. It does NOT emit interpreter nodes, touch the scheduler,
 * or wire documents — that is step 3 (dispatch integration), which consumes the
 * `PartitionResult` shape defined below.
 *
 * Relationship to the static probe
 * (`packages/patterns/tools/coalescing-partition-probe.ts`): the probe is the
 * VALIDATED measurement reference. It models boundary-input edges itself by
 * walking raw `node.inputs` because it predates F1; this production module reads
 * those same edges off `inputsOf` (F1 landed them on `op.inputs` for effect ops)
 * and resolves `internal` refs through the ROG's `internalToOp`. The two agree
 * on segment counts on the corpus (cross-checked in partition.test.ts).
 *
 * FAIL-CLOSED (OQ-C1): any op the partitioner cannot soundly place — a cycle in
 * the coarsened graph, an unrecognized op shape, a producer edge that names a
 * cell no op in this graph produces, or an `internal`/`opOut` ref that resolves
 * to nothing — makes `partition()` return `{ partitionable: false, reason }`.
 * The caller (step 3) then legacy-instantiates the whole pattern. The
 * partitioner NEVER silently misplaces an op.
 *
 * Status: coalescing track step 2. NEW module — does not modify extract.ts /
 * rog.ts / interpret.ts / runner.ts.
 */

import {
  type ConstructTemplate,
  inputsOf,
  type Op,
  type OpId,
  type Rog,
  type ValueRef,
} from "./rog.ts";

// ---------------------------------------------------------------------------
// Output contract (consumed by step 3 — be precise; step 3 depends on this).
// ---------------------------------------------------------------------------

/**
 * A maximal pure region within one layer — one interpreter segment node.
 *
 * Step 3 emits ONE interpreter node per `Segment`, evaluating the sub-ROG formed
 * by `opIds` via `evalRog`. The node READS `inputs` (pattern args + upstream
 * boundary outputs) and WRITES `outputs` (the boundary-input / external-output
 * docs downstream consumers need). Pure intermediates internal to the segment
 * are never materialized (the §4.3 footprint win).
 */
export interface Segment {
  /** Stable segment id: `seg${layer}_${componentIndexWithinLayer}`. */
  id: string;
  /** The layer (0-based) this segment lives in — its depth past the boundaries
   * it transitively depends on. seg0 = reachable from args only. */
  layer: number;
  /** Op ids (in `rog.ops`) coalesced into this segment. Pure ops only; the
   * sub-ROG step 3 evaluates is the induced subgraph over these ops. Ordered by
   * appearance in `rog.ops` for determinism. */
  opIds: OpId[];
  /**
   * The ValueRefs this segment READS from OUTSIDE itself — pattern `argument`s,
   * `const`s, and `opOut`/`internal` refs produced by a BOUNDARY or by an op in
   * an EARLIER segment. (Refs produced by an op WITHIN this same segment are
   * internal and excluded.) This is the segment node's exact read-set; an empty
   * `boundary`/earlier-segment portion means it reads only args/consts (a seg0
   * candidate). Deduplicated structurally.
   */
  inputs: ValueRef[];
  /**
   * The ValueRefs this segment must MATERIALIZE — the outputs downstream
   * boundaries or the pattern result consume from it. Each entry names an op in
   * this segment (by `opOut`) whose value is read by (a) a downstream boundary's
   * input, (b) a later segment, or (c) the pattern `result`. These become the
   * boundary-input / external-output docs step 3 writes. Deduplicated by op id.
   */
  outputs: ValueRef[];
}

/** A boundary op kept as a legacy-instantiated scheduler node (§4.1 / §4.6). */
export interface Boundary {
  /** Stable boundary id: `bnd${opId}`. */
  id: string;
  /** Op id in `rog.ops`. */
  opId: OpId;
  /** The boundary op's kind (`effect` | `collection` | `pattern`, or a leaf the
   * resolver could not bind — recorded as `unresolved-leaf`). */
  kind: "effect" | "collection" | "pattern" | "unresolved-leaf";
  /** The ValueRefs this boundary READS as inputs (its `boundary←producer` edges,
   * from `inputsOf`). Step 3 wires each to the upstream segment/boundary doc that
   * produces it. */
  inputs: ValueRef[];
  /** For a `collection` map / nested `pattern` boundary with an inlinable body,
   * the recursively-computed sub-partition of the element/sub ROG (§4.7). Absent
   * for effect/filter/flatMap/unresolved boundaries and for serialized bodies. */
  inner?: PartitionResult;
}

/**
 * A producer→consumer edge in the coarsened (segment+boundary) DAG. `from`/`to`
 * are `Segment.id` or `Boundary.id`. Step 3 uses these to order node emission
 * and to know which segment feeds which boundary's inputs (and vice versa).
 */
export interface PartitionEdge {
  from: string;
  to: string;
  /**
   * `seg->bnd`: a segment produces a boundary's input doc.
   * `bnd->seg`: a boundary's output is consumed by a later segment.
   * `bnd->bnd`: a boundary output flows directly into another boundary's input
   *   (an effect→effect hop — the §4.5 read-through hazard; step 3 must wire a
   *   labeled read-through, never an unread hop).
   * `seg->seg` never occurs (connected pure ops coalesce into one segment).
   */
  kind: "seg->bnd" | "bnd->seg" | "bnd->bnd";
}

/** The successful partition of one ROG. */
export interface PartitionOk {
  partitionable: true;
  segments: Segment[];
  boundaries: Boundary[];
  edges: PartitionEdge[];
  /**
   * R-SEAM-1 fan-out exposure (finding F2) — NOT acted on here, recorded for
   * step 3. Each entry is a segment id whose output feeds the input of MORE THAN
   * ONE boundary in THIS graph. Step 3 must let multiple boundaries depend on
   * the one coalesced node simultaneously (the multi-output fan-out / container-
   * of-links convention, §4.4). Empty = no fan-out in this graph.
   */
  fanoutSegmentIds: string[];
}

/** A fail-closed partition: the caller legacy-instantiates the whole pattern. */
export interface PartitionFail {
  partitionable: false;
  /** Human-readable reason (for diagnostics / the dry-run probe). */
  reason: string;
}

export type PartitionResult = PartitionOk | PartitionFail;

// ---------------------------------------------------------------------------
// Boundary classification (§4.1 — reuses the extract classifier's kinds).
// ---------------------------------------------------------------------------

/**
 * Which ops are boundaries. This mirrors the validated probe
 * (`coalescing-partition-probe.ts::boundaryIndexSet`) EXACTLY so the production
 * partitioner's segment counts agree with the probe's corpus measurement:
 *
 *   - kind `effect` (the EFFECT_REFS I/O builtins + handlers, lowered to
 *     `effect` by `classifyModule`),
 *   - kind `collection` (a `map`/`filter`/`flatMap` node),
 *   - kind `pattern` (a sub-pattern node),
 *   - a `leaf` whose implementation does NOT resolve (the serialized/SES
 *     boundary the `unresolved_leaf` net catches — fail-closed).
 *
 * NOTE on §4.1's pure-map refinement: 07 §4.1 says a top-level `map` whose
 * element is *fully pure* could itself be a pure op (lives inside a segment),
 * with only `filter`/`flatMap` as collection boundaries "initially". This module
 * follows the PROBE's conservative classification (all collection ops are
 * boundaries) so the validated corpus counts hold and recursion (§4.7) is
 * uniform; inlining a fully-pure map into its parent segment would only REDUCE
 * the segment count further and is a safe future refinement, not a soundness
 * requirement. Recording it as a boundary is fail-closed.
 */
function boundaryKindOf(
  op: Op,
  unresolvedLeafOps: ReadonlySet<OpId>,
): Boundary["kind"] | null {
  if (op.kind === "effect") return "effect";
  if (op.kind === "collection") return "collection";
  if (op.kind === "pattern") return "pattern";
  if (op.kind === "leaf" && unresolvedLeafOps.has(op.id)) {
    return "unresolved-leaf";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full data-flow producer edges.
// ---------------------------------------------------------------------------

/** Collect the ValueRefs that form an op's FULL data-flow dependency set — the
 * union of `inputsOf(op)` (leaf input + effect boundary inputs + collection
 * listInput + pattern argument + control pred/branches) AND the construct
 * template refs (which `inputsOf` intentionally omits, mirroring
 * `topoOrder::depsOf`). This is the complete set of refs whose PRODUCERS this op
 * depends on. */
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
  /** The extracted ROG. */
  rog: Rog;
  /** Internal-cell name → producing op id, LOCAL to this ROG's node space (from
   * `ExtractResult.internalToOp`, or an inlined sub-pattern's `internalToOp`). */
  internalToOp: ReadonlyMap<string, OpId>;
  /** Leaf op ids that did NOT resolve (from `resolveLeafImpls`) — fail-closed
   * boundaries. Empty set ⇒ all leaves resolved. */
  unresolvedLeafOps: ReadonlySet<OpId>;
  /**
   * Resolve a `collection`/`pattern` boundary op to the inlinable sub-ROG to
   * recurse into (§4.7), or undefined if the body is not inlinable here (a
   * serialized `$patternRef`, a `filter`/`flatMap`, etc.). When provided and it
   * returns a `{ rog, internalToOp }`, the partitioner recurses and attaches the
   * inner `PartitionResult` to that boundary.
   *
   * Optional: omit to skip recursion (the top-level structural partition only).
   * Kept as an injected resolver (rather than reaching into raw `node.inputs`)
   * so this module stays decoupled from the raw Pattern shape — step 3 supplies
   * the same `module.implementation.nodes` / inline-element resolution the probe
   * and `extract.ts` already do, re-extracting the inner ROG.
   */
  resolveInner?: (op: Op) => InnerRog | undefined;
}

/** An inlinable sub-ROG for §4.7 recursion. */
export interface InnerRog {
  rog: Rog;
  internalToOp: ReadonlyMap<string, OpId>;
  unresolvedLeafOps?: ReadonlySet<OpId>;
  /**
   * The `resolveInner` to use when recursing into THIS sub-ROG's own boundaries
   * (§4.7 is multi-level: a map element may itself instantiate a sub-pattern).
   * The inner frame's ops index into the inner Pattern's nodes, NOT the parent's,
   * so a resolver bound to the parent frame would resolve the wrong nodes. When
   * omitted, the partitioner falls back to the parent's `resolveInner` (correct
   * only if the parent resolver is frame-agnostic). Supply this whenever the
   * recursion must follow a different raw Pattern frame.
   */
  resolveInner?: (op: Op) => InnerRog | undefined;
}

/**
 * Partition one ROG into pure segments + boundary nodes + the coarsened DAG
 * (07 §4.2). Pure function — no side effects, no I/O.
 *
 * Algorithm:
 *  1. Resolve every op's producer-op set from its full dependency refs
 *     (`dependencyRefs`): `opOut` → op id; `internal` → `internalToOp` → op id;
 *     `argument`/`const` → no producer (available at seg0).
 *  2. Mark boundaries (`boundaryKindOf`).
 *  3. LAYER the ops to a fixpoint (bounded relaxation over the acyclic relation):
 *     `placed[op] = max over producers p of avail[p]`, where a boundary's output
 *     becomes available one layer LATER than the boundary is placed (the §4.2
 *     cut) and a pure op's output is available in its own layer. Args/consts ⇒
 *     layer 0.
 *  4. SEGMENT GRANULARITY = choice (ii), 07 §4.2: one segment per MAXIMAL
 *     CONNECTED COMPONENT of pure ops WITHIN a layer (tighter read/write-sets →
 *     value-accurate invalidation, OQ-C4). Connectivity is over pure↔pure
 *     producer edges restricted to the same layer. (The probe counts under
 *     choice (i), layer = one segment, so the probe's `pureSegments` is a LOWER
 *     bound on this module's segment count; see the cross-check note in the
 *     test.)
 *  5. Build the segment↔boundary DAG: seg→bnd (segment feeds a boundary input),
 *     bnd→seg (boundary output read by a later segment), bnd→bnd (effect→effect
 *     hop). Compute each segment's external `inputs` and materialized `outputs`.
 *  6. RECURSE (§4.7) into each boundary `resolveInner` yields a sub-ROG for, and
 *     attach the inner `PartitionResult`.
 *  7. FAIL-CLOSED: an unresolvable producer ref, an unplaceable op (cycle), or
 *     an inner partition that itself failed ⇒ `{ partitionable: false }`.
 */
export function partition(input: PartitionInput): PartitionResult {
  const { rog, internalToOp, unresolvedLeafOps, resolveInner } = input;
  const ops = rog.ops;
  const n = ops.length;

  // op.id -> array index (real ids are node indices >= 0; synth ids are < 0).
  const idToIdx = new Map<OpId, number>();
  for (let i = 0; i < n; i++) idToIdx.set(ops[i].id, i);

  const isBoundary = new Array<boolean>(n).fill(false);
  const boundaryKind = new Array<Boundary["kind"] | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const k = boundaryKindOf(ops[i], unresolvedLeafOps);
    if (k !== null) {
      isBoundary[i] = true;
      boundaryKind[i] = k;
    }
  }

  // Resolve a ValueRef to the array index of its producing op, or:
  //   - null      : no producer dependency (argument / const).
  //   - undefined : a producer the graph does NOT contain (an `internal`/`opOut`
  //                 ref naming a cell no op here produces) — FAIL CLOSED.
  const refProducerIdx = (ref: ValueRef): number | null | undefined => {
    if (ref.kind === "opOut") {
      const idx = idToIdx.get(ref.op);
      return idx === undefined ? undefined : idx;
    }
    if (ref.kind === "internal") {
      const opId = internalToOp.get(ref.name);
      if (opId === undefined) {
        // An internal cell produced OUTSIDE this graph (a parent/external cell)
        // is a legitimate seg0 input, NOT a missing producer. We cannot tell the
        // two apart structurally, so we treat an unresolved `internal` as an
        // external arg-like input (no producer edge). This matches the probe,
        // which only adds an edge when the alias names a producer IN this graph.
        return null;
      }
      const idx = idToIdx.get(opId);
      return idx === undefined ? undefined : idx;
    }
    return null; // argument | const
  };

  // Per-op producer index set (the data-flow DAG edges, array-index space).
  const producers: Set<number>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const set = new Set<number>();
    for (const ref of dependencyRefs(ops[i])) {
      const p = refProducerIdx(ref);
      if (p === undefined) {
        return {
          partitionable: false,
          reason:
            `op #${ops[i].id} (${
              ops[i].kind
            }) reads a ref naming a cell no op ` +
            `in this graph produces (${ref.kind})`,
        };
      }
      if (p !== null && p !== i) set.add(p);
    }
    producers[i] = set;
  }

  // --- 3. Layer to a fixpoint -------------------------------------------------
  // avail[i] = layer in which op[i]'s output is available downstream.
  // placed[i] = layer op[i] is itself placed in.
  const avail = new Array<number>(n).fill(-1);
  const placed = new Array<number>(n).fill(-1);

  let changed = true;
  let guard = 0;
  // Each pass can only RAISE a layer index; an acyclic graph converges in <=
  // depth passes. The +2 slack guards against synth-op interleaving order. If we
  // exhaust the guard with ops still unplaced, there is a cycle in the coarsened
  // graph → fail closed.
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

  // FAIL CLOSED: any op still unplaced after the fixpoint is in (or behind) a
  // cycle the layering can't resolve. Never coalesce an op we couldn't place.
  for (let i = 0; i < n; i++) {
    if (placed[i] < 0) {
      return {
        partitionable: false,
        reason:
          `op #${ops[i].id} (${ops[i].kind}) could not be placed in a layer ` +
          `(cycle or unresolved dependency)`,
      };
    }
  }

  // --- 4. Segment granularity = connected components within a layer (ii) ------
  // Union-find over PURE ops, unioning two pure ops iff one produces the other
  // AND both sit in the SAME layer. (Cross-layer pure→pure edges do not merge —
  // they belong to different segments by construction.)
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

  // Group pure ops by their connected-component root; assign each component a
  // stable segment id keyed on (layer, component appearance order).
  const compToSeg = new Map<number, Segment>();
  const segOfOpIdx = new Array<string | null>(n).fill(null);
  // Per-layer running component index, for deterministic ids.
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

  // Node id (segment or boundary) that PRODUCES op[i]'s value downstream.
  const ownerNodeId = (opIdx: number): string =>
    isBoundary[opIdx] ? boundaryIdOf(opIdx) : (segOfOpIdx[opIdx] as string);

  // --- 5. Build boundaries, edges, segment inputs/outputs ---------------------
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

  // Edges + per-segment external inputs/outputs. We walk every op's producer
  // edges once and classify each by (ownerKind(consumer), ownerKind(producer)).
  const edgeKey = new Set<string>();
  const edges: PartitionEdge[] = [];
  const addEdge = (from: string, to: string, kind: PartitionEdge["kind"]) => {
    const key = `${from}|${to}|${kind}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    edges.push({ from, to, kind });
  };

  // Track, per segment, the set of producer node-ids it depends on EXTERNALLY
  // and the set of refs it reads from outside, plus which of its own ops are
  // consumed downstream (to materialize as outputs).
  const segExternalInputs = new Map<string, ValueRef[]>();
  const segInputDedup = new Map<string, Set<string>>();
  const consumedOpIdx = new Set<number>(); // op indices read by a DIFFERENT node

  const refKey = (r: ValueRef): string => JSON.stringify(r);

  for (let i = 0; i < n; i++) {
    const consumerNode = ownerNodeId(i);
    for (const ref of dependencyRefs(ops[i])) {
      const p = refProducerIdx(ref);
      if (p === null || p === undefined) {
        // arg/const (or external internal): only a SEGMENT records it as an
        // external input (boundaries already carry their raw inputs).
        if (!isBoundary[i]) {
          let seen = segInputDedup.get(consumerNode);
          if (!seen) segInputDedup.set(consumerNode, seen = new Set());
          const k = refKey(ref);
          if (!seen.has(k)) {
            seen.add(k);
            let arr = segExternalInputs.get(consumerNode);
            if (!arr) segExternalInputs.set(consumerNode, arr = []);
            arr.push(ref);
          }
        }
        continue;
      }
      if (p === i) continue;
      const producerNode = ownerNodeId(p);
      if (producerNode === consumerNode) continue; // intra-segment: internal

      // Cross-node edge. Classify and record.
      const cBnd = isBoundary[i];
      const pBnd = isBoundary[p];
      if (!cBnd && pBnd) addEdge(producerNode, consumerNode, "bnd->seg");
      else if (cBnd && !pBnd) addEdge(producerNode, consumerNode, "seg->bnd");
      else if (cBnd && pBnd) addEdge(producerNode, consumerNode, "bnd->bnd");
      // (!cBnd && !pBnd) across nodes ⇒ two pure ops in DIFFERENT segments. The
      // producer's value is an output of its segment and an input of this one.

      // The producer op's value crosses a node boundary ⇒ it must be
      // materialized as the producer node's output (if the producer is a
      // segment).
      if (!pBnd) consumedOpIdx.add(p);

      // For a SEGMENT consumer, the external ref is a read of the producer
      // node's output.
      if (!cBnd) {
        let seen = segInputDedup.get(consumerNode);
        if (!seen) segInputDedup.set(consumerNode, seen = new Set());
        const k = refKey(ref);
        if (!seen.has(k)) {
          seen.add(k);
          let arr = segExternalInputs.get(consumerNode);
          if (!arr) segExternalInputs.set(consumerNode, arr = []);
          arr.push(ref);
        }
      }
    }
  }

  // The pattern RESULT (egress root, R-MAT-1/2) is an external output: whichever
  // segment produces the result op must materialize it.
  const markResultConsumed = (ref: ValueRef): void => {
    const p = refProducerIdx(ref);
    if (p !== null && p !== undefined && !isBoundary[p]) consumedOpIdx.add(p);
  };
  markResultConsumed(rog.result);
  // A construct/access result ref points at a single op; deep result trees are
  // already construct ops in `ops`, so their leaf refs are walked above.

  // Attach computed inputs/outputs to each segment.
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

  // --- R-SEAM-1 fan-out (finding F2): a segment feeding >1 boundary -----------
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

  // --- 6. Recurse into inlinable boundaries (§4.7) ----------------------------
  if (resolveInner) {
    for (const b of boundaries) {
      if (b.kind !== "collection" && b.kind !== "pattern") continue;
      const idx = idToIdx.get(b.opId);
      if (idx === undefined) continue;
      const inner = resolveInner(ops[idx]);
      if (!inner) continue; // not inlinable here (serialized / filter / flatMap)
      const innerResult = partition({
        rog: inner.rog,
        internalToOp: inner.internalToOp,
        unresolvedLeafOps: inner.unresolvedLeafOps ?? new Set<OpId>(),
        // Recurse with the inner frame's OWN resolver (its ops index the inner
        // Pattern's nodes); fall back to the parent's only if none supplied.
        resolveInner: inner.resolveInner ?? resolveInner,
      });
      // FAIL CLOSED: an inner partition that failed poisons the parent (the
      // element/sub body cannot be coalesced, so the whole pattern falls back).
      if (!innerResult.partitionable) {
        return {
          partitionable: false,
          reason:
            `inner partition of boundary #${b.opId} (${b.kind}) failed: ` +
            innerResult.reason,
        };
      }
      b.inner = innerResult;
    }
  }

  return {
    partitionable: true,
    segments,
    boundaries,
    edges,
    fanoutSegmentIds,
  };
}
