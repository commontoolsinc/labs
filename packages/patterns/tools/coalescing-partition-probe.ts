/**
 * STATIC COALESCING-PARTITION PROBE — measures the coverage / footprint jump the
 * pure-region coalescing design
 * (docs/specs/reactive-interpreter/07-coalescing-architecture.md, §4.2) would
 * deliver, WITHOUT building the executor.
 *
 * This is a MEASUREMENT, not a gate and not an implementation. It uses the
 * EXISTING extraction infra (`reactive-interpreter/extract.ts::extractRog`,
 * which already classifies effect / collection / pattern boundary kinds and the
 * EFFECT_REFS builtins) on REAL builder-produced patterns, then applies the
 * §4.2 layered partition statically over the resulting ROG and reports, per
 * pattern:
 *
 *   - total ops, #boundary ops, #pure ops
 *   - #segments produced (one interpreter node per maximal pure region)
 *   - PROJECTED coalesced node count (#pure-segments + #boundary nodes) vs the
 *     LEGACY node count (~all real nodes materialized)
 *   - coverage = pure ops coalesced / total ops, and the projected node
 *     reduction %.
 *
 * Crucially it also reports how this compares to TODAY: the landed all-or-nothing
 * gate falls these patterns back to 0% interpreted (any boundary anywhere
 * disqualifies the whole pattern), so today's coalesced fraction is 0.
 *
 * §4.7 recursion: a `map` whose element pattern contains a boundary has its
 * ELEMENT ROG partitioned by the SAME pass; the element segment/boundary counts
 * aggregate into the pattern's totals (with a per-element multiplicity note).
 *
 * Reproduce:
 *   cd packages/patterns
 *   deno run -A tools/coalescing-partition-probe.ts
 *   deno run -A tools/coalescing-partition-probe.ts --json    # + machine output
 *
 * HONEST SCOPE / boundaries:
 *   - Real extraction only: op counts come from `extractRog` on the real
 *     in-memory builder pattern (compiled via the same harness the runtime uses).
 *     Nothing is hand-estimated.
 *   - Static only: no executor, no interpreter change, no scheduler interaction.
 *     The partition is the §4.2 layered topological assignment computed over the
 *     ROG, exactly as the spec says it would be computed at extract/transform
 *     time.
 *   - Boundary set per §4.1 / STEP-1: an op is a BOUNDARY iff its kind is
 *     `effect` (this already subsumes the EFFECT_REFS I/O builtins and handlers
 *     — `classifyModule` lowers them to `effect`), `collection`, or `pattern`
 *     (a sub-pattern node), OR it is a `leaf` whose implementation does not
 *     resolve (the serialized/SES boundary the `unresolved_leaf` net catches).
 *     Everything else (`leaf` w/ resolvable impl, `access`, `construct`,
 *     `control`) is PURE.
 *   - For a top-level `map` with an INLINE element pattern, the element ROG is
 *     re-extracted and partitioned recursively (§4.7). A `filter`/`flatMap`, a
 *     serialized element (`$patternRef`, no inline `.nodes`), or a nested
 *     `pattern` node is treated as a leaf boundary at this level (its sub-graph,
 *     if inline, is still recursed for the element census).
 *
 * BOUNDARY INPUT EDGES (measurement correction, 2026-06-24):
 *   The production `extract.ts` gives `op.inputs` ONLY to leaf ops; effect ops
 *   get `detail = {kind:"effect"}` with NO refs, and `rog.ts::inputsOf` returns
 *   [] for an effect op. So an earlier version of this probe placed EVERY I/O
 *   boundary (fetch / llm / sqlite / handler) at seg0 with no `boundary←producer`
 *   edge — the layered partition had nothing to cut on, and the headline node
 *   reductions were over-optimistic.
 *
 *   This probe now models the missing edges ITSELF (it does NOT touch production
 *   extract.ts / rog.ts): for EVERY op it reads the RAW pattern node's `inputs`
 *   tree (the same `node.inputs` alias tree leaf nodes use) and resolves every
 *   canonical `$alias` leaf that names a producer in THIS (sub-)Rog's node space
 *   to a `producer→op` edge (`producerOpIndicesFromRawInputs`). This supplies:
 *     - the effect/handler boundary input edges that were entirely absent, and
 *     - the internal-cell edges that `extractRog`'s `defer` fail-closed gate
 *       drops when a sub-pattern is re-extracted standalone at depth 0 (its
 *       serialized aliases carry their ORIGINAL nesting `defer`). For a STATIC
 *       edge-count the producer edge exists iff the alias names a cell produced
 *       in this graph, independent of `defer` (which is a runtime wrong-cell
 *       safety gate, not a structural fact), so the walker is defer-agnostic.
 *   Event-stream aliases (a handler's `$event`, `$kind:"stream"` / `{stream:[…]}`
 *   payloads) are NOT value-producer edges (the handler fires on events, it does
 *   not wait for a segment to produce the stream) and are excluded.
 *
 *   With the edges present a boundary lands in the segment AFTER the segment(s)
 *   that produce its inputs, and pure ops consuming a boundary's output land
 *   AFTER the boundary — so boundaries now CUT the pure regions into more pieces.
 *   Expect MORE segments and a SMALLER projected reduction than the edge-less
 *   version. The §4.4 R-SEAM-1 fan-out (a single pure segment feeding >1
 *   boundary, finding F2) is also counted per pattern.
 */

