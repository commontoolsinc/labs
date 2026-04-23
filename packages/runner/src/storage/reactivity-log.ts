import type {
  Activity,
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
  Metadata,
  TransactionReactivityLog,
} from "./interface.ts";

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

const markReadAsPotentialWriteMarker: unique symbol = Symbol(
  "markReadAsPotentialWriteMarker",
);

const allowMutableTransactionReadMarker: unique symbol = Symbol(
  "allowMutableTransactionReadMarker",
);

const internalVerifierReadMarker: unique symbol = Symbol(
  "internalVerifierReadMarker",
);

const shallowReadInterestedChildrenMarker: unique symbol = Symbol(
  "shallowReadInterestedChildrenMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export const markReadAsPotentialWrite: Metadata = {
  [markReadAsPotentialWriteMarker]: true,
};

export const allowMutableTransactionRead: Metadata = {
  [allowMutableTransactionReadMarker]: true,
};

export const internalVerifierRead: Metadata = {
  [internalVerifierReadMarker]: true,
};

export function shallowReadInterestedChildren(
  children: readonly MemoryAddressPathComponent[],
): Metadata {
  return {
    [shallowReadInterestedChildrenMarker]: [...new Set(children)],
  };
}

export function isReadIgnoredForScheduling(meta?: Metadata): boolean {
  return meta?.[ignoreReadForSchedulingMarker] === true;
}

export function isReadMarkedAsPotentialWrite(meta?: Metadata): boolean {
  return meta?.[markReadAsPotentialWriteMarker] === true;
}

export function isMutableTransactionReadAllowed(meta?: Metadata): boolean {
  return meta?.[allowMutableTransactionReadMarker] === true;
}

export function isInternalVerifierRead(meta?: Metadata): boolean {
  return meta?.[internalVerifierReadMarker] === true;
}

export function getShallowReadInterestedChildren(
  meta?: Metadata,
): readonly MemoryAddressPathComponent[] | undefined {
  const value = meta?.[shallowReadInterestedChildrenMarker];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (
    !value.every((entry) =>
      typeof entry === "string" || typeof entry === "number"
    )
  ) {
    return undefined;
  }
  return value as readonly MemoryAddressPathComponent[];
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
        id: activity.read.id,
        type: activity.read.type,
        path: [...activity.read.path],
      };
      if (activity.read.nonRecursive === true) {
        const interestedChildren = getShallowReadInterestedChildren(
          activity.read.meta,
        );
        log.shallowReads.push({
          ...address,
          ...(interestedChildren ? { interestedChildren } : {}),
        });
      } else {
        log.reads.push(address);
      }
      if (isReadMarkedAsPotentialWrite(activity.read.meta)) {
        log.potentialWrites ??= [];
        log.potentialWrites.push(address);
      }
      continue;
    }
    if ("write" in activity && activity.write) {
      log.writes.push({
        space: activity.write.space,
        id: activity.write.id,
        type: activity.write.type,
        path: [...activity.write.path],
      });
    }
  }
  return log;
}
