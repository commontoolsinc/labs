import { isDeno } from "@commonfabric/utils/env";

/**
 * A per-frame record of what the memory client exchanges with its server,
 * written as JSON lines to the file `CF_MEMORY_FRAME_LOG` names.
 *
 * The timing statistics say how long a frame took and the slow-query buffer
 * says which server operations were expensive; neither says what a frame
 * CARRIED, and that is the question an over-wide read turns on — which
 * documents a watch asked for, and how many the server answered with. This
 * records that: one line per frame in either direction, with the frame's
 * type and uncompressed size, the roots and selectors of a watch mutation,
 * the operations and reads of a commit, and the documents a sync delivered
 * with their size and top-level keys. Selectors repeat across roots, so each
 * distinct one is written once under its hash and referenced by it after.
 *
 * Off unless the variable is set, and only in Deno, where the file can be
 * written; nothing here runs in a browser. The cost when on is a synchronous
 * append per frame, which is the price of a record that survives a process
 * that never returns to the event loop.
 */

/** The writer behind {@link logOutgoingFrame} and {@link logIncomingFrame}. */
export interface FrameLog {
  logOutgoing(message: unknown, bytes: number): void;
  logIncoming(message: unknown, bytes: number): void;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * The UTF-8 size of `value` as JSON, which is what the transport sends, or
 * `undefined` for a value JSON cannot write — a `bigint` among the Fabric
 * primitives. A size the log cannot compute is left absent rather than
 * allowed to stop the frame it describes.
 */
const jsonBytes = (value: unknown): number | undefined => {
  try {
    return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

/** The top-level keys of a document's value, or its type when it has none. */
const docKeys = (value: unknown): string[] | string =>
  value !== null && typeof value === "object"
    ? Object.keys(value as object).slice(0, 12)
    : typeof value;

const hashString = (text: string): string => {
  // FNV-1a over UTF-16 code units: a stable short key for deduplicating
  // selectors within one log, not a content address anything else reads.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * The shape of a commit's read set: how many distinct documents it touched,
 * how the reads divide by document kind and by path depth, the documents read
 * most, and the paths read on the most-read one. A read set in the tens of
 * thousands is a walk, and this says what was walked without carrying every
 * entry.
 */
const summarizeReads = (confirmed: unknown[]): unknown => {
  const byKind = new Map<string, number>();
  const byDepth = new Map<number, number>();
  const byDoc = new Map<string, number>();
  for (const read of confirmed) {
    const entry = read as Record<string, unknown>;
    const id = String(entry.id);
    const kind = id.slice(0, id.indexOf(":"));
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const depth = Array.isArray(entry.path) ? entry.path.length : -1;
    byDepth.set(depth, (byDepth.get(depth) ?? 0) + 1);
    byDoc.set(id, (byDoc.get(id) ?? 0) + 1);
  }
  const topDocs = [...byDoc].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const top = topDocs[0]?.[0];
  const topDocPaths = new Set<string>();
  if (top !== undefined) {
    for (const read of confirmed) {
      const entry = read as Record<string, unknown>;
      if (entry.id === top && Array.isArray(entry.path)) {
        topDocPaths.add(entry.path.join("/"));
        if (topDocPaths.size >= 60) break;
      }
    }
  }
  return {
    distinctDocs: byDoc.size,
    byKind: Object.fromEntries(byKind),
    byDepth: Object.fromEntries(byDepth),
    topDocs,
    topDocPaths: [...topDocPaths],
  };
};

const summarizeCommit = (commit: unknown): unknown => {
  const record = commit as Record<string, unknown> | undefined;
  if (record === undefined) return undefined;
  const operations = Array.isArray(record.operations) ? record.operations : [];
  const reads = record.reads as Record<string, unknown[]> | undefined;
  const confirmed = reads?.confirmed ?? [];
  // A confirmed read at seq 0 asserts the document is absent; where the
  // server holds it, that read is what the commit conflicts on.
  const absent = confirmed.filter((read) =>
    (read as Record<string, unknown>).seq === 0
  );
  return {
    localSeq: record.localSeq,
    operations: operations.map((operation) => {
      const entry = operation as Record<string, unknown>;
      return {
        op: entry.op,
        id: entry.id,
        scope: entry.scope,
        bytes: jsonBytes(operation),
      };
    }),
    confirmedReads: confirmed.length,
    confirmedReadsAtSeqZero: absent.length,
    confirmedReadIdsAtSeqZero: [
      ...new Set(
        absent.map((read) => String((read as Record<string, unknown>).id)),
      ),
    ],
    pendingReads: reads?.pending?.length ?? 0,
    reads: summarizeReads(confirmed),
  };
};

const summarizeSync = (sync: unknown): unknown => {
  const record = sync as Record<string, unknown> | undefined;
  if (record === undefined || record.type !== "sync") return undefined;
  const upserts = Array.isArray(record.upserts) ? record.upserts : [];
  const removes = Array.isArray(record.removes) ? record.removes : [];
  return {
    fromSeq: record.fromSeq,
    toSeq: record.toSeq,
    upserts: upserts.map((upsert) => {
      const entry = upsert as Record<string, unknown>;
      const doc = entry.doc as Record<string, unknown> | undefined;
      const value = doc?.value;
      return {
        id: entry.id,
        scope: entry.scope,
        seq: entry.seq,
        deleted: entry.deleted,
        bytes: doc === undefined ? 0 : jsonBytes(doc),
        keys: docKeys(value),
      };
    }),
    removes: removes.length,
  };
};

/**
 * The entities a `graph.query` response carries: one per snapshot, with the
 * document's size and keys, and `absent` for a snapshot naming a document
 * the space does not hold.
 */
const summarizeEntities = (entities: unknown): unknown => {
  if (!Array.isArray(entities)) return undefined;
  return entities.map((snapshot) => {
    const entry = snapshot as Record<string, unknown>;
    const doc = entry.document as Record<string, unknown> | null | undefined;
    return {
      id: entry.id,
      scope: entry.scope,
      seq: entry.seq,
      ...(doc === null || doc === undefined
        ? { absent: true }
        : { bytes: jsonBytes(doc), keys: docKeys(doc.value) }),
    };
  });
};

/**
 * A frame log writing JSON lines through `write`, which takes one line
 * without its newline. The env-driven log below appends to a file; a test
 * collects the lines.
 */
export function createFrameLog(write: (line: string) => void): FrameLog {
  const started = performance.now();
  const seenSelectors = new Set<string>();
  const append = (record: Record<string, unknown>): void => {
    try {
      write(
        JSON.stringify({
          t: Math.round(performance.now() - started),
          ...record,
        }),
      );
    } catch {
      // A diagnostic that cannot be written is dropped rather than failing
      // the frame it describes.
    }
  };
  const selectorRef = (selector: unknown): string => {
    const text = JSON.stringify(selector);
    const hash = hashString(text);
    if (!seenSelectors.has(hash)) {
      seenSelectors.add(hash);
      append({ dir: "selector", hash, bytes: text.length, selector });
    }
    return hash;
  };
  const summarizeWatches = (watches: unknown): unknown => {
    if (!Array.isArray(watches)) return undefined;
    return watches.map((watch) => {
      const spec = watch as Record<string, unknown>;
      const query = spec.query as Record<string, unknown> | undefined;
      const roots = Array.isArray(query?.roots) ? query.roots : [];
      return {
        id: spec.id,
        kind: spec.kind,
        roots: roots.map((root) => {
          const entry = root as Record<string, unknown>;
          return {
            id: entry.id,
            scope: entry.scope,
            selector: selectorRef(entry.selector),
          };
        }),
      };
    });
  };
  // A summary is built under the same protection as its write: a value the
  // summary cannot describe is the log's problem, never the frame's.
  const guarded = (build: () => Record<string, unknown>): void => {
    let summary: Record<string, unknown>;
    try {
      summary = build();
    } catch (error) {
      summary = {
        dir: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    append(summary);
  };
  const outgoing = (message: unknown, bytes: number) => {
    const record = message as Record<string, unknown>;
    const summary: Record<string, unknown> = {
      dir: "out",
      type: record.type,
      requestId: record.requestId,
      bytes,
    };
    if (record.type === "transact") {
      summary.commit = summarizeCommit(record.commit);
    } else if (
      record.type === "session.watch.add" ||
      record.type === "session.watch.set"
    ) {
      summary.watches = summarizeWatches(record.watches);
    } else if (record.type === "graph.query") {
      summary.query = summarizeWatches([{ query: record.query }]);
    }
    return summary;
  };
  const incoming = (message: unknown, bytes: number) => {
    const record = message as Record<string, unknown>;
    const summary: Record<string, unknown> = {
      dir: "in",
      type: record.type,
      requestId: record.requestId,
      bytes,
    };
    const result = record.ok as Record<string, unknown> | undefined;
    if (record.error !== undefined) {
      summary.error = record.error;
    }
    if (result !== undefined && typeof result === "object") {
      if (result.sync !== undefined) {
        summary.sync = summarizeSync(result.sync);
      }
      if (result.entities !== undefined) {
        summary.entities = summarizeEntities(result.entities);
      }
      if (result.seq !== undefined) summary.seq = result.seq;
      if (result.serverSeq !== undefined) {
        summary.serverSeq = result.serverSeq;
      }
    }
    if (record.type === "session/effect") {
      const effect = record.effect as Record<string, unknown> | undefined;
      summary.effectType = effect?.type;
      summary.sync = summarizeSync(effect);
    }
    return summary;
  };
  return {
    logOutgoing: (message, bytes) => guarded(() => outgoing(message, bytes)),
    logIncoming: (message, bytes) => guarded(() => incoming(message, bytes)),
  };
}

/**
 * The frame log the environment asks for: one appending to the file
 * `CF_MEMORY_FRAME_LOG` names, or none. `readEnv` and `appendTo` are what a
 * Deno process supplies and a test replaces.
 */
export function frameLogFromEnvironment(
  readEnv: (name: string) => string | undefined,
  appendTo: (path: string, line: string) => void,
): FrameLog | undefined {
  let path: string | undefined;
  try {
    const raw = readEnv("CF_MEMORY_FRAME_LOG");
    path = raw === undefined || raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
  if (path === undefined) return undefined;
  const target = path;
  return createFrameLog((line) => appendTo(target, line));
}

const envLog: FrameLog | undefined = isDeno()
  ? frameLogFromEnvironment(
    (name) => Deno.env.get(name),
    (path, line) => Deno.writeTextFileSync(path, line + "\n", { append: true }),
  )
  : undefined;

/** Whether frames are being recorded. Read once; a process opts in at start. */
export const frameLogEnabled = envLog !== undefined;

/** Record a frame this client is sending. `bytes` is its encoded UTF-8 size. */
export function logOutgoingFrame(message: unknown, bytes: number): void {
  envLog?.logOutgoing(message, bytes);
}

/** Record a decoded frame this client received. `bytes` is its encoded UTF-8 size. */
export function logIncomingFrame(message: unknown, bytes: number): void {
  envLog?.logIncoming(message, bytes);
}