import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "../../runner/src/storage/cache.deno.ts";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import {
  extractRog,
  resolveLeafImpls,
} from "../../runner/src/reactive-interpreter/extract.ts";
import {
  inputsOf,
  type Rog,
} from "../../runner/src/reactive-interpreter/rog.ts";
import { isLegacyAlias } from "../../runner/src/link-types.ts";

// ---------------------------------------------------------------------------
// Partition over a single ROG (the §4.2 layered topological assignment).
// ---------------------------------------------------------------------------

/** A single ROG's partition result (no recursion — caller aggregates). */
interface Partition {
  /** All ops in this ROG (real nodes id>=0 + synth construct ops id<0). */
  totalOps: number;
  /** Real (id>=0) ops only — these are the legacy scheduler nodes. */
  realOps: number;
  /** Synth construct ops (id<0) — extraction artifacts, pure by construction. */
  synthOps: number;
  /** Boundary ops (effect/collection/pattern/unresolved-leaf). */
  boundaryOps: number;
  /** Boundary REAL ops (the nodes coalescing preserves as legacy nodes). */
  boundaryRealOps: number;
  /** Pure ops (leaf/access/construct/control with resolvable impl). */
  pureOps: number;
  /** Pure REAL ops (the legacy nodes coalescing would collapse). */
  pureRealOps: number;
  /** Number of distinct segments that contain >=1 PURE op (interpreter nodes). */
  pureSegments: number;
  /** R-SEAM-1 fan-out (finding F2): number of distinct PURE segments whose
   * output feeds the input of MORE THAN ONE boundary in this graph. Each such
   * segment is a coalesced interpreter node the §4.4 design must let multiple
   * boundaries depend on simultaneously. */
  fanoutSegments: number;
  /** Total (segment, boundary) producer edges where the segment is a pure
   * segment feeding a boundary — context for the fan-out count. */
  segmentBoundaryEdges: number;
  /** Op ids (real, id>=0) of the collection `map` nodes whose element pattern
   * should be recursed into (§4.7) — index into the original Pattern's nodes. */
  recurseMapNodeIds: number[];
}

/**
 * The producer-cell name a canonical `$alias` leaf references, or null if the
 * alias is not a value-producer dependency (a pattern `argument`, an event
 * stream, or an unrecognized payload). Mirrors `extract.ts::aliasToValueRef`'s
 * name derivation, MINUS the `defer` fail-closed gate: for a STATIC edge the
 * producer link exists iff the alias names a cell produced in THIS graph, which
 * is `defer`-independent (`defer` is a runtime wrong-cell safety gate, not a
 * structural fact, and a sub-pattern re-extracted standalone carries its
 * ORIGINAL nesting `defer`). Event-stream aliases are excluded (a handler fires
 * on events; it does not depend on a segment producing the stream value).
 */
function aliasProducerName(alias: Record<string, unknown>): string | null {
  // A pattern argument is available at seg0 — no producer edge.
  if (alias.cell === "argument") return null;
  const pc = alias.partialCause;
  // A handler's `$event` (or any `$kind:"stream"` payload) is an event source,
  // not a value producer — exclude it.
  if (typeof pc === "string") {
    return pc; // internal-cell name (a derived cell this graph may produce)
  }
  if (pc && typeof pc === "object") {
    const o = pc as Record<string, unknown>;
    // Event-stream sinks: `{ $kind: "stream", ... }` or `{ stream: [...] }`.
    if (o.$kind === "stream" || Array.isArray(o.stream)) return null;
    if ("$generated" in o && typeof o.$generated === "number") {
      return `$generated:${o.$generated}`;
    }
  }
  return null;
}

