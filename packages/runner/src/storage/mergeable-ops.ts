import type { FabricValue } from "@commonfabric/api";
import type { PatchOp } from "@commonfabric/memory/v2";
import { encodePointer } from "../../../memory/v2/path.ts";

/**
 * The mergeable patch operations: the {@link PatchOp} kinds an author invokes
 * directly (`Cell.push` / `addUnique` / `increment` / `removeByValue`) and that
 * the commit carries as recorded intent — resolved by the durable store against
 * live state — instead of a whole-value diff against a possibly-stale read. This
 * is what lets two handlers editing one collection concurrently merge rather
 * than clobber.
 *
 * This module is the single definition of that per-op behavior for the runner /
 * commit side. Each op appears exactly once in {@link mergeableOpDescriptors},
 * which owns how repeated calls fold into one intent ({@link foldMergeableIntent})
 * and how an intent becomes wire ops plus the diff-suppression it implies
 * ({@link buildMergeableIntent}). The wire-level half of an op (its shape, how it
 * applies to a document, which paths it touches for conflict detection) lives in
 * the wire-op registry in `@commonfabric/memory/v2/patch` — the two are joined by
 * the shared op tag.
 */
export type MergeableWireOp =
  | "append"
  | "add-unique"
  | "increment"
  | "remove-by-value";

/**
 * One Cell mutation's contribution to a mergeable op at a path. `append` /
 * `add-unique` carry the count of elements added at the tail (their values are
 * read back from the working array at commit); `increment` carries the delta;
 * each `remove-by-value` carries one removed element.
 */
export type MergeableOpDelta =
  | { op: "append" | "add-unique"; count: number }
  | { op: "increment"; by: number }
  | { op: "remove-by-value"; value: FabricValue };

/**
 * The accumulated intent for one document path: the deltas of a single op folded
 * together across the transaction (see {@link foldMergeableIntent}). Recording a
 * different op at the same path replaces the intent rather than folding.
 */
export type MergeableOpIntent =
  | { op: "append" | "add-unique"; path: readonly string[]; count: number }
  | { op: "increment"; path: readonly string[]; by: number }
  | { op: "remove-by-value"; path: readonly string[]; values: FabricValue[] };

/**
 * A document path covered by a mergeable op, used to suppress the whole-value
 * diff candidates the op replaces. `tailStart` (the array ops) is the first
 * covered index; `subtree` (a remove-by-value) suppresses the array path and
 * everything under it; with neither only the exact path is suppressed (the
 * scalar an `increment` replaces).
 */
export type OpSuppression = {
  path: readonly string[];
  tailStart?: number;
  subtree?: boolean;
};

/**
 * The working / initial state a mergeable op needs to turn its intent into wire
 * ops. `workingArray` is the transaction's post-write array at the op's path (or
 * undefined when the path does not hold an array); `hadInitialArray` is whether
 * the transaction's initial snapshot already had an array there — with no base,
 * the whole working array is the payload, so a stale-empty base does not drop
 * locally created prefix elements.
 */
export interface MergeableBuildContext {
  readonly workingArray?: readonly FabricValue[];
  readonly hadInitialArray: boolean;
}

export interface MergeableBuildResult {
  ops: PatchOp[];
  suppress: OpSuppression[];
}

// The single definition of one mergeable op's runtime behavior. Every question
// the commit path asks about a mergeable op is answered from here, so
// foldMergeableIntent / isNoopMergeableDelta / buildMergeableIntent never
// enumerate the ops — they index this table by the op tag and defer:
//
// - `isNoopDelta` — a delta that records nothing and is dropped before the write
//   target is even resolved (an empty tail op). Absent means "always record".
// - `fold` — how a delta combines into the path's accumulated intent.
// - `build` — how an accumulated intent becomes wire ops and diff-suppression.
interface MergeableOpDescriptor<
  Intent extends MergeableOpIntent = MergeableOpIntent,
  Delta extends MergeableOpDelta = MergeableOpDelta,
> {
  readonly op: Intent["op"];
  readonly isNoopDelta?: (delta: Delta) => boolean;
  readonly fold: (
    existing: MergeableOpIntent | undefined,
    path: readonly string[],
    delta: Delta,
  ) => Intent;
  readonly build: (
    intent: Intent,
    ctx: MergeableBuildContext,
  ) => MergeableBuildResult;
}

const descriptor = <
  Intent extends MergeableOpIntent,
  Delta extends MergeableOpDelta,
>(
  d: MergeableOpDescriptor<Intent, Delta>,
): MergeableOpDescriptor => d as unknown as MergeableOpDescriptor;

type AppendIntent = Extract<MergeableOpIntent, { op: "append" | "add-unique" }>;
type AppendDelta = Extract<MergeableOpDelta, { op: "append" | "add-unique" }>;

