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

// PROTOTYPE (scratch/cellset-conflict-probe): a read tagged with this marker is
// recorded for CFC/scheduling as usual, but is EXCLUDED from the commit's
// concurrency preconditions — it does not become a `reads.confirmed` entry in
// buildReads, and it does not mark its document `validated` (so the client
// validate()/claim() pass skips it too). Used by the UI-input blind-leaf-write
// mode so a `$value` set is a precondition-free LWW overwrite (kills the
// own-write-race "stale confirmed read" conflict). Orthogonal to scheduling.
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
 * or changes), but flow-label derivation treats them as shape observations
 * of link topology, not content reads: following a reference must not taint
 * the follower with the target's content label when nothing reads the
 * target's value (SC-8 / blind-passing). The residual signal is the 1-bit
 * "this path holds no link", accepted until observation classes land.
 */
export const linkResolutionProbe: Metadata = {
  [linkResolutionProbeMarker]: true,
};

export function isReadIgnoredForScheduling(meta?: Metadata): boolean {
  return meta?.[ignoreReadForSchedulingMarker] === true;
}

export function isReadIgnoredForCommit(meta?: Metadata): boolean {
  return meta?.[ignoreReadForCommitMarker] === true;
}

// PROTOTYPE (scratch/cellset-conflict-probe): transaction-level UI-input "blind
// LWW leaf overwrite" mode. `handleCellSet` marks its transaction; thereafter
// `read()` tags EVERY read in that tx with `ignoreReadForCommit` (so no read —
// not the write-target leaf, not the link-resolution/schema-policy reads —
// becomes a commit precondition) and skips marking docs `validated`;
// `writeWithinBranch` skips the same-value short-circuit; `normalizeAndDiff`
// skips no-op suppression. Marking the wrapper also marks the inner storage tx,
// since read()/writeWithinBranch run on the inner one.
const uiInputBlindWriteTxs = new WeakSet<object>();
export function markUiInputBlindWriteTx(tx: object): void {
  uiInputBlindWriteTxs.add(tx);
  const inner = (tx as { tx?: object }).tx;
  if (inner && inner !== tx) {
    uiInputBlindWriteTxs.add(inner);
  }
}
export function isUiInputBlindWriteTx(tx: object): boolean {
  return uiInputBlindWriteTxs.has(tx);
}

export function isReadMarkedAsAttemptedWrite(meta?: Metadata): boolean {
  return meta?.[markReadAsAttemptedWriteMarker] === true;
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