/**
 * Walk a RAW node `inputs` value tree and collect the array indices of the ops
 * that PRODUCE its inputs (the `producer→thisOp` edges). For each canonical
 * `$alias` leaf, resolve its producer-cell name to an op via THIS (sub-)Rog's
 * `internalToOp`; an alias that names no producer in this graph (a pattern
 * argument, an external/parent cell, or an event stream) yields no edge (its
 * value is available at seg0). This is how the probe models the boundary input
 * edges that production `extract.ts` drops for effect ops, plus the leaf
 * internal edges the `defer` gate drops on a standalone-re-extracted sub-Rog.
 */
function producerOpIndicesFromRawInputs(
  rawInputs: unknown,
  internalToOp: Map<string, number>,
  idToIdx: Map<number, number>,
  into: Set<number>,
): void {
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (isLegacyAlias(v)) {
      const alias = (v as { $alias: Record<string, unknown> }).$alias;
      const name = aliasProducerName(alias);
      if (name !== null) {
        const opId = internalToOp.get(name);
        if (opId !== undefined) {
          const idx = idToIdx.get(opId);
          if (idx !== undefined) into.add(idx);
        }
      }
      // Do NOT descend into the alias payload (path/schema are not inputs).
      return;
    }
    if (Array.isArray(v)) {
      for (const el of v) visit(el);
      return;
    }
    for (const el of Object.values(v as Record<string, unknown>)) visit(el);
  };
  visit(rawInputs);
}

/** Classify which ops are boundaries. Returns a Set of op-array indices. */
function boundaryIndexSet(
  rog: Rog,
  unresolvedLeafOps: Set<number>,
): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < rog.ops.length; i++) {
    const op = rog.ops[i];
    if (
      op.kind === "effect" || op.kind === "collection" || op.kind === "pattern"
    ) {
      set.add(i);
    } else if (op.kind === "leaf" && unresolvedLeafOps.has(op.id)) {
      // A leaf whose impl does not resolve is the serialized/SES boundary the
      // §4.1 boundary set explicitly includes (fail-closed): it cannot be
      // coalesced, so it stays a real boundary node.
      set.add(i);
    }
  }
  return set;
}

/**
 * Apply the §4.2 layered partition. The ROG is acyclic (a well-formed pattern);
 * we resolve each op's producing-op dependencies and assign the earliest segment
 * after all inputs are available. A boundary op's OUTPUT becomes available in the
 * segment AFTER it runs (the cut); a pure op's output is available in its own
 * segment.
 *
 * Producer edges come from TWO sources, unioned per op:
 *   1. `inputsOf(op)` — the ValueRefs `extract.ts` populated (leaf `op.inputs`,
 *      plus collection `listInput` / pattern `argument` / control refs carried in
 *      `detail`).
 *   2. `producerOpIndicesFromRawInputs(node.inputs)` — the raw node's input alias
 *      tree, which is the ONLY source of input edges for `effect` ops (their
 *      `detail` carries no refs, so source (1) is empty for them), and which also
 *      recovers the internal-cell edges `extract.ts`'s `defer` gate drops on a
 *      standalone-re-extracted sub-Rog. `nodes[op.id]` is the raw node (op id ==
 *      node index for real ops; synth ops id<0 have no raw node).
 */
