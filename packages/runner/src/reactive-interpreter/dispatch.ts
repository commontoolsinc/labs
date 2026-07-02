/**
 * Flag-on DISPATCH planning (W3c) — decide whether a pattern instantiation
 * runs through the interpreter, and if so, emit the synthetic node plan the
 * runner instantiates instead of the legacy per-node loop.
 *
 * The plan RIDES THE EXISTING MACHINERY entirely: each emitted node is an
 * ordinary `{ type: "raw" }` module node whose `outputs` binding maps op ids
 * to the ops' ORIGINAL serialized output aliases (op id == `pattern.nodes`
 * index, from-builder pass 1) — so one `sendResult` writes every value
 * through `sendValueToBinding` exactly as the N legacy actions would have,
 * and the scheduler derives reads/writes from the bindings as for any raw
 * builtin. Faithful emission by construction; the win is ONE action instead
 * of N (the node-count half of the tax; the doc wins come in later
 * increments, per the v1 trajectory).
 *
 * FIRST INCREMENT scope: fully-pure single-segment patterns (no boundaries).
 * Everything else records a census reason and falls back to legacy — the
 * fail-closed discipline. Multi-segment emission (segments + preserved
 * boundary nodes) is the next increment on this seam.
 *
 * KNOWN GAP (tracked): per-op runtime errors are isolated to `undefined`
 * (value parity with legacy) and logged, but not yet routed to the
 * scheduler's onError channel (v1 R4 parity) — a throw here would abort the
 * WHOLE segment tx where legacy loses only the throwing node's write.
 */

import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "../cell.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Frame, Module, Pattern } from "../builder/types.ts";
import { popFrame } from "../builder/pattern.ts";
import { type BuiltRog, getBuiltRog } from "./from-builder.ts";
import { partition, type Segment } from "./partition.ts";
import { evalRog } from "./interpret.ts";
import type { OpId, Rog } from "./rog.ts";

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
}

const census: DispatchCensus = {
  attempted: 0,
  interpreted: 0,
  fallbackByReason: {},
};

export function getDispatchCensus(): DispatchCensus {
  return census;
}

export function resetDispatchCensus(): void {
  census.attempted = 0;
  census.interpreted = 0;
  census.fallbackByReason = {};
}

// ---------------------------------------------------------------------------
// Plan shape the runner consumes.
// ---------------------------------------------------------------------------

/** One synthetic node the runner feeds through `instantiateNode` verbatim. */
export interface SyntheticNode {
  module: Module;
  inputs: unknown;
  outputs: unknown;
}

export type DispatchPlan =
  | { kind: "interpret"; nodes: SyntheticNode[] }
  | { kind: "fallback"; reason: string };

/** Recursive key-walk for scope-routing markers in serialized pattern data. */
function containsScopeMarker(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((v) => containsScopeMarker(v, depth + 1));
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // The default "space" scope rides on every serialized alias — only a
    // NARROWED scope (user/session/any) or explicit routing is a marker.
    if (key === "scope" && v !== undefined && v !== "space") return true;
    if (
      (key === "defaultScope" || key === "targetSpace") && v !== undefined
    ) {
      return true;
    }
    if (containsScopeMarker(v, depth + 1)) return true;
  }
  return false;
}

function fallback(reason: string): DispatchPlan {
  const key = reason.split(":")[0];
  census.fallbackByReason[key] = (census.fallbackByReason[key] ?? 0) + 1;
  logger.info("fallback", () => [reason]);
  if (RI2_DEBUG) console.log(`[ri2] fallback: ${reason}`);
  return { kind: "fallback", reason };
}

export interface DispatchOptions {
  /** SECURITY gate (the legacy `resolveJavaScriptFunction` liveTrusted test,
   * runner-supplied): a captured live leaf impl may run in the interpreter
   * ONLY if it passes — an untrusted callback must take the legacy path,
   * where the SES fallback sandboxes it. */
  leafTrust: (fn: (input: unknown) => unknown) => boolean;
  /** Create the pattern frame the segment action runs in (the legacy
   * `createPatternFrame`): gives leaf bodies the runtime context legacy
   * actions have AND carries the piece metadata `handleSchedulerError`
   * reads off `error.frame`. The dispatch pops it via `popFrame`. */
  actionFrame: (tx: IExtendedStorageTransaction, cause: unknown) => Frame;
}

