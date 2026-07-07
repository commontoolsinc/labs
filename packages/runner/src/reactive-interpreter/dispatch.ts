/**
 * Flag-on DISPATCH planning — decide whether a pattern instantiation runs
 * through the interpreter, and emit the synthetic node plan the runner
 * instantiates instead of the legacy per-node loop.
 *
 * MULTI-SEGMENT EMISSION (v1 07 §4 realized): each maximal pure region
 * becomes ONE synthetic `{ type: "raw" }` node; every boundary op (handler /
 * effect / control / collection / nested pattern / untrusted or
 * capability-bearing leaf) keeps its ORIGINAL serialized node, instantiated
 * VERBATIM. Because segments write their ops' ORIGINAL output aliases and
 * boundaries read their ORIGINAL input aliases, the legacy alias topology IS
 * the document wiring — no container-of-links, no multi-value fan-out
 * primitive, no read-through machinery: a segment feeding three boundaries
 * just writes the three internal cells those boundaries already alias
 * (v1's F1/F2/F3 findings dissolve by construction).
 *
 * Cross-segment values ride the same way: a segment READS an upstream
 * boundary/segment op's output through that op's original output alias and
 * SEEDS the evaluator with it. Construct ops (synthesized input/result
 * trees, no legacy alias) are pulled into every segment that references
 * them — pure, cheap, duplication is sound.
 *
 * FAIL-CLOSED: pattern-wide fallback only for no-ROG / incomplete ROG /
 * scope markers / unpartitionable / nothing-to-collapse. Everything else
 * demotes the specific op to a boundary. The census is the honest
 * engagement metric (collapsed node-ops / total node-ops).
 */

import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "../cell.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Frame, Module, Pattern } from "../builder/types.ts";
import { popFrame } from "../builder/pattern.ts";
import {
  type BuiltRog,
  getBuiltRog,
  getBuiltRogResolved,
} from "./from-builder.ts";
import { partition, type Segment } from "./partition.ts";
import { type EvalContext, evalRog } from "./interpret.ts";
import { ri2SetOutputScopes } from "./builtin-markers.ts";
import { scopeRank } from "../scope.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { CellScope } from "../builder/types.ts";
import { inputsOf, type Op, type OpId, type Rog } from "./rog.ts";
import {
  elementArgumentUsage,
  makeInlineFilterImplementation,
  makeInlineMapImplementation,
} from "./collection-inline.ts";

const logger = getLogger("runner.reactive-interpreter", {
  enabled: false,
  level: "info",
});