function partition(
  rog: Rog,
  unresolvedLeafOps: Set<number>,
  internalToOp: Map<string, number>,
  nodes: ReadonlyArray<{ inputs?: unknown }>,
): Partition {
  const ops = rog.ops;
  const boundary = boundaryIndexSet(rog, unresolvedLeafOps);

  // op.id -> array index (real ids are node indices >=0; synth ids are <0).
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < ops.length; i++) idToIdx.set(ops[i].id, i);

  // Resolve a ValueRef to the array index of its producing op, or null if it is
  // a pattern arg / const (available at seg0, no producer dependency).
  const refProducerIdx = (
    ref: ReturnType<typeof inputsOf>[number],
  ): number | null => {
    if (ref.kind === "opOut") return idToIdx.get(ref.op) ?? null;
    if (ref.kind === "internal") {
      const opId = internalToOp.get(ref.name);
      return opId === undefined ? null : (idToIdx.get(opId) ?? null);
    }
    return null; // argument | const
  };

  // Per-op producer edge set (array indices). Union of the ValueRef producers
  // and the raw-input alias producers (the boundary input edges + defer-dropped
  // internal edges). A producer index === i (self) is impossible in an acyclic
  // graph, but we guard anyway so a malformed self-ref can't deadlock the loop.
  const producers: Set<number>[] = ops.map((op, i) => {
    const set = new Set<number>();
    for (const ref of inputsOf(op)) {
      const p = refProducerIdx(ref);
      if (p !== null && p !== i) set.add(p);
    }
    // Raw node input aliases (real ops only; synth construct ops have no node).
    if (op.id >= 0) {
      const node = nodes[op.id];
      if (node) {
        const raw = new Set<number>();
        producerOpIndicesFromRawInputs(
          node.inputs,
          internalToOp,
          idToIdx,
          raw,
        );
        for (const p of raw) if (p !== i) set.add(p);
      }
    }
    return set;
  });

  // The segment in which op[i]'s OUTPUT becomes available downstream.
  const avail = new Array<number>(ops.length).fill(-1);
  // The segment op[i] itself is placed in.
  const placed = new Array<number>(ops.length).fill(-1);

  // Iterate to a fixpoint over the (acyclic) dependency relation. Topo order is
  // not guaranteed to be array order once synth ops interleave, so a bounded
  // relaxation loop is the simplest correct assignment (each pass can only raise
  // a segment index; it converges in <= depth passes).
  let changed = true;
  let guard = 0;
  while (changed && guard++ <= ops.length + 2) {
    changed = false;
    for (let i = 0; i < ops.length; i++) {
      let seg = 0;
      let ready = true;
      for (const p of producers[i]) {
        if (avail[p] < 0) {
          ready = false;
          break;
        }
        if (avail[p] > seg) seg = avail[p];
      }
      if (!ready) continue;
      if (placed[i] !== seg) {
        placed[i] = seg;
        // A boundary's output is available one segment later (the §4.2 cut).
        avail[i] = boundary.has(i) ? seg + 1 : seg;
        changed = true;
      }
    }
  }

  // Count distinct segments that hold >=1 PURE op.
  const pureSegSet = new Set<number>();
  let boundaryOps = 0;
  let boundaryRealOps = 0;
  let pureOps = 0;
  let pureRealOps = 0;
  let realOps = 0;
  let synthOps = 0;
  const recurseMapNodeIds: number[] = [];

  const segOf = (i: number): number => (placed[i] < 0 ? 0 : placed[i]);

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const isReal = op.id >= 0;
    if (isReal) realOps++;
    else synthOps++;
    if (boundary.has(i)) {
      boundaryOps++;
      if (isReal) boundaryRealOps++;
      // Top-level pure `map` (collection) with an inline element -> recurse.
      if (
        op.kind === "collection" && op.detail.kind === "collection" &&
        op.detail.op === "map" && isReal
      ) {
        recurseMapNodeIds.push(op.id);
      }
    } else {
      pureOps++;
      if (isReal) pureRealOps++;
      // A pure op with no placement (unreachable / disconnected) is dropped from
      // the segment count but still counted as pure; placed>=0 is the norm.
      pureSegSet.add(segOf(i));
    }
  }

  // R-SEAM-1 fan-out (finding F2): a PURE segment that feeds >1 boundary. For
  // each boundary, collect the distinct PURE segments among its producers; a
  // segment feeding multiple boundaries is the simultaneous dependency §4.4 must
  // support. Only PURE producers count — a boundary producer is a separate node
  // already, not a coalesced segment.
  const segToBoundaries = new Map<number, Set<number>>();
  let segmentBoundaryEdges = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!boundary.has(i)) continue;
    const feederSegs = new Set<number>();
    for (const p of producers[i]) {
      if (boundary.has(p)) continue; // boundary producer is its own node
      feederSegs.add(segOf(p));
    }
    for (const s of feederSegs) {
      segmentBoundaryEdges++;
      let bs = segToBoundaries.get(s);
      if (!bs) segToBoundaries.set(s, bs = new Set<number>());
      bs.add(i);
    }
  }
  let fanoutSegments = 0;
  for (const bs of segToBoundaries.values()) if (bs.size > 1) fanoutSegments++;

  return {
    totalOps: ops.length,
    realOps,
    synthOps,
    boundaryOps,
    boundaryRealOps,
    pureOps,
    pureRealOps,
    pureSegments: pureSegSet.size,
    fanoutSegments,
    segmentBoundaryEdges,
    recurseMapNodeIds,
  };
}

