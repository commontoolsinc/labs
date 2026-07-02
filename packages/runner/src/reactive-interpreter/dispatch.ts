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
import type { Module, Pattern } from "../builder/types.ts";
import { type BuiltRog, getBuiltRog } from "./from-builder.ts";
import { partition, type Segment } from "./partition.ts";
import { evalRog } from "./interpret.ts";
import type { OpId, Rog } from "./rog.ts";

const logger = getLogger("runner.reactive-interpreter", {
  enabled: false,
  level: "info",
});

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

function fallback(reason: string): DispatchPlan {
  const key = reason.split(":")[0];
  census.fallbackByReason[key] = (census.fallbackByReason[key] ?? 0) + 1;
  logger.info("fallback", () => [reason]);
  return { kind: "fallback", reason };
}

/**
 * Plan the interpreter instantiation for one pattern, or fall back.
 * Pure decision + closure construction; no runtime side effects.
 */
export function planInterpreterDispatch(pattern: Pattern): DispatchPlan {
  census.attempted++;

  const built = getBuiltRog(pattern);
  if (!built) return fallback("no_rog");
  if (built.rog.incomplete?.length) {
    return fallback(`incomplete:${built.rog.incomplete.join(",")}`);
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

  const node = buildSegmentNode(pattern, built, part.segments[0]);
  if (typeof node === "string") return fallback(node);

  census.interpreted++;
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
): SyntheticNode | string {
  const rog = built.rog;
  const outputOpIds = nodeDerivedOpIds(pattern, rog);

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
  );

  return {
    module: {
      type: "raw",
      implementation,
      // Debug label surfaced by the runner's raw-node naming.
      debugName: `ri2:${segment.id}`,
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
      sendResult(tx, out);
      for (const { opId, error } of errors) {
        // Value parity holds (op isolated to undefined); onError-channel
        // parity is a tracked follow-up (see module doc).
        logger.warn("op-error", () => [`op ${opId} threw`, error]);
      }
    };
  };
}
