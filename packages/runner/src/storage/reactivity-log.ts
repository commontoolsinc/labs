import type {
  Activity,
  IMemorySpaceAddress,
  Metadata,
  TransactionReactivityLog,
} from "./interface.ts";
import { normalizeCellScope } from "../scope.ts";

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

// A read tagged with this marker is still recorded for CFC/scheduling, but
// carries NO value-equality concurrency precondition: read() does not mark its
// document `validated` (so the client validate()/claim() pass skips it), and
// buildReads DOWNGRADES it — rather than dropping the read outright, it replaces
// it with a nonRecursive existence read at the entity ROOT. Set transaction-wide
// by the UI-input blind-leaf-write mode (see markUiInputBlindWriteTx) so a scalar
// `$value` overwrite is a last-write-wins write on its leaf value (removing the
// own-write-race "stale confirmed read" conflict: a deep same-leaf patch sits
// below the root read, so TIER-2 nonRecursive overlap does not fire) while still
// failing fast on a concurrent WHOLE-DOC delete/replace (TIER-1 set/delete is
// path-blind, so the structural read yields a clean ConflictError instead of a
// raw "missing path" throw at patch read-materialization). Orthogonal to
// scheduling: reactivity/subscriptions are unaffected (only ignoreReadForScheduling
// gates those).
const ignoreReadForCommitMarker: unique symbol = Symbol(
  "ignoreReadForCommitMarker",
);

const markReadAsAttemptedWriteMarker: unique symbol = Symbol(
  "markReadAsAttemptedWriteMarker",
);

const allowMutableTransactionReadMarker: unique symbol = Symbol(
  "allowMutableTransactionReadMarker",
);

const internalVerifierReadMarker: unique symbol = Symbol(
  "internalVerifierReadMarker",
);

const linkResolutionProbeMarker: unique symbol = Symbol(
  "linkResolutionProbeMarker",
);

const mergeableOpReadMarker: unique symbol = Symbol(
  "mergeableOpReadMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export const ignoreReadForCommit: Metadata = {
  [ignoreReadForCommitMarker]: true,
};

export const markReadAsAttemptedWrite: Metadata = {
  [markReadAsAttemptedWriteMarker]: true,
};

export const allowMutableTransactionRead: Metadata = {
  [allowMutableTransactionReadMarker]: true,
};

export const internalVerifierRead: Metadata = {
  [internalVerifierReadMarker]: true,
};

/**
 * Marks the "is there a link here?" probe reads issued by link resolution.
 * They stay in the journal (reactivity must re-resolve when a link appears
 * or changes), and flow-label derivation classifies them as `followRef`
 * observations (observation classes, C0 §4): a probe consumes the pointer's
 * own label (link-origin / `observes:"followRef"` entries) but never the
 * target's content label — that still arrives only when something actually
 * reads the target's value (SC-8 / blind-passing).
 */
export const linkResolutionProbe: Metadata = {
  [linkResolutionProbeMarker]: true,
};

/**
 * Marks the reads a mergeable write (push / addUnique / increment / the keyed
 * ops) issues as part of building its own write — the value it reads to compute
 * the change. The commit's read-set builder drops these (and the write-target
 * attempted-writes and the cfc label) from conflict detection so the op merges,
 * while a handler's OWN explicit read of the same cell is left in place, so a
 * conditional mergeable write still conflicts-and-retries. Does not affect
 * scheduling.
 */
export const mergeableOpRead: Metadata = {
  [mergeableOpReadMarker]: true,
};

export function isReadIgnoredForScheduling(meta?: Metadata): boolean {
  return meta?.[ignoreReadForSchedulingMarker] === true;
}

export function isReadIgnoredForCommit(meta?: Metadata): boolean {
  return meta?.[ignoreReadForCommitMarker] === true;
}

// Transaction-level UI-input "blind leaf overwrite" mode. handleCellSet marks
// the transaction around a scalar `$value` set (and unmarks before
// prepareTxForCommit, so CFC boundary-commit read-then-writes keep their
// preconditions); while marked, read() tags every read with `ignoreReadForCommit`
// and skips `validated`, so the write carries no value-equality precondition on
// its leaf (last-write-wins, which is correct for raw scalar UI input) — buildReads
// downgrades the tagged reads to a single nonRecursive entity-root existence read,
// which still catches a concurrent whole-doc delete/replace. Read-modify-write
// and structured (array/object) writes are NOT marked and retain compare-and-set.
// Both the wrapper and the inner storage transaction(s) are marked, since
// read()/buildReads run on the inner one; the chain walk tolerates extra wrapper
// layers.
const uiInputBlindWriteTxs = new WeakSet<object>();

