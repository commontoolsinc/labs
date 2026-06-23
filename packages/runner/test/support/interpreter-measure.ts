/**
 * Reactive Interpreter — reusable measurement harness (W0).
 *
 * Graduates the probes from the throwaway spikes
 * (test/spike-map-interpreted.test.ts, test/spike-cfc-oracle.test.ts) into
 * durable instruments shared by the footprint benches and the CFC differential
 * oracle. Generic over *any* pattern: legacy today, interpreted in later work
 * orders.
 *
 * Probes:
 *   - attachDocRecorder: distinct documents created + per-write path length
 *     (pathLen 0 = whole-doc write/create; >0 = path-scoped patch).
 *   - nodeStats: scheduler graph node counts by type + total run count.
 *   - derivedConfidentiality: the CFC oracle metric — the derived-origin
 *     confidentiality atoms persisted at a document (what a reader picks up).
 *   - seedLabeledNumber: seed a numeric input doc with an optional
 *     confidentiality atom at path [].
 */

import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "./trusted-builder.ts";
import type { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
} from "../../src/cfc/types.ts";
import type {
  ICommitNotification,
  StorageNotification,
} from "../../src/storage/interface.ts";
import type { Cell } from "../../src/builder/types.ts";

// ---------------------------------------------------------------------------
// Document recorder.
// ---------------------------------------------------------------------------

export interface DocMark {
  /** Distinct ids first created (before===undefined at root) since the mark. */
  createdSince(): string[];
  /** Distinct ids written since the mark, with the min write path length seen. */
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
// CFC label probe (requires cfcFlowLabels: "persist").
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

// ---------------------------------------------------------------------------
// Environment.
// ---------------------------------------------------------------------------

export interface MeasureEnvOptions {
  cfcEnforcementMode?: CfcEnforcementMode;
  cfcFlowLabels?: CfcFlowLabelsMode;
}

export interface MeasureEnv {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  docs: DocRecorder;
  commonfabric: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  space: MemorySpace;
  dispose(): Promise<void>;
}

export function createMeasureEnv(
  signer: Identity,
  options: MeasureEnvOptions = {},
): MeasureEnv {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    ...(options.cfcEnforcementMode
      ? { cfcEnforcementMode: options.cfcEnforcementMode }
      : {}),
    ...(options.cfcFlowLabels ? { cfcFlowLabels: options.cfcFlowLabels } : {}),
  });
  const docs = attachDocRecorder(storageManager);
  const { commonfabric } = createTrustedBuilder(runtime);
  return {
    runtime,
    storageManager,
    docs,
    commonfabric,
    space: signer.did() as MemorySpace,
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** Seed a numeric input doc; optionally label it with a confidentiality atom. */
export async function seedLabeledNumber(
  env: MeasureEnv,
  cause: string,
  n: number,
  atom?: string,
): Promise<Cell<number>> {
  const { runtime, space } = env;
  const seed = runtime.edit();
  const cell = runtime.getCell<number>(space, cause, undefined, seed);
  const id = cell.getAsNormalizedFullLink().id;
  seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
    value: n,
    ...(atom
      ? {
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: [atom] } }],
          },
        },
      }
      : {}),
  });
  if (!(await seed.commit()).ok) throw new Error("seed commit failed");
  return cell;
}
