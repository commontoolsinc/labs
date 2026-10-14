/**
 * The worker side of `ReadWorkerPool` (`read-worker-pool.ts`): runs guarded
 * read-only queries on connections of its own, one at a time, so that a read
 * however slow occupies this thread and not the server's.
 *
 * Each connection is opened exactly as the server's own `ReadConnectionPool`
 * opens one, because it is one. The process holds a single libsqlite3 image,
 * built threadsafe, which `@db/sqlite` and the column-origin binding in this
 * worker load from the same file the main thread loaded.
 * `read-worker-protocol.ts` holds the exchange with the pool.
 */

import type { Database } from "@db/sqlite";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import { ensureColumnOriginAvailable } from "./column-origin.ts";
import { runInterruptibly, runNativeQuery } from "./exec.ts";
import { ReadConnectionPool } from "./read-pool.ts";
import {
  CONNECTIONS_PER_WORKER,
  type ReadWorkerReply,
  type ReadWorkerRequest,
} from "./read-worker-protocol.ts";

const connections = new ReadConnectionPool(CONNECTIONS_PER_WORKER);

/**
 * Posts `message` to the pool, moving the buffers in `transfer` rather than
 * copying them.
 */
function reply(message: ReadWorkerReply, transfer: ArrayBuffer[] = []): void {
  self.postMessage(message, { transfer });
}

/**
 * Helper for the message handler, which runs one read and replies with its
 * rows, or with what it threw.
 */
async function query(
  request: Extract<ReadWorkerRequest, { type: "query" }>,
): Promise<void> {
  const { id } = request;
  try {
    // A labeled read fails loudly in `columnOrigins()` when this returns false.
    if (request.labeled) await ensureColumnOriginAvailable();
    const db = openConnection(request.path, request.labeled);
    const result = runInterruptibly(
      db,
      () =>
        reply({
          type: "started",
          id,
          connection: Deno.UnsafePointer.value(db.unsafeHandle),
        }),
      () => runNativeQuery(db, request.sql, request.args, request.labeled),
    );
    reply({ type: "rows", id, result }, blobBuffers(result.values));
  } catch (error) {
    reply({
      type: "failed",
      id,
      name: error instanceof Error ? error.name : "SqliteError",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Helper for `query()`, which returns this worker's connection to the file at
 * `path`, and throws a `SqliteSourceUnavailable` error when the file cannot be
 * opened: a source whose file is missing or unreadable is unavailable, not a
 * failed query.
 */
function openConnection(path: string, labeled: boolean): Database {
  try {
    return connections.connection(path, labeled);
  } catch (error) {
    const unavailable = new Error(
      "sqlite: the database source is unavailable: its file cannot be " +
        `opened (${error instanceof Error ? error.message : String(error)})`,
    );
    unavailable.name = "SqliteSourceUnavailable";
    throw unavailable;
  }
}

/**
 * The buffers of the BLOB values among `rows`, each once. The driver copies
 * every BLOB into a buffer of its own, so moving it leaves nothing else
 * reading it.
 */
function blobBuffers(rows: unknown[][]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const row of rows) {
    for (const value of row) {
      if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) {
        buffers.add(value.buffer);
      }
    }
  }
  return [...buffers];
}

self.onmessage = (event: MessageEvent<ReadWorkerRequest>) => {
  const request = event.data;
  if (request.type === "query") {
    void query(request);
    return;
  }
  connections.close();
  reply({ type: "closed" });
};

// The listener above is installed before `ready` goes out, so nothing the
// pool sends after `ready` reaches a worker without one.
reply({ type: "ready", lifetimeLock: await holdWorkerLifetimeLock() });