/** Recursively find the first gating leaf problem in a BuiltRog: an untrusted
 * captured impl (SECURITY) or a capability bit the single-node interpreter
 * cannot honor (needs handles / builder frame / instantiates patterns /
 * async). Fail-closed reasons feed the census. */
function findLeafGate(
  built: BuiltRog,
  leafTrust: DispatchOptions["leafTrust"],
): string | undefined {
  for (const op of built.rog.ops) {
    if (op.detail.kind === "leaf") {
      const impl = built.leafImpls.get(op.id);
      if (impl && !leafTrust(impl)) return "untrusted_leaf";
      const caps = op.detail.caps;
      if (caps) {
        const bits = Object.keys(caps).sort().join("+");
        return `leaf_caps:${bits}`;
      }
    }
  }
  for (const child of built.children.values()) {
    const inner = findLeafGate(child, leafTrust);
    if (inner) return inner;
  }
  return undefined;
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

  const built = getBuiltRog(pattern);
  if (!built) return fallback("no_rog");
  if (built.rog.incomplete?.length) {
    return fallback(`incomplete:${built.rog.incomplete.join(",")}`);
  }

  const leafGate = findLeafGate(built, options.leafTrust);
  if (leafGate) return fallback(leafGate);

  // SCOPE-NARROWING gate (v1 D-EMISSION-SCOPE parity): the legacy javascript
  // action tracks the narrowest scope read per run and routes outputs to
  // their effective scope (`tx.resetNarrowestReadScope` + scoped aliases /
  // `.asScope()` / `.inSpace()` / scoped result schemas). The segment action
  // implements none of that yet, so ANY scope marker in the serialized
  // pattern → legacy. Key-walk (not substring) over nodes + result schema;
  // a user-data key literally named "scope" over-blocks — fail-closed.
  if (
    containsScopeMarker(pattern.nodes) ||
    containsScopeMarker(pattern.resultSchema) ||
    containsScopeMarker(pattern.result)
  ) {
    return fallback("scope_narrowing");
  }

  // CONTROL REFERENCE-SEMANTICS gate: the legacy ifElse/when/unless builtins
  // write a LINK to the selected branch (write-once on re-trigger; aliasing
  // observable via Cell.push through the output). The evaluator resolves
  // VALUES — equal under deep reads, divergent under aliasing/write-shape.
  // Until control emission writes links, any control op → legacy.
  if (built.rog.ops.some((op) => op.kind === "control")) {
    return fallback("control_reference_semantics");
  }

  const part = partition({ built });
  if (!part.partitionable) return fallback(`unpartitionable:${part.reason}`);
  if (part.boundaries.length > 0) {
    return fallback(
      `boundaries_pending:${part.boundaries.map((b) => b.kind).join(",")}`,
    );
  }
  if (part.segments.length !== 1) {
    return fallback(`multi_segment_pending:${part.segments.length}`);
  }

  const node = buildSegmentNode(pattern, built, part.segments[0], options);
  if (typeof node === "string") return fallback(node);

  census.interpreted++;
  if (RI2_DEBUG) {
    console.log(
      `[ri2] interpret: ops=${built.rog.ops.length} ` +
        `nodes=${pattern.nodes.length} seg=${part.segments[0].id}`,
    );
  }
  return { kind: "interpret", nodes: [node] };
}

// ---------------------------------------------------------------------------
// Segment node emission.
// ---------------------------------------------------------------------------

/** Ops that write through their ORIGINAL node output alias: exactly the
 * node-derived ops (op id == `pattern.nodes` index; construct ops appended
 * past that range are pure intermediates with no legacy alias). */
