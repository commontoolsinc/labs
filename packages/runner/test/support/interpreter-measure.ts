/**
 * Reactive Interpreter v2 — measurement harness (ported from #4298's
 * test/support/interpreter-measure.ts, trimmed to the probes in use).
 *
 * Probes:
 *   - attachDocRecorder: distinct documents created + per-write path length
 *     (pathLen 0 = whole-doc write/create; >0 = path-scoped patch).
 *   - nodeStats: scheduler graph node counts by type + total run count.
 *   - derivedConfidentiality: persisted derived-origin confidentiality atoms
 *     at a document (the pointwise-CFC oracle metric, W4).
 */

import type { StorageManager } from "../../src/storage/cache.deno.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ICommitNotification,
  StorageNotification,
} from "../../src/storage/interface.ts";

// ---------------------------------------------------------------------------
// Document recorder.
// ---------------------------------------------------------------------------

export interface DocMark {
  /** Distinct ids first created (before===undefined at root) since the mark. */
  createdSince(): string[];
  /** Distinct ids written since the mark, with the min write path length. */
  writtenSince(): Array<{ id: string; minPathLen: number }>;
}

export interface DocRecorder {
  /** Every distinct id created (root creation) over the recorder's lifetime. */
  createdIds: Set<string>;
  /** Open a delta window. */
  mark(): DocMark;
}

export function attachDocRecorder(storageManager: {
  subscribe(s: { next(n: StorageNotification): undefined }): void;
}): DocRecorder {
  const createdIds = new Set<string>();
  const seenIds = new Set<string>();
  const events: Array<{ id: string; created: boolean; pathLen: number }> = [];

  storageManager.subscribe({
    next(notification: StorageNotification) {
      if (notification.type !== "commit") return undefined;
      const commit = notification as ICommitNotification;
      for (const change of commit.changes) {
        const id = change.address.id as string;
        const path = (change.address as { path?: readonly unknown[] }).path ??
          [];
        const created = change.before === undefined && path.length === 0;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          if (created) createdIds.add(id);
        }
        events.push({ id, created, pathLen: path.length });
      }
      return undefined;
    },
  });

  return {
    createdIds,
    mark(): DocMark {
      const start = events.length;
      return {
        createdSince() {
          const seen = new Set<string>();
          const out: string[] = [];
          for (let i = start; i < events.length; i++) {
            if (events[i].created && !seen.has(events[i].id)) {
              seen.add(events[i].id);
              out.push(events[i].id);
            }
          }
          return out;
        },
        writtenSince() {
          const minPath = new Map<string, number>();
          for (let i = start; i < events.length; i++) {
            const e = events[i];
            minPath.set(e.id, Math.min(minPath.get(e.id) ?? 99, e.pathLen));
          }
          return [...minPath.entries()].map(([id, minPathLen]) => ({
            id,
            minPathLen,
          }));
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler graph stats.
// ---------------------------------------------------------------------------

export interface NodeStats {
  total: number;
  byType: Record<string, number>;
  /** Sum of runCount across all nodes (total executions so far). */
  runCount: number;
}

export function nodeStats(runtime: Runtime): NodeStats {
  const snap = runtime.scheduler.getGraphSnapshot();
  const byType: Record<string, number> = {};
  let runCount = 0;
  for (const n of snap.nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    runCount += n.stats?.runCount ?? 0;
  }
  return { total: snap.nodes.length, byType, runCount };
}

// ---------------------------------------------------------------------------
// CFC label probe (requires cfcFlowLabels: "persist"; used by the W4
// pointwise oracle).
// ---------------------------------------------------------------------------

interface StoredLabelEntry {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
}

/** Persisted derived-origin confidentiality atoms at a document. */
export function derivedConfidentiality(
  storageManager: ReturnType<typeof StorageManager.emulate>,
  space: MemorySpace,
  id: string,
): string[] {
  const replica = storageManager.open(space).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredLabelEntry[] } };
    } | undefined;
  };
  return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
    .filter((e) => e.origin === "derived")
    .flatMap((e) => e.label.confidentiality ?? [])
    .sort();
}
