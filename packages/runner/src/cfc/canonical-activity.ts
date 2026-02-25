import type { Activity, Metadata } from "../storage/interface.ts";

export interface CanonicalBoundaryRead {
  readonly space: string;
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly meta: Metadata;
  readonly internalVerifierRead: boolean;
}

export interface CanonicalAttemptedWrite {
  readonly space: string;
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly changed: boolean;
}

export interface CanonicalBoundaryActivity {
  readonly reads: readonly CanonicalBoundaryRead[];
  readonly attemptedWrites: readonly CanonicalAttemptedWrite[];
  readonly finalAttemptedWrites: readonly CanonicalAttemptedWrite[];
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function toCanonicalJsonPointer(path: readonly string[]): string {
  if (path.length === 0) {
    return "/";
  }
  return `/${path.map(escapeJsonPointerToken).join("/")}`;
}

export function stripStorageWrapperFromPath(
  path: readonly string[],
): readonly string[] {
  let start = 0;
  while (start < path.length && path[start] === "value") {
    start++;
  }
  return path.slice(start);
}

export function canonicalizeStoragePath(path: readonly string[]): string {
  const stripped = stripStorageWrapperFromPath(path);
  return toCanonicalJsonPointer(stripped);
}

function activityWriteChangedFlag(activityWrite: unknown): boolean {
  if (
    activityWrite && typeof activityWrite === "object" &&
    "changed" in activityWrite
  ) {
    return Boolean((activityWrite as { changed?: unknown }).changed);
  }
  return true;
}

function finalAttemptedWriteKey(write: CanonicalAttemptedWrite): string {
  return `${write.space}\u0000${write.id}\u0000${write.type}\u0000${write.path}`;
}

export function canonicalizeBoundaryActivity(
  activity: Iterable<Activity>,
): CanonicalBoundaryActivity {
  const reads: CanonicalBoundaryRead[] = [];
  const attemptedWrites: CanonicalAttemptedWrite[] = [];
  const finalWriteByKey = new Map<string, CanonicalAttemptedWrite>();

  for (const item of activity) {
    if ("read" in item && item.read) {
      const read = item.read;
      reads.push({
        space: read.space,
        id: read.id,
        type: read.type,
        path: canonicalizeStoragePath(read.path),
        meta: read.meta ?? {},
        internalVerifierRead: Boolean(read.meta?.internalVerifierRead),
      });
      continue;
    }

    if ("write" in item && item.write) {
      const write = item.write;
      const canonicalWrite: CanonicalAttemptedWrite = {
        space: write.space,
        id: write.id,
        type: write.type,
        path: canonicalizeStoragePath(write.path),
        changed: activityWriteChangedFlag(write),
      };
      attemptedWrites.push(canonicalWrite);
      finalWriteByKey.set(finalAttemptedWriteKey(canonicalWrite), canonicalWrite);
    }
  }

  const finalAttemptedWrites = [...finalWriteByKey.values()].sort((a, b) => {
    if (a.space !== b.space) return a.space.localeCompare(b.space);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.path.localeCompare(b.path);
  });

  return {
    reads,
    attemptedWrites,
    finalAttemptedWrites,
  };
}

export function hasWriteActivity(activity: Iterable<Activity>): boolean {
  for (const item of activity) {
    if ("write" in item && item.write) {
      return true;
    }
  }
  return false;
}