function* blindWriteTxChain(tx: object): Generator<object> {
  let current: object | undefined = tx;
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as { tx?: object }).tx;
  }
}

export function markUiInputBlindWriteTx(tx: object): void {
  for (const layer of blindWriteTxChain(tx)) uiInputBlindWriteTxs.add(layer);
}
export function unmarkUiInputBlindWriteTx(tx: object): void {
  for (const layer of blindWriteTxChain(tx)) uiInputBlindWriteTxs.delete(layer);
}
export function isUiInputBlindWriteTx(tx: object): boolean {
  return uiInputBlindWriteTxs.has(tx);
}

// Renderer-input (user-keystroke `$value`) provenance for timing-mitigation
// cell-flip shaping (plan B, channels 4/5). Unlike the blind-write mark above —
// which is cleared before commit — this one must SURVIVE to commit time so the
// scheduler can recognize a renderer-input change at the storage-notification
// choke point (via `notification.source`) and shape the resulting subscriber
// wake. It is a superset marker: set on the same UI-input writes, never cleared.
// See docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
const rendererInputTxs = new WeakSet<object>();

export function markRendererInputTx(tx: object): void {
  for (const layer of blindWriteTxChain(tx)) rendererInputTxs.add(layer);
}
export function isRendererInputTx(tx: object): boolean {
  return rendererInputTxs.has(tx);
}

// The structural existence/shape precondition for a blind UI-input write: the
// PARENT address of the cell being set. handleCellSet computes it from the cell's
// resolved write link — where the LOGICAL write path is known — because buildReads
// only sees the optimized, sometimes element-level diff and cannot recover it.
// Stored persistently (NOT cleared by unmark, unlike the blind mark) so buildReads
// can read it at commit time and emit one nonRecursive read there: that conflicts
// with a concurrent whole-doc delete (TIER-1, path-blind) and with a reshape of
// the parent or any ancestor (TIER-2 nonRecursive overlap fires at-or-above the
// read path) as a clean ConflictError, while a write to the cell's own subtree
// (its value, including array elements) sits BELOW the parent and does not
// conflict — keeping the own-write race conflict-free.
export type BlindStructuralTarget = {
  id: string;
  space: string;
  scope?: unknown;
  // The cell's parent path (the leaf path with its last segment dropped); `[]`
  // for a write at the entity root.
  path: readonly (string | number)[];
};
const blindStructuralTargets = new WeakMap<object, BlindStructuralTarget>();

export function setBlindStructuralTarget(
  tx: object,
  target: BlindStructuralTarget,
): void {
  for (const layer of blindWriteTxChain(tx)) {
    blindStructuralTargets.set(layer, target);
  }
}
export function getBlindStructuralTarget(
  tx: object,
): BlindStructuralTarget | undefined {
  for (const layer of blindWriteTxChain(tx)) {
    const target = blindStructuralTargets.get(layer);
    if (target !== undefined) return target;
  }
  return undefined;
}

export function isReadMarkedAsAttemptedWrite(meta?: Metadata): boolean {
  return meta?.[markReadAsAttemptedWriteMarker] === true;
}

export function isMergeableOpRead(meta?: Metadata): boolean {
  return meta?.[mergeableOpReadMarker] === true;
}

export function isMutableTransactionReadAllowed(meta?: Metadata): boolean {
  return meta?.[allowMutableTransactionReadMarker] === true;
}

export function isInternalVerifierRead(meta?: Metadata): boolean {
  return meta?.[internalVerifierReadMarker] === true;
}

export function isLinkResolutionProbe(meta?: Metadata): boolean {
  return meta?.[linkResolutionProbeMarker] === true;
}

const schedulerDependencyReadMarker: unique symbol = Symbol(
  "schedulerDependencyReadMarker",
);

/**
 * Marks reads performed by the scheduler's dependency seeding
 * (populateDeclaredSchedulerReads and friends): they materialize declared
 * dependencies so the reactivity log covers them for subscriptions, but
 * they are scheduling machinery, not handler consumption (§8.10.1:
 * dependency-discovery reads must not count as consumed inputs). Flow-label
 * derivation excludes them; the action body's own reads carry the taint.
 */
