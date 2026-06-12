import type { IStorageTransaction, MemorySpace } from "./interface.ts";

// Per-space client commit sequence numbers recorded for a source
// transaction at commit-build time (storage/v2.ts). Used by speculation
// lineage (scheduler-v2 §7.6) to express the `origin-committed`
// precondition for follow-up work.
const localSeqBySource = new WeakMap<object, Map<MemorySpace, number>>();

export function recordCommitLocalSeq(
  source: IStorageTransaction,
  space: MemorySpace,
  localSeq: number,
): void {
  let bySpace = localSeqBySource.get(source);
  if (!bySpace) {
    bySpace = new Map();
    localSeqBySource.set(source, bySpace);
  }
  bySpace.set(space, localSeq);
}

export function getCommitLocalSeq(
  source: IStorageTransaction | undefined,
  space: MemorySpace,
): number | undefined {
  if (!source) return undefined;
  return localSeqBySource.get(source)?.get(space);
}