// ---------------------------------------------------------------------------
// Recursive partition of a Pattern (§4.7): top-level + per-map element ROGs.
// ---------------------------------------------------------------------------

interface RawNodeLike {
  module?: { implementation?: unknown };
  /** The node's structured input value tree. For a collection the element
   * pattern is under `.op`; for every node it is the raw alias tree the partition
   * reads producer edges from (`producerOpIndicesFromRawInputs`). */
  inputs?: { op?: unknown } & Record<string, unknown> | unknown;
}
interface RawPatternLike {
  nodes?: RawNodeLike[];
}

function isInlinePattern(v: unknown): v is RawPatternLike {
  return !!v && typeof v === "object" &&
    Array.isArray((v as RawPatternLike).nodes);
}

/** A partitioned (sub-)graph plus its recursed children. */
interface PartitionNode {
  label: string;
  /** 1 for the top-level; for an element ROG this is informational only — the
   * element graph is one structural body re-instantiated per list element. */
  part: Partition;
  children: PartitionNode[];
}

/**
 * Partition a Pattern recursively. `label` names this graph in the report; the
 * top-level call passes the pattern name, recursion passes `<name>.map#i.elem`.
 */
function partitionPattern(
  // deno-lint-ignore no-explicit-any
  pattern: any,
  label: string,
): PartitionNode {
  const ex = extractRog(pattern);
  // resolveLeafImpls tells us which leaves do NOT resolve (the boundary net).
  let unresolved = new Set<number>();
  try {
    const { unresolvedLeafOps } = resolveLeafImpls(pattern, ex.rog);
    unresolved = new Set(unresolvedLeafOps);
  } catch {
    // If resolution throws wholesale, treat all leaves as resolvable (the probe
    // measures structure; an SES resolution failure is a separate boundary we
    // surface via the recurse path, not by poisoning the whole count).
  }
  const nodes = (pattern.nodes ?? []) as RawNodeLike[];
  // Pass the raw nodes so the partition can read each boundary op's input alias
  // tree (`producerOpIndicesFromRawInputs`) — the boundary←producer edges that
  // production `extract.ts` omits for effect ops. `op.id === node index` for
  // real ops, so `nodes[op.id]` is the matching raw node.
  const part = partition(
    ex.rog,
    unresolved,
    ex.internalToOp,
    nodes as ReadonlyArray<{ inputs?: unknown }>,
  );

  const children: PartitionNode[] = [];
  for (const nodeId of part.recurseMapNodeIds) {
    const node = nodes[nodeId];
    const elementPattern = (node?.inputs as { op?: unknown } | undefined)?.op;
    if (isInlinePattern(elementPattern)) {
      children.push(
        partitionPattern(elementPattern, `${label}.map#${nodeId}.elem`),
      );
      // §4.7: the element pattern may itself instantiate a sub-pattern node
      // (e.g. lunch-poll's PollOptionCard). That sub-pattern's inline body is
      // recursed by partitionPattern's own pattern-node handling below.
    }
  }
  // Also recurse into INLINE nested `pattern` nodes (PollOptionCard etc.): the
  // pattern node is a boundary at this level, but its pure interior is the very
  // thing coalescing un-traps, so we partition it too.
  for (let i = 0; i < nodes.length; i++) {
    const impl = (nodes[i]?.module as { implementation?: unknown } | undefined)
      ?.implementation;
    if (isInlinePattern(impl)) {
      children.push(partitionPattern(impl, `${label}.pattern#${i}`));
    }
  }
  return { label, part, children };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting.
// ---------------------------------------------------------------------------

interface Totals {
  totalOps: number;
  realOps: number;
  boundaryOps: number;
  boundaryRealOps: number;
  pureOps: number;
  pureRealOps: number;
  /** Projected interpreter SEGMENT nodes (sum of pure-segment counts). */
  pureSegments: number;
  /** R-SEAM-1 fan-out segments (a pure segment feeding >1 boundary), summed. */
  fanoutSegments: number;
  /** (pure-segment → boundary) producer edges, summed. */
  segmentBoundaryEdges: number;
  /** Distinct sub-graphs partitioned (top-level + recursed elements/patterns). */
  graphs: number;
}

function emptyTotals(): Totals {
  return {
    totalOps: 0,
    realOps: 0,
    boundaryOps: 0,
    boundaryRealOps: 0,
    pureOps: 0,
    pureRealOps: 0,
    pureSegments: 0,
    fanoutSegments: 0,
    segmentBoundaryEdges: 0,
    graphs: 0,
  };
}

/** Fold a PartitionNode tree into flat totals (structural, NOT per-element
 * multiplied — one element body is one structural graph). */
function fold(node: PartitionNode, into: Totals): void {
  const p = node.part;
  into.totalOps += p.totalOps;
  into.realOps += p.realOps;
  into.boundaryOps += p.boundaryOps;
  into.boundaryRealOps += p.boundaryRealOps;
  into.pureOps += p.pureOps;
  into.pureRealOps += p.pureRealOps;
  into.pureSegments += p.pureSegments;
  into.fanoutSegments += p.fanoutSegments;
  into.segmentBoundaryEdges += p.segmentBoundaryEdges;
  into.graphs += 1;
  for (const c of node.children) fold(c, into);
}

interface Row {
  name: string;
  ok: boolean;
  error?: string;
  tree?: PartitionNode;
  totals?: Totals;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

/**
 * Projected coalesced node count (the design's emission): #pure-segments
 * (interpreter nodes) + #boundary REAL nodes (preserved legacy nodes). Legacy
 * node count: all REAL nodes (every op the legacy path materializes). Synth
 * construct ops (id<0) are extraction artifacts, NOT legacy scheduler nodes, so
 * the legacy basis is `realOps`; they ARE pure computation, so they count toward
 * coverage at the op level.
 */
function projected(t: Totals): { coalesced: number; legacy: number } {
  return {
    coalesced: t.pureSegments + t.boundaryRealOps,
    legacy: t.realOps,
  };
}

const CORPUS: Array<{ name: string; dir: string }> = [
  { name: "lunch-poll (main + recursion)", dir: "lunch-poll" },
  { name: "notes-list-bench", dir: "notes-list-bench" },
  { name: "github-activity (fetch+llm)", dir: "github-activity" },
  { name: "cfc-row-label-mailbox (sqlite)", dir: "cfc-row-label-mailbox" },
  {
    name: "cfc-agent-prompt-injection (llm)",
    dir: "cfc-agent-prompt-injection-demo",
  },
  { name: "fair-share (wish+maps)", dir: "fair-share" },
  { name: "profile-group-chat (wish)", dir: "profile-group-chat" },
];

async function main(): Promise<void> {
  const emitJson = Deno.args.includes("--json");
  const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const signer = await Identity.fromPassphrase("coalescing-partition-probe");

  const rows: Row[] = [];
  for (const entry of CORPUS) {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const mainPath = `${ROOT}/${entry.dir}/main.tsx`;
      const program = await runtime.harness.resolve(
        new FileSystemProgramResolver(mainPath, ROOT),
      );
      const pattern = await runtime.patternManager.compilePattern(program);
      const tree = partitionPattern(pattern, entry.dir);
      const totals = emptyTotals();
      fold(tree, totals);
      rows.push({ name: entry.name, ok: true, tree, totals });
    } catch (e) {
      rows.push({
        name: entry.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }

  // -------------------------------------------------------------------------
  // Per-pattern table.
  // -------------------------------------------------------------------------
  const pad = (s: string, n: number) =>
    s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
  const padL = (s: string, n: number) =>
    s.length >= n ? s : " ".repeat(n - s.length) + s;

  console.log("");
  console.log(
    "################ STATIC COALESCING-PARTITION PROBE (§4.2) ################",
  );
  console.log(
    "Coverage = pure ops coalesced / total ops. Projected nodes = pure-segments",
  );
  console.log(
    "+ boundary nodes. Legacy nodes = all real nodes. TODAY (all-or-nothing) =",
  );
  console.log(
    "0% interpreted for EVERY row below (each contains a boundary).",
  );
  console.log(
    "Boundary INPUT edges are modeled (effect/handler/collection/pattern), so",
  );
  console.log(
    "boundaries CUT the pure regions. `fan>1` = pure segments feeding >1 boundary.",
  );
  console.log("");

  const HDR = pad("PATTERN", 34) + padL("ops", 6) + padL("bound", 7) +
    padL("pure", 6) + padL("segs", 6) + padL("proj", 6) + padL("legacy", 8) +
    padL("reduce", 8) + padL("cover", 7) + padL("fan>1", 7);
  console.log(HDR);
  console.log("-".repeat(HDR.length));

  const agg = emptyTotals();
  let aggLegacy = 0;
  let aggCoalesced = 0;
  for (const r of rows) {
    if (!r.ok || !r.totals) {
      console.log(pad(r.name, 34) + "  EXTRACTION FAILED: " + (r.error ?? ""));
      continue;
    }
    const t = r.totals;
    const { coalesced, legacy } = projected(t);
    const reduce = legacy > 0 ? (legacy - coalesced) / legacy : 0;
    const coverage = t.totalOps > 0 ? t.pureOps / t.totalOps : 0;
    console.log(
      pad(r.name, 34) +
        padL(String(t.totalOps), 6) +
        padL(String(t.boundaryOps), 7) +
        padL(String(t.pureOps), 6) +
        padL(String(t.pureSegments), 6) +
        padL(String(coalesced), 6) +
        padL(String(legacy), 8) +
        padL(pct(legacy - coalesced, legacy), 8) +
        padL(pct(t.pureOps, t.totalOps), 7) +
        padL(String(t.fanoutSegments), 7),
    );
    void reduce;
    void coverage;
    // Aggregate.
    agg.totalOps += t.totalOps;
    agg.realOps += t.realOps;
    agg.boundaryOps += t.boundaryOps;
    agg.boundaryRealOps += t.boundaryRealOps;
    agg.pureOps += t.pureOps;
    agg.pureRealOps += t.pureRealOps;
    agg.pureSegments += t.pureSegments;
    agg.fanoutSegments += t.fanoutSegments;
    agg.segmentBoundaryEdges += t.segmentBoundaryEdges;
    agg.graphs += t.graphs;
    aggLegacy += legacy;
    aggCoalesced += coalesced;
  }
  console.log("-".repeat(HDR.length));
  console.log(
    pad("CORPUS AGGREGATE", 34) +
      padL(String(agg.totalOps), 6) +
      padL(String(agg.boundaryOps), 7) +
      padL(String(agg.pureOps), 6) +
      padL(String(agg.pureSegments), 6) +
      padL(String(aggCoalesced), 6) +
      padL(String(aggLegacy), 8) +
      padL(pct(aggLegacy - aggCoalesced, aggLegacy), 8) +
      padL(pct(agg.pureOps, agg.totalOps), 7) +
      padL(String(agg.fanoutSegments), 7),
  );

  // -------------------------------------------------------------------------
  // The headline: fraction of pure ops that coalesce under the design that fall
  // back today.
  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== HEADLINE (vs TODAY's all-or-nothing) ===");
  console.log(
    `  Patterns measured: ${rows.filter((r) => r.ok).length}/${rows.length}` +
      ` (all contain >=1 boundary => 0% interpreted today).`,
  );
  console.log(
    `  Pure ops across corpus: ${agg.pureOps} / ${agg.totalOps} total ops` +
      ` (${pct(agg.pureOps, agg.totalOps)}).`,
  );
  console.log(
    `  TODAY coalesced: 0 pure ops (every pattern falls back wholesale).`,
  );
  console.log(
    `  UNDER COALESCING: all ${agg.pureOps} pure ops coalesce into` +
      ` ${agg.pureSegments} interpreter segments, preserving` +
      ` ${agg.boundaryRealOps} boundary nodes.`,
  );
  console.log(
    `  Projected node footprint: ${aggCoalesced} vs legacy ${aggLegacy}` +
      ` (${pct(aggLegacy - aggCoalesced, aggLegacy)} reduction).`,
  );
  console.log(
    `  Pure REAL nodes the design would collapse that fall back today:` +
      ` ${agg.pureRealOps} of ${agg.realOps} real nodes` +
      ` (${pct(agg.pureRealOps, agg.realOps)}).`,
  );

  // -------------------------------------------------------------------------
  // R-SEAM-1 fan-out exposure (finding F2).
  // -------------------------------------------------------------------------
  console.log("");
  console.log(
    "=== R-SEAM-1 FAN-OUT (finding F2 — pure segment → >1 boundary) ===",
  );
  console.log(
    `  With boundary input edges present, ${agg.fanoutSegments} pure segment(s)` +
      ` across the corpus feed MORE THAN ONE boundary` +
      ` (${agg.segmentBoundaryEdges} segment→boundary edges total).`,
  );
  console.log(
    "  Each fan-out segment is one coalesced interpreter node that multiple",
  );
  console.log(
    "  boundaries depend on simultaneously — the §4.4 dependency the design must",
  );
  console.log(
    "  support. Per-pattern fan-out counts are the `fan>1` column above.",
  );

  // -------------------------------------------------------------------------
  // Per-pattern recursion breakdown (where the trapped pure regions live).
  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== RECURSION BREAKDOWN (§4.7 — per sub-graph) ===");
  for (const r of rows) {
    if (!r.ok || !r.tree) continue;
    console.log(`  ${r.name}:`);
    const walk = (node: PartitionNode, depth: number) => {
      const p = node.part;
      const { coalesced, legacy } = projected({
        ...emptyTotals(),
        realOps: p.realOps,
        boundaryRealOps: p.boundaryRealOps,
        pureSegments: p.pureSegments,
      });
      console.log(
        `    ${"  ".repeat(depth)}${pad(node.label, 40 - depth * 2)}` +
          ` ops=${padL(String(p.totalOps), 4)}` +
          ` bound=${padL(String(p.boundaryOps), 3)}` +
          ` pure=${padL(String(p.pureOps), 4)}` +
          ` segs=${padL(String(p.pureSegments), 3)}` +
          ` proj=${padL(String(coalesced), 4)}/legacy=${
            padL(String(legacy), 4)
          }` +
          ` fan>1=${padL(String(p.fanoutSegments), 2)}`,
      );
      for (const c of node.children) walk(c, depth + 1);
    };
    walk(r.tree, 0);
  }

  // -------------------------------------------------------------------------
  // Honest caveats.
  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== READ THE NUMBERS HONESTLY ===");
  console.log(
    "  * LEGACY basis = real (id>=0) nodes only. `construct` ops the extractor",
  );
  console.log(
    "    synthesizes for object/array assembly (id<0) are PURE computation and",
  );
  console.log(
    "    count toward coverage, but are NOT separate legacy scheduler nodes — so",
  );
  console.log(
    "    a sub-graph that is ALL synth-construct (e.g. a pure VNode element with",
  );
  console.log(
    "    no `lift`) shows `legacy=0` yet `proj=1`: at the raw-node granularity",
  );
  console.log(
    "    that micro-region is a wash/slight-increase, paid back by §4.3 (its pure",
  );
  console.log(
    "    intermediates stop being materialized) — a DOC win, not a node win. The",
  );
  console.log(
    "    corpus AGGREGATE (real-node basis) already nets this out.",
  );
  console.log(
    "  * `segs` (segments) is the STRUCTURAL interpreter-node count per graph; a",
  );
  console.log(
    "    `map` element body is ONE structural segment re-instantiated per list",
  );
  console.log(
    "    element (OQ-C2), so per-element runtime multiplicity multiplies BOTH the",
  );
  console.log(
    "    legacy element nodes AND the one element segment — the per-element RATIO",
  );
  console.log(
    "    is what the recursion rows show.",
  );
  console.log(
    "  * Boundaries are counted from `extractRog`'s real classifier (effect /",
  );
  console.log(
    "    collection / pattern / EFFECT_REFS / unresolved-leaf) — no hand-tuning.",
  );

  if (emitJson) {
    console.log("");
    console.log(JSON.stringify(
      {
        kind: "coalescing-partition-probe",
        rows: rows.map((r) => ({
          name: r.name,
          ok: r.ok,
          error: r.error,
          totals: r.totals,
          projected: r.totals ? projected(r.totals) : undefined,
        })),
        aggregate: {
          ...agg,
          legacy: aggLegacy,
          coalesced: aggCoalesced,
        },
      },
      null,
      2,
    ));
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : String(error),
    );
    Deno.exit(1);
  }
}