export const schedulerDependencyRead: Metadata = {
  [schedulerDependencyReadMarker]: true,
};

export function isSchedulerDependencyRead(meta?: Metadata): boolean {
  return meta?.[schedulerDependencyReadMarker] === true;
}

const machineryReadMarker: unique symbol = Symbol(
  "machineryReadMarker",
);

/**
 * Marks reads the runtime's op-instantiation/wiring machinery issues while
 * setting operations up or plumbing their results: binding node IO
 * (write-redirect resolution), collecting static redirect write targets,
 * dependency seeding's input/output materialization, result-write plumbing
 * (`sendValueToBinding`), and the list coordinators' container scaffolding
 * (presence probes, slot-identity diffs, `length` during instantiation).
 * Sibling of `schedulerDependencyRead` (§8.10.1: dependency-discovery reads
 * are not consumed inputs) but deliberately NARROWER in effect: flow-label
 * derivation still counts a marked read's ordinary label consumption
 * (link-origin pointer labels, concrete structure/derived entries — exactly
 * what it consumed before templates existed); only runtime-minted `*`-path
 * TEMPLATE consumption is excluded (template-population §3.1/§6). The
 * machinery reading a plumbing container's child paths is the runtime
 * wiring up operations, not an application observing a slot — letting those
 * reads consume membership/slot templates smeared one reconcile's J into
 * the next op's action chain (measured: the phase-B pointwise map suite),
 * which is what kept the generic pure-link mint route disabled in Stage A
 * (the SC-8 remainder).
 *
 * Stamp discipline: mark ONLY scopes whose every read the machinery itself
 * issues — pattern/handler code must never execute inside a marked scope.
 * Over-marking an application observation under-taints (the forbidden
 * direction); a missed machinery read merely leaves residual over-taint
 * (acceptable, additive-safe).
 */
export const machineryRead: Metadata = {
  [machineryReadMarker]: true,
};

export function isMachineryRead(meta?: Metadata): boolean {
  return meta?.[machineryReadMarker] === true;
}

const excludeReadFromConflictMarker: unique symbol = Symbol(
  "excludeReadFromConflictMarker",
);

/**
 * Marks reads that resolve a REFERENCE rather than consume a value, so they must
 * NOT be recorded as commit-time conflict dependencies. Building an asCell
 * argument follows its write-redirect link (followPointer reads the target's
 * shape), but the handler depends on the referent's VALUE only if it reads
 * THROUGH the cell in its body — those reads are recorded separately and stay
 * unmarked. The marked materialization reads remain in the journal for
 * reactivity; only buildReads (the conflict set) excludes them. This is the same
 * mechanism #4199 applied to Cell.set's link resolution, here applied to the
 * argument-materialization seam where the probe's over-conflict actually lives.
 * Orthogonal to schedulerDependencyRead and attemptedWrite.
 */
export const excludeReadFromConflict: Metadata = {
  [excludeReadFromConflictMarker]: true,
};

export function isReadExcludedFromConflict(meta?: Metadata): boolean {
  return meta?.[excludeReadFromConflictMarker] === true;
}

export function reactivityLogFromActivities(
  activities: Iterable<Activity>,
): TransactionReactivityLog {
  const log: TransactionReactivityLog = {
    reads: [],
    shallowReads: [],
    writes: [],
  };
  for (const activity of activities) {
    if ("read" in activity && activity.read) {
      if (isReadIgnoredForScheduling(activity.read.meta)) {
        continue;
      }
      const address: IMemorySpaceAddress = {
        space: activity.read.space,
        scope: normalizeCellScope(activity.read.scope),
        id: activity.read.id,
        path: [...activity.read.path],
      };
      if (activity.read.nonRecursive === true) {
        log.shallowReads.push(address);
      } else {
        log.reads.push(address);
      }
      if (isReadMarkedAsAttemptedWrite(activity.read.meta)) {
        log.attemptedWrites ??= [];
        log.attemptedWrites.push(address);
      }
      continue;
    }
    if ("write" in activity && activity.write) {
      log.writes.push({
        space: activity.write.space,
        scope: normalizeCellScope(activity.write.scope),
        id: activity.write.id,
        path: [...activity.write.path],
      });
    }
  }
  return log;
}