/** Env-gated dispatch tracing (RI2_DEBUG=1): one line per decision. */
const RI2_DEBUG = (() => {
  try {
    return Deno.env.get("RI2_DEBUG") === "1";
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Census — the progress metric (never "green via fallback" unnoticed).
// ---------------------------------------------------------------------------

export interface DispatchCensus {
  attempted: number;
  interpreted: number;
  fallbackByReason: Record<string, number>;
  /** Node-derived ops seen across interpreted patterns. */
  nodeOpsSeen: number;
  /** Node-derived ops collapsed into segments (the engagement numerator). */
  nodeOpsCollapsed: number;
  /** Boundary ops preserved as verbatim legacy nodes, by kind. */
  boundariesByKind: Record<string, number>;
  /** Collection ops evaluated SEGMENT-RESIDENT (transient, zero docs —
   * D-V2-TRANSIENT-COLLECTIONS) across interpreted patterns. */
  transientCollections: number;
}

const census: DispatchCensus = {
  attempted: 0,
  interpreted: 0,
  fallbackByReason: {},
  nodeOpsSeen: 0,
  nodeOpsCollapsed: 0,
  boundariesByKind: {},
  transientCollections: 0,
};

export function getDispatchCensus(): DispatchCensus {
  return census;
}

export function resetDispatchCensus(): void {
  census.attempted = 0;
  census.interpreted = 0;
  census.fallbackByReason = {};
  census.nodeOpsSeen = 0;
  census.nodeOpsCollapsed = 0;
  census.boundariesByKind = {};
  census.transientCollections = 0;
}

// ---------------------------------------------------------------------------
// Plan shape the runner consumes.
// ---------------------------------------------------------------------------

/** One node the runner feeds through `instantiateNode` — either a synthetic
 * segment node or a VERBATIM original boundary node. */
export interface SyntheticNode {
  module: Module;
  inputs: unknown;
  outputs: unknown;
}

export type DispatchPlan =
  | { kind: "interpret"; nodes: SyntheticNode[] }
  | { kind: "fallback"; reason: string };

export interface DispatchOptions {
  /** SECURITY gate (the legacy `resolveJavaScriptFunction` liveTrusted test,
   * runner-supplied): a captured live leaf impl may run in the interpreter
   * ONLY if it passes — an untrusted callback DEMOTES to a verbatim legacy
   * node, where the SES fallback sandboxes it. */
  leafTrust: (fn: (input: unknown) => unknown) => boolean;
  /** Create the pattern frame the segment action runs in (the legacy
   * `createPatternFrame`): gives leaf bodies the runtime context legacy
   * actions have AND carries the piece metadata `handleSchedulerError`
   * reads off `error.frame`. The dispatch pops it via `popFrame`. */
  actionFrame: (tx: IExtendedStorageTransaction, cause: unknown) => Frame;
  /** Resumed-from-synced-state instantiation (the runner's
   * `awaitSyncBeforeInitialRun`): inline collection coordinators refuse and
   * the ORIGINAL legacy nodes instantiate — the resume/recovery machinery
   * (stale-basis republish, armed recoveries, per-element doc awaits) is
   * the battle-tested legacy path, and a degrade INSIDE a synthetic wrapper
   * is not byte-identical to a legacy-instantiated node. Segments are
   * unaffected (they re-derive; covered by the reload suites). */
  resumed?: boolean;
}

/** Declared scope routing on a pattern/module-like object: a child that
 * declares its OWN result scope (or a cross-space target) must stay a real
 * instantiation — the legacy child machinery applies these; in-memory
 * value evaluation has nowhere to. */
function declaresScopeRouting(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") return false;
  const c = candidate as {
    defaultScope?: unknown;
    targetSpace?: unknown;
    resultSchema?: { scope?: unknown } | undefined;
  };
  if (c.defaultScope !== undefined && c.defaultScope !== "space") return true;
  if (c.targetSpace !== undefined) return true;
  const schemaScope = c.resultSchema?.scope;
  return schemaScope !== undefined && schemaScope !== "space";
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s && s.length > 400 ? s.slice(0, 400) + "…" : s ?? "undefined";
  } catch {
    return "<unserializable>";
  }
}

function fallback(reason: string): DispatchPlan {
  const key = reason.split(":")[0];
  census.fallbackByReason[key] = (census.fallbackByReason[key] ?? 0) + 1;
  logger.info("fallback", () => [reason]);
  if (RI2_DEBUG) console.log(`[ri2] fallback: ${reason}`);
  return { kind: "fallback", reason };
}


/**
 * Plan the interpreter instantiation for one pattern, or fall back.
 * Pure decision + closure construction; no runtime side effects.
 */
export function planInterpreterDispatch(
  pattern: Pattern,
  options: DispatchOptions,
): DispatchPlan {
  census.attempted++;

  // STRICT lookup only (direct WeakMap key — the ROG's op ids are POSITIONAL
  // against this exact object's `pattern.nodes`). Referenced patterns reach
  // instantiation as their LIVE canonical: authored sub-patterns bind as a
  // `$patternRef` resolved back to the builder-keyed object (pattern-binding
  // `unwrapOneLevelAndBindtoDoc`), and reload re-runs the factory. A ref-less
  // hand-built / bare-Engine pattern is the only thing that can arrive as a
  // derived COPY (strict miss); it simply runs legacy (`no_rog`) — a correct,
  // fail-safe fallback, not a wrong answer.
  const built = getBuiltRog(pattern);
  if (!built) return fallback("no_rog");
  if (built.rog.incomplete?.length) {
    return fallback(`incomplete:${built.rog.incomplete.join(",")}`);
  }

  // SCOPE handling (scope flow-tracking): no pattern-wide gate. Every
  // consumer of STATIC scope markers is either a BOUNDARY the interpreter
  // instantiates verbatim (raw builtins fold module.defaultScope /
  // resultSchema.scope into their output binding; pattern nodes scope
  // their child result cells; frame-result javascript lifts are
  // capability-demoted to gated-leaf boundaries) or the SHARED binding
  // write machinery segments already use (alias-folded schema scopes via
  // scopedLinkForPath). Simple-path lifts — the only thing segments
  // replace — take scope ONLY from the narrowest READ scope in legacy,
  // which segments now track PER OP. The two spots where the interpreter
  // replaces child instantiation (value-consumed pattern inlining,
  // collection element inlining) refuse scope-declaring children below.

  // Demote gated leaves to boundaries: untrusted impls (SECURITY — the
  // verbatim legacy node applies its own SES/trust resolution) and
  // capability-bearing bodies (need handles / builder frames / may
  // instantiate patterns — all things the legacy javascript action provides).
  const boundaryLeafOps = new Set<OpId>();
  for (const op of built.rog.ops) {
    if (op.detail.kind !== "leaf") continue;
    const impl = built.leafImpls.get(op.id);
    if ((impl && !options.leafTrust(impl)) || op.detail.caps) {
      boundaryLeafOps.add(op.id);
    }
  }

  // CONSUMED-AS-VALUE analysis (W6 patterns + D-V2-TRANSIENT-COLLECTIONS):
  // a `pattern` op whose child is fully inlinable, or a `collection` op
  // whose element is fully inlinable, whose output is never RETAINED (no
  // direct reference from the result tree or any effect/boundary op —
  // those need an addressable PIECE) evaluates in-segment via evalRog —
  // zero child/container/per-element docs. Fixpoint: an admitted candidate
  // stops retaining its own inputs, so chained pipelines
  // (`items.filter(..).map(..)` feeding a lift) cascade.
  const { inlinablePatternOps, inlineCollections } = findValueConsumedOps(
    built,
    options.leafTrust,
    pattern.nodes,
  );

  const part = partition({
    built,
    boundaryLeafOps,
    inlinablePatternOps,
    inlinableCollectionOps: new Set(inlineCollections.keys()),
  });
  if (!part.partitionable) return fallback(`unpartitionable:${part.reason}`);

  // Build one synthetic node per segment that collapses ≥1 node-derived op.
  const nodes: SyntheticNode[] = [];
  const collapsed = new Set<OpId>();
  for (const segment of part.segments) {
    const seg = buildSegmentNode(
      pattern,
      built,
      segment,
      options,
      inlineCollections,
    );
    if (seg === null) continue; // constructs-only segment: nothing to emit
    if (typeof seg === "string") return fallback(seg);
    nodes.push(seg.node);
    for (const id of seg.nodeOps) collapsed.add(id);
  }

  // Boundaries: the ORIGINAL nodes verbatim — except an ELIGIBLE `map`
  // boundary, which swaps its coordinator for the INLINE one (per-element
  // evalRog over the LIVE element BuiltRog; one result doc + one effect per
  // element instead of a whole child pattern). Same inputs/outputs bindings
  // either way, so reads/writes/identity stay legacy-shaped.
  const boundaryKinds: string[] = [];
  let inlinedCollections = 0;
  for (const b of part.boundaries) {
    const original = pattern.nodes[b.opId];
    if (!original) return fallback(`boundary_without_node:${b.opId}`);
    const inline = b.kind === "collection"
      ? tryBuildInlineCollectionNode(built, b.opId, original, options)
      : undefined;
    if (inline) inlinedCollections++;
    nodes.push(
      inline ?? {
        module: original.module as Module,
        inputs: original.inputs,
        outputs: original.outputs,
      },
    );
    boundaryKinds.push(inline ? "collection-inlined" : b.kind);
  }

  // COST GATE: collapsing fewer than two node actions is neutral at best
  // (1→1) — UNLESS a collection inlined (a per-element win of ~3 docs +
  // ~4 nodes per element all by itself).
  if (collapsed.size < 2 && inlinedCollections === 0) {
    return fallback(`nothing_to_collapse:${collapsed.size}`);
  }
  for (const kind of boundaryKinds) {
    census.boundariesByKind[kind] = (census.boundariesByKind[kind] ?? 0) + 1;
  }

  census.interpreted++;
  census.nodeOpsSeen += pattern.nodes.length;
  census.nodeOpsCollapsed += collapsed.size;
  census.transientCollections += inlineCollections.size;
  if (RI2_DEBUG) {
    console.log(
      `[ri2] interpret: nodes=${pattern.nodes.length} ` +
        `collapsed=${collapsed.size} segments=${
          nodes.length - part.boundaries.length
        } boundaries=${part.boundaries.length}`,
    );
  }
  return { kind: "interpret", nodes };
}

// ---------------------------------------------------------------------------
// Consumed-as-value nested-pattern analysis (W6).
// ---------------------------------------------------------------------------

/** Value-consumed candidates that are safe to inline into segments:
 *   - nested `pattern` ops with a fully-inlinable child (W6);
 *   - `collection` ops with a fully-inlinable element
 *     (D-V2-TRANSIENT-COLLECTIONS — the whole map/filter/flatMap evaluates
 *     in-memory; zero container/per-element docs).
 * A candidate survives iff every reference to its output is a VALUE
 * consumption by a pure op. Retention sites (→ boundary, the piece
 * contract):
 *   - the result tree (the op's result cell is the pattern's observable);
 *   - any BOUNDARY effect/collection/pattern op's refs (a handler can
 *     push/retain; a materialized coordinator passes element CELLS);
 *   - a construct that is itself retained (transitively).
 * FIXPOINT: an ADMITTED candidate is a pure value consumer — it does NOT
 * retain its own inputs — so chained pipelines cascade; a candidate that
 * turns out retained reverts to a boundary (and its refs retain again),
 * shrinking monotonically until stable.
 */
interface InlineTransientCollection {
  elementBuilt: BuiltRog;
  usage: ReturnType<typeof elementArgumentUsage>;
}

function findValueConsumedOps(
  built: BuiltRog,
  leafTrust: DispatchOptions["leafTrust"],
  nodes: Pattern["nodes"],
): {
  inlinablePatternOps: Set<OpId>;
  inlineCollections: Map<OpId, InlineTransientCollection>;
} {
  const rog = built.rog;
  const patternCands = new Set<OpId>();
  const collectionCands = new Map<OpId, InlineTransientCollection>();
  for (const op of rog.ops) {
    if (op.detail.kind === "pattern") {
      const child = built.children.get(op.id);
      if (!child || !rogFullyInlinable(child, leafTrust)) continue;
      // Scope-declaring children stay REAL instantiations (the legacy
      // pattern-node machinery scopes their result cells; in-memory value
      // evaluation has nowhere to).
      const module = nodes[op.id]?.module as
        | { implementation?: unknown }
        | undefined;
      if (
        declaresScopeRouting(module) ||
        declaresScopeRouting(module?.implementation)
      ) {
        continue;
      }
      patternCands.add(op.id);
    } else if (op.detail.kind === "collection") {
      const factory = built.collectionElements.get(op.id);
      if (factory === undefined) continue;
      if (declaresScopeRouting(factory)) continue;
      const elementBuilt = getBuiltRogResolved(factory);
      if (!elementBuilt || !rogFullyInlinable(elementBuilt, leafTrust)) {
        continue;
      }
      collectionCands.set(op.id, {
        elementBuilt,
        usage: elementArgumentUsage(elementBuilt),
      });
    }
  }
  const candidates = new Set<OpId>([
    ...patternCands,
    ...collectionCands.keys(),
  ]);
  if (candidates.size === 0) {
    return { inlinablePatternOps: patternCands, inlineCollections: new Map() };
  }

  // Producer of a ref (op id), or undefined for argument/const/result refs.
  const producerOf = (
    ref: import("./rog.ts").ValueRef,
  ): OpId | undefined => {
    if (ref.kind === "opOut") return ref.op;
    if (ref.kind === "internal") {
      return rog.internals[ref.cell]?.producedBy;
    }
    return undefined;
  };

  const computeRetained = (): Set<OpId> => {
    const retained = new Set<OpId>();
    const retain = (ref: import("./rog.ts").ValueRef) => {
      const producer = producerOf(ref);
      if (producer === undefined || retained.has(producer)) return;
      const op = rog.ops[producer];
      if (!op) return;
      if (op.detail.kind === "construct") {
        // The construct VALUE is retained ⇒ every op it references is too.
        retained.add(producer);
        for (const r of dependencyRefsOf(op)) retain(r);
      } else if (
        op.detail.kind === "pattern" || op.detail.kind === "collection"
      ) {
        retained.add(producer);
      }
      // Other pure producers (leaf/expr/...) already consumed candidate
      // values — their OUTPUT being retained does not retain the candidate.
    };

    retain(rog.result);
    for (const op of rog.ops) {
      const d = op.detail;
      const boundaryRetainer = d.kind === "effect" ||
        ((d.kind === "collection" || d.kind === "pattern") &&
          !candidates.has(op.id));
      if (!boundaryRetainer) continue;
      for (const ref of dependencyRefsOf(op)) retain(ref);
      if (d.kind === "effect") {
        for (const ref of d.writeTargets) retain(ref);
      }
    }
    return retained;
  };

  while (candidates.size > 0) {
    const retained = computeRetained();
    let changed = false;
    for (const id of [...candidates]) {
      if (retained.has(id)) {
        candidates.delete(id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    inlinablePatternOps: new Set(
      [...patternCands].filter((id) => candidates.has(id)),
    ),
    inlineCollections: new Map(
      [...collectionCands].filter(([id]) => candidates.has(id)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Inline-collection emission (W5).
// ---------------------------------------------------------------------------

/** Every op in this ROG is pure, resolvable, trusted, caps-clean — safe for
 * whole-child in-memory evaluation. */
function rogFullyInlinable(
  built: BuiltRog,
  leafTrust: DispatchOptions["leafTrust"],
): boolean {
  if (built.rog.incomplete?.length) return false;
  // Whole-child in-memory evaluation has no external-cell seeding yet.
  if (built.rog.externals?.length) return false;
  for (const op of built.rog.ops) {
    const d = op.detail;
    if (d.kind === "leaf") {
      const impl = built.leafImpls.get(op.id);
      if (!impl || !leafTrust(impl) || d.caps) return false;
      continue;
    }
    if (d.kind === "pattern") {
      const child = built.children.get(op.id);
      if (!child || !rogFullyInlinable(child, leafTrust)) return false;
      continue;
    }
    if (
      d.kind === "effect" || d.kind === "collection" || d.kind === "call"
    ) {
      return false;
    }
    if (d.kind === "control") return false; // link semantics (boundary-only)
  }
  return true;
}

/** Swap an eligible `map` boundary's coordinator for the inline one. Returns
 * undefined when ineligible (verbatim legacy coordinator — whose per-element
 * children still hit the serialization boundary and run full legacy). */
function tryBuildInlineCollectionNode(
  built: BuiltRog,
  opId: OpId,
  original: { module: unknown; inputs: unknown; outputs: unknown },
  options: DispatchOptions,
): SyntheticNode | undefined {
  const refuse = (why: string): undefined => {
    if (RI2_DEBUG) console.log(`[ri2] map-inline refused: ${why}`);
    return undefined;
  };
  const op = built.rog.ops[opId];
  if (op?.detail.kind !== "collection") {
    return refuse(`not_collection:${op?.detail.kind}`);
  }
  // Resumed instantiation → the ORIGINAL legacy node, byte-identical to
  // flag-off (see DispatchOptions.resumed).
  if (options.resumed) return refuse("resumed");
  const collectionOp = op.detail.op;
  if (collectionOp !== "map" && collectionOp !== "filter") {
    return refuse(`op_pending:${collectionOp}`); // flatMap stays legacy
  }
  const elementFactory = built.collectionElements.get(opId);
  if (elementFactory === undefined) return refuse("no_element_factory");
  // A scope-declaring element pattern stays on the LEGACY coordinator: its
  // child runs scope their result cells; the inline per-element writes
  // would not.
  if (declaresScopeRouting(elementFactory)) return refuse("element_scoped");
  const elementBuilt = getBuiltRogResolved(elementFactory);
  if (!elementBuilt) return refuse("element_no_rog");
  if (!rogFullyInlinable(elementBuilt, options.leafTrust)) {
    return refuse("element_not_inlinable");
  }
  const usage = elementArgumentUsage(elementBuilt);
  if (RI2_DEBUG) {
    console.log(
      `[ri2] map-inline usage=${JSON.stringify(usage)} elementOps=${
        JSON.stringify(
          elementBuilt.rog.ops.map((o) => ({
            k: o.kind,
            in: o.inputs,
            d: o.detail.kind === "construct" ? o.detail.template : undefined,
          })),
        ).slice(0, 600)
      } result=${JSON.stringify(elementBuilt.rog.result)}`,
    );
  }
  // `array` hands the child the whole list cell — incompatible with
  // per-element read isolation; keep those on the legacy coordinator.
  if (usage.usesArray) return refuse("uses_array");

  const elementResultSchema = (elementFactory as { resultSchema?: unknown })
    .resultSchema as
      | undefined
      | Record<string, unknown>;

  const implementation = collectionOp === "map"
    ? makeInlineMapImplementation(
      elementBuilt,
      elementFactory,
      elementResultSchema as never,
      usage,
    )
    : makeInlineFilterImplementation(elementBuilt, elementFactory, usage);

  return {
    module: {
      type: "raw",
      implementation,
      debugName: `ri2:${collectionOp}-inline`,
    } as unknown as Module,
    // The op carried in these inputs keeps the CT-1623 by-identity protocol
    // automatically: `unwrapOneLevelAndBindtoDoc`'s `convert` replaces any
    // pattern-valued input with a `{ $patternRef }` sentinel at bind time
    // (compact through the session artifact index; loud on miss), so this raw
    // node needs no special-casing.
    inputs: original.inputs,
    outputs: original.outputs,
  };
}

// ---------------------------------------------------------------------------
// Segment node emission.
// ---------------------------------------------------------------------------

interface SegmentEmission {
  node: SyntheticNode;
  /** The node-derived ops this segment collapses. */
  nodeOps: OpId[];
}

/** Full dependency refs of an op (inputsOf + construct template leaves). */
function dependencyRefsOf(op: Op) {
  const refs = [...inputsOf(op)];
  if (op.detail.kind === "construct") {
    const t = op.detail.template;
    refs.push(
      ...(t.shape === "object" ? Object.values(t.fields) : t.items),
    );
  }
  return refs;
}

function buildSegmentNode(
  pattern: Pattern,
  built: BuiltRog,
  segment: Segment,
  options: DispatchOptions,
  inlineCollections: ReadonlyMap<OpId, InlineTransientCollection>,
): SegmentEmission | null | string {
  const rog = built.rog;
  const nodeCount = pattern.nodes.length;
  const opById = new Map<OpId, Op>(rog.ops.map((o) => [o.id, o]));

  const segmentNodeOps = segment.opIds.filter((id) => id < nodeCount);
  if (segmentNodeOps.length === 0) return null;

  // Assemble the sub-ROG: the segment's node ops plus every construct op
  // they (transitively) reference — constructs have no legacy alias, so they
  // are recomputed wherever needed (pure; duplication across segments is
  // sound). Collect external node-op reads + externally-written internals
  // along the way.
  const include = new Set<OpId>(segmentNodeOps);
  const externalOps = new Set<OpId>();
  const internalReads = new Set<number>();
  const externalReads = new Set<number>();
  let readsArgument = false;

  const queue = [...segmentNodeOps];
  while (queue.length > 0) {
    const op = opById.get(queue.pop()!);
    if (!op) return `missing_op_in_rog`;
    for (const ref of dependencyRefsOf(op)) {
      if (ref === undefined) continue;
      if (ref.kind === "argument") {
        readsArgument = true;
      } else if (ref.kind === "opOut") {
        if (include.has(ref.op)) continue;
        if (ref.op >= nodeCount) {
          // A construct op: pull it into this segment and keep walking.
          include.add(ref.op);
          queue.push(ref.op);
        } else {
          externalOps.add(ref.op);
        }
      } else if (ref.kind === "internal") {
        const decl = rog.internals[ref.cell];
        if (!decl) return `internal_ref_out_of_range:${ref.cell}`;
        if (decl.producedBy === undefined) {
          internalReads.add(ref.cell);
        } else if (!include.has(decl.producedBy)) {
          if (decl.producedBy >= nodeCount) {
            include.add(decl.producedBy);
            queue.push(decl.producedBy);
          } else {
            externalOps.add(decl.producedBy);
          }
        }
      } else if (ref.kind === "external") {
        if (!rog.externals || rog.externals[ref.cell] === undefined) {
          return `external_ref_out_of_range:${ref.cell}`;
        }
        externalReads.add(ref.cell);
      } else if (ref.kind === "result") {
        return "result_self_reference";
      }
    }
  }

  const subRog: Rog = {
    v: rog.v,
    argumentSchema: rog.argumentSchema,
    resultSchema: rog.resultSchema,
    // Per-op alias writes carry the outputs; no single result egress here.
    result: { kind: "const", value: undefined },
    ops: [...include].sort((a, b) => a - b).map((id) => opById.get(id)!),
    internals: rog.internals,
  };

  // FULLY-EXTERNAL leaves read their ORIGINAL input alias tree through their
  // own argumentSchema (legacy readJavaScriptArgument semantics — schema
  // defaults + validation; a transiently-partial upstream value resolves the
  // way legacy resolves it, instead of a raw deep-read that throws in the
  // leaf body). A leaf chained to an intra-segment producer keeps in-memory
  // resolution (its input is derived this very action; the cells are stale).
  const schemaBoundLeaves: Array<{ id: OpId; schema: unknown }> = [];
  for (const id of segmentNodeOps) {
    const op = opById.get(id)!;
    if (op.detail.kind !== "leaf" || op.inputs.length === 0) continue;
    let externalOnly = true;
    const walk = [...dependencyRefsOf(op)];
    while (walk.length > 0 && externalOnly) {
      const ref = walk.pop()!;
      if (ref.kind === "opOut") {
        if (include.has(ref.op)) {
          if (ref.op >= nodeCount) {
            // A construct re-derivation of the original tree — descend.
            walk.push(...dependencyRefsOf(opById.get(ref.op)!));
          } else {
            externalOnly = false;
          }
        }
      } else if (ref.kind === "internal") {
        const producer = rog.internals[ref.cell]?.producedBy;
        if (producer !== undefined && include.has(producer)) {
          externalOnly = false;
        }
      }
    }
    if (externalOnly) {
      schemaBoundLeaves.push({
        id,
        schema: built.leafArgSchemas.get(id),
      });
    }
  }

  // INPUTS binding: whole argument when read (per-path narrowing is the
  // D-V2-READSETS follow-up), externally-written internals by cause, and
  // upstream boundary/segment op outputs through their ORIGINAL aliases.
  const inputs: Record<string, unknown> = {};
  if (readsArgument) {
    inputs.argument = { $alias: { cell: "argument", path: [] } };
  }
  if (internalReads.size > 0) {
    const internals: Record<string, unknown> = {};
    for (const idx of internalReads) {
      internals[String(idx)] = {
        $alias: { partialCause: rog.internals[idx].partialCause, path: [] },
      };
    }
    inputs.internals = internals;
  }
  if (externalReads.size > 0) {
    // The stored reference is EXACTLY what legacy writes for the cell in a
    // node binding (toJSONWithLegacyAliases external passthrough).
    const externals: Record<string, unknown> = {};
    for (const idx of externalReads) {
      externals[String(idx)] = rog.externals![idx];
    }
    inputs.externals = externals;
  }
  if (externalOps.size > 0) {
    const ops: Record<string, unknown> = {};
    for (const id of externalOps) {
      ops[String(id)] = pattern.nodes[id].outputs;
    }
    inputs.ops = ops;
  }
  if (schemaBoundLeaves.length > 0) {
    const leafInputs: Record<string, unknown> = {};
    for (const { id } of schemaBoundLeaves) {
      leafInputs[String(id)] = pattern.nodes[id].inputs;
    }
    inputs.leafInputs = leafInputs;
  }

  // OUTPUTS binding: this segment's node ops write their ORIGINAL aliases.
  const outputs: Record<string, unknown> = {};
  for (const opId of segmentNodeOps) {
    outputs[String(opId)] = pattern.nodes[opId].outputs;
  }

  const implementation = makeSegmentImplementation(
    built,
    subRog,
    segmentNodeOps,
    [...externalOps],
    schemaBoundLeaves,
    segment.id,
    options,
    inlineCollections,
    {
      readsArgument,
      internalKeys: [...internalReads],
      externalKeys: [...externalReads],
    },
  );

  return {
    node: {
      module: {
        type: "raw",
        implementation,
        debugName: `ri2:${segment.id}`,
        // PER-OP effective-scope routing (scope flow-tracking): the
        // implementation derives one scope per collapsed op from the
        // scopes of the values that op consumed; the runner's send seam
        // routes each output key at its own scope — legacy per-node-action
        // parity (a single tx-ambient scope would over-narrow siblings).
        ri2PerOpOutputScopes: true,
      } as unknown as Module,
      inputs,
      outputs,
    },
    nodeOps: segmentNodeOps,
  };
}

/** The raw-builtin implementation for one segment: seed external reads,
 * evaluate the sub-ROG, write every collapsed op's value through its
 * original alias in ONE action. */
function makeSegmentImplementation(
  built: BuiltRog,
  subRog: Rog,
  outputOpIds: OpId[],
  externalOpIds: OpId[],
  schemaBoundLeaves: Array<{ id: OpId; schema: unknown }>,
  segmentId: string,
  options: DispatchOptions,
  inlineCollections: ReadonlyMap<OpId, InlineTransientCollection>,
  io: {
    readsArgument: boolean;
    internalKeys: number[];
    externalKeys: number[];
  },
) {
  return function reactiveInterpreterSegment(
    inputsCell: Cell<{
      argument?: unknown;
      internals?: Record<string, unknown>;
      externals?: Record<string, unknown>;
      ops?: Record<string, unknown>;
      leafInputs?: Record<string, unknown>;
    }>,
    sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    _addCancel: unknown,
    _cause: unknown,
    _parentCell: unknown,
    _runtime: unknown,
    _outputBinding: unknown,
    _awaitSync?: boolean,
  ) {
    return (tx: IExtendedStorageTransaction) => {
      // The pattern frame gives leaf bodies the same runtime context legacy
      // actions run in, and carries the piece metadata the scheduler's
      // handleSchedulerError reads off `error.frame`.
      const frame = options.actionFrame(tx, { ri2Segment: segmentId });
      let firstError: unknown;
      try {
        // SCOPE attribution (scope flow-tracking), three complementary
        // mechanisms — none of which change the segment's JOURNAL (the
        // read set must stay byte-identical to the pre-scope emission, or
        // re-run reactivity changes):
        //  (1) values come from ONE bulk inputs read (as before);
        //  (2) each seed key's scope = the scope its binding RESOLVES to
        //      (bare resolveLink — its probes belong to the dereferences
        //      it records, so neither scheduling nor CFC flow sees extra
        //      reads);
        //  (3) lazy derefs inside op bodies (query-result proxies) are
        //      caught by the per-op run bracket handed to evalRog.
        tx.resetNarrowestReadScope();
        const rt = _runtime as {
          // deno-lint-ignore no-explicit-any
          getCellFromLink: (...args: any[]) => unknown;
        };
        const scopeOfBinding = (cell: {
          getAsNormalizedFullLink: () => NormalizedFullLink;
        }): CellScope => {
          try {
            const resolved = resolveLink(
              // deno-lint-ignore no-explicit-any
              rt as any,
              tx,
              cell.getAsNormalizedFullLink(),
              "value",
            );
            return (resolved.scope ?? "space") as CellScope;
          } catch {
            return "space";
          }
        };
        const inputs = inputsCell.withTx(tx);
        const bound = inputsCell.withTx(tx).get() ?? {};
        const argument = bound.argument;
        const argumentScope: CellScope = io.readsArgument
          ? scopeOfBinding(inputs.key("argument"))
          : "space";
        const seed = new Map<OpId, unknown>();
        const byOp = new Map<OpId, CellScope>();
        for (const id of externalOpIds) {
          seed.set(id, bound.ops?.[String(id)]);
          byOp.set(id, scopeOfBinding(inputs.key("ops").key(String(id))));
        }
        const seedByInternal = new Map<number, unknown>();
        const byInternal = new Map<number, CellScope>();
        for (const idx of io.internalKeys) {
          seedByInternal.set(idx, bound.internals?.[String(idx)]);
          byInternal.set(
            idx,
            scopeOfBinding(inputs.key("internals").key(String(idx))),
          );
        }
        const seedByExternal = new Map<number, unknown>();
        const byExternal = new Map<number, CellScope>();
        for (const idx of io.externalKeys) {
          seedByExternal.set(idx, bound.externals?.[String(idx)]);
          byExternal.set(
            idx,
            scopeOfBinding(inputs.key("externals").key(String(idx))),
          );
        }
        // Fully-external leaves: read the ORIGINAL alias tree through the
        // leaf's own argumentSchema (legacy readJavaScriptArgument). These
        // reads existed before scope-tracking (same journal); the bracket
        // only attributes their observed scope.
        const captureScope = <T>(read: () => T): [T, CellScope] => {
          const prev = tx.getNarrowestReadScope();
          tx.resetNarrowestReadScope();
          let observed: CellScope = "space";
          try {
            const v = read();
            observed = tx.getNarrowestReadScope();
            return [v, observed];
          } finally {
            observed = tx.getNarrowestReadScope();
            tx.resetNarrowestReadScope(
              scopeRank(observed) > scopeRank(prev) ? observed : prev,
            );
          }
        };
        const leafInputOverrides = new Map<OpId, unknown>();
        const byLeafInput = new Map<OpId, CellScope>();
        for (const { id, schema } of schemaBoundLeaves) {
          const at = inputsCell.key("leafInputs").key(String(id));
          const [value, sc] = captureScope(() =>
            schema !== undefined
              ? (at as unknown as {
                asSchema: (s: unknown) => Cell<unknown>;
              }).asSchema(schema).withTx(tx).get()
              : at.withTx(tx).get()
          );
          leafInputOverrides.set(id, value);
          byLeafInput.set(id, sc);
        }
        const { opValues, errors, opScopes } = evalRog(subRog, {
          argument,
          leafImpls: built.leafImpls,
          children: built.children,
          collections: inlineCollections as EvalContext["collections"],
          seed,
          seedByInternal,
          seedByExternal,
          leafInputOverrides,
          scopes: {
            argument: argumentScope,
            byOp,
            byInternal,
            byExternal,
            byLeafInput,
          },
          // Lazy leaf-input derefs read through the tx DURING op bodies —
          // bracket each op run so those reads attribute to the right op.
          runScoped: (fn, onScope) => {
            const prev = tx.getNarrowestReadScope();
            tx.resetNarrowestReadScope();
            try {
              return fn();
            } finally {
              const observed = tx.getNarrowestReadScope();
              onScope(observed);
              tx.resetNarrowestReadScope(
                scopeRank(observed) > scopeRank(prev) ? observed : prev,
              );
            }
          },
        });
        const out: Record<string, unknown> = {};
        const outScopes: Record<string, string> = {};
        for (const opId of outputOpIds) {
          out[String(opId)] = opValues.get(opId);
          outScopes[String(opId)] = opScopes.get(opId) ?? "space";
        }
        ri2SetOutputScopes(out, outScopes);
        if (RI2_DEBUG) {
          console.log(
            `[ri2] run ${segmentId}: out=${safeJson(out)} scopes=${
              safeJson(outScopes)
            } inScopes=${
              safeJson({
                argument: argumentScope,
                leaf: Object.fromEntries(byLeafInput),
                ops: Object.fromEntries(byOp),
                ext: Object.fromEntries(byExternal),
                int: Object.fromEntries(byInternal),
              })
            }`,
          );
        }
        // Per-op containment parity: a throwing op's slot is written as
        // `undefined` (evalRog isolated it), siblings keep their values —
        // exactly what N legacy node actions produce.
        sendResult(tx, out);
        if (errors.length > 0) {
          firstError = errors[0].error;
          for (const { opId, error } of errors.slice(1)) {
            // Legacy fires onError once per throwing node; a single action
            // can only throw once — surface the rest via the logger.
            logger.warn("op-error", () => [`op ${opId} also threw`, error]);
          }
        }
      } finally {
        popFrame(frame);
      }
      if (firstError !== undefined) {
        // Legacy protocol (handleErrorOutput): attach the frame, then throw —
        // the scheduler catches, maps the stack, builds ErrorWithContext from
        // `error.frame`, and notifies onError handlers. Writes above survive.
        if (
          firstError !== null &&
          (typeof firstError === "object" || typeof firstError === "function")
        ) {
          (firstError as Error & { frame?: Frame }).frame = frame;
        }
        throw firstError;
      }
    };
  };
}