// A tail op (append / add-unique) folds by summing the appended count; a delta of
// nothing records nothing.
const isNoopTailDelta = (delta: AppendDelta): boolean => delta.count <= 0;

const foldTail = (
  existing: MergeableOpIntent | undefined,
  path: readonly string[],
  delta: AppendDelta,
): AppendIntent => ({
  op: delta.op,
  path,
  count: (existing?.op === delta.op ? existing.count : 0) + delta.count,
});

// A tail op emits its recorded tail slice (or the whole working array when there
// was no base to diff against) and suppresses the whole-array / appended-element
// diff candidates the op replaces, while leaving edits to existing elements
// (index < start) to the diff.
const buildTailOp = (
  intent: AppendIntent,
  ctx: MergeableBuildContext,
): MergeableBuildResult => {
  const array = ctx.workingArray;
  if (!array) {
    return { ops: [], suppress: [] };
  }
  const start = ctx.hadInitialArray
    ? Math.max(0, array.length - intent.count)
    : 0;
  const values = array.slice(start) as FabricValue[];
  if (values.length === 0) {
    return { ops: [], suppress: [] };
  }
  return {
    ops: [{ op: intent.op, path: encodePointer(intent.path), values }],
    suppress: [{ path: intent.path, tailStart: start }],
  };
};

const mergeableOpDescriptors: Record<MergeableWireOp, MergeableOpDescriptor> = {
  append: descriptor<AppendIntent, AppendDelta>({
    op: "append",
    isNoopDelta: isNoopTailDelta,
    fold: foldTail,
    build: buildTailOp,
  }),
  "add-unique": descriptor<AppendIntent, AppendDelta>({
    op: "add-unique",
    isNoopDelta: isNoopTailDelta,
    fold: foldTail,
    build: buildTailOp,
  }),
  increment: descriptor<
    Extract<MergeableOpIntent, { op: "increment" }>,
    Extract<MergeableOpDelta, { op: "increment" }>
  >({
    op: "increment",
    fold: (existing, path, delta) => ({
      op: "increment",
      path,
      by: (existing?.op === "increment" ? existing.by : 0) + delta.by,
    }),
    // Increments that summed to zero (a +1 and a -1) are a no-op: the working
    // value already reflects no change, so emit nothing (and nothing to suppress).
    build: (intent) =>
      intent.by === 0 ? { ops: [], suppress: [] } : {
        ops: [
          { op: "increment", path: encodePointer(intent.path), by: intent.by },
        ],
        suppress: [{ path: intent.path }],
      },
  }),
  "remove-by-value": descriptor<
    Extract<MergeableOpIntent, { op: "remove-by-value" }>,
    Extract<MergeableOpDelta, { op: "remove-by-value" }>
  >({
    op: "remove-by-value",
    fold: (existing, path, delta) => ({
      op: "remove-by-value",
      path,
      values: [
        ...(existing?.op === "remove-by-value" ? existing.values : []),
        delta.value,
      ],
    }),
    // The op rebuilds the array's membership by value; suppress the whole subtree
    // the local removal produced (a positional splice/shrink).
    build: (intent) => ({
      ops: intent.values.map((value) => ({
        op: "remove-by-value",
        path: encodePointer(intent.path),
        value,
      })),
      suppress: [{ path: intent.path, subtree: true }],
    }),
  }),
};

/**
 * Whether a delta records nothing and can be dropped before the write target is
 * resolved (an empty tail op). Defers to the op's descriptor.
 */
export const isNoopMergeableDelta = (delta: MergeableOpDelta): boolean =>
  mergeableOpDescriptors[delta.op].isNoopDelta?.(delta) ?? false;

/**
 * Folds one recorded {@link MergeableOpDelta} into the path's existing intent:
 * the same op combines (counts and increments sum, removed values accumulate); a
 * different op replaces the intent, so the last op kind recorded at a path wins.
 * Defers to the op's descriptor.
 */
export const foldMergeableIntent = (
  existing: MergeableOpIntent | undefined,
  path: readonly string[],
  delta: MergeableOpDelta,
): MergeableOpIntent =>
  mergeableOpDescriptors[delta.op].fold(existing, path, delta);

/**
 * Turns one accumulated intent into the wire ops the commit sends and the
 * diff-suppression they imply.
 */
export const buildMergeableIntent = (
  intent: MergeableOpIntent,
  ctx: MergeableBuildContext,
): MergeableBuildResult => mergeableOpDescriptors[intent.op].build(intent, ctx);

/** The wire-op tags this registry knows how to record and build. */
export const MERGEABLE_WIRE_OPS: readonly MergeableWireOp[] = Object.keys(
  mergeableOpDescriptors,
) as MergeableWireOp[];
