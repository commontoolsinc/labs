import type {
  Activity,
  IMemorySpaceAddress,
  Metadata,
  TransactionReactivityLog,
} from "./interface.ts";

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

const markReadAsPotentialWriteMarker: unique symbol = Symbol(
  "markReadAsPotentialWriteMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export const markReadAsPotentialWrite: Metadata = {
  [markReadAsPotentialWriteMarker]: true,
};

export function isReadIgnoredForScheduling(meta?: Metadata): boolean {
  return meta?.[ignoreReadForSchedulingMarker] === true;
}

export function isReadMarkedAsPotentialWrite(meta?: Metadata): boolean {
  return meta?.[markReadAsPotentialWriteMarker] === true;
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
        path: activity.read.path.slice(1),
      };
      if (activity.read.nonRecursive === true) {
        log.shallowReads.push(address);
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
        path: activity.write.path.slice(1),
      });
    }
  }
  return log;
}