function nodeDerivedOpIds(pattern: Pattern, rog: Rog): OpId[] {
  const n = pattern.nodes.length;
  return rog.ops.filter((op) => op.id < n).map((op) => op.id);
}

function buildSegmentNode(
  pattern: Pattern,
  built: BuiltRog,
  segment: Segment,
  options: DispatchOptions,
): SyntheticNode | string {
  const rog = built.rog;
  const outputOpIds = nodeDerivedOpIds(pattern, rog);
  // COST GATE (and correctness for node-less patterns): with no node-derived
  // ops there are no legacy actions to collapse — the result tree is pure
  // alias projection and interpretation could only add a spurious node.
  if (outputOpIds.length === 0) return "no_node_ops";

  // INPUTS binding. Whole-argument read when any argument ref exists
  // (per-path narrowing is the D-V2-READSETS follow-up on this seam), plus
  // one entry per externally-written internal cell the segment reads
  // (handler state / defaults — none in the no-boundary first increment,
  // but the shape is ready).
  const readsArgument = segment.inputs.some((r) => r.kind === "argument");
  const internalReads = new Map<number, unknown>();
  for (const ref of segment.inputs) {
    if (ref.kind !== "internal") continue;
    const decl = rog.internals[ref.cell];
    if (!decl) return `internal_ref_out_of_range:${ref.cell}`;
    if (decl.producedBy !== undefined) continue; // intra-segment producer
    internalReads.set(ref.cell, {
      $alias: { partialCause: decl.partialCause, path: [] },
    });
  }
  const inputs: Record<string, unknown> = {};
  if (readsArgument) {
    inputs.argument = { $alias: { cell: "argument", path: [] } };
  }
  if (internalReads.size > 0) {
    inputs.internals = Object.fromEntries(
      [...internalReads].map(([idx, alias]) => [String(idx), alias]),
    );
  }

  // OUTPUTS binding: op id → the op's ORIGINAL serialized output alias tree.
  const outputs: Record<string, unknown> = {};
  for (const opId of outputOpIds) {
    outputs[String(opId)] = pattern.nodes[opId].outputs;
  }

  const implementation = makeSegmentImplementation(
    built,
    outputOpIds,
    segment.id,
    options,
  );

  return {
    module: {
      type: "raw",
      implementation,
      // Debug label surfaced by the runner's raw-node naming.
      debugName: `ri2:${segment.id}`,
      // Thread the tx's narrowest read scope into the result write (legacy
      // javascript-action parity for runtime-scoped inputs; see the
      // sendResult site in instantiateRawNode).
      ri2ThreadNarrowestReadScope: true,
    } as unknown as Module,
    inputs,
    outputs,
  };
}

/** The raw-builtin implementation for one segment: evaluate the (sub-)ROG
 * against the bound inputs and write every node-derived op value through the
 * original aliases in ONE action. */
function makeSegmentImplementation(
  built: BuiltRog,
  outputOpIds: OpId[],
  segmentId: string,
  options: DispatchOptions,
) {
  return function reactiveInterpreterSegment(
    inputsCell: Cell<{
      argument?: unknown;
      internals?: Record<string, unknown>;
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
        // Legacy action parity: effective-scope routing derives from the
        // narrowest scope READ since this reset (scope carry-through is a
        // tx-level mechanism; the reads below feed it).
        tx.resetNarrowestReadScope();
        const bound = inputsCell.withTx(tx).get() ?? {};
        const seedByInternal = new Map<number, unknown>();
        for (const [key, value] of Object.entries(bound.internals ?? {})) {
          seedByInternal.set(Number(key), value);
        }
        const { opValues, errors } = evalRog(built.rog, {
          argument: bound.argument,
          leafImpls: built.leafImpls,
          children: built.children,
          seedByInternal,
        });
        const out: Record<string, unknown> = {};
        for (const opId of outputOpIds) {
          out[String(opId)] = opValues.get(opId);
        }
        // Per-op containment parity: the throwing op's slot is written as
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
