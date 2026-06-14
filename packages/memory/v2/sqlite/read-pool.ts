// A small LRU pool of read-only SQLite connections keyed by canonical file path.
//
// Reads (injected on-disk sources, and — once routed — cell-derived dbs) run
// here: each connection is opened `readonly` directly on the db file and is
// NEVER attached to the per-space engine connection. This gives three things the
// attach-per-op read path could not:
//   - no ATTACH/DETACH churn on the shared single-threaded engine connection;
//   - real per-connection read-only (SQLITE_OPEN_READONLY), not a connection-
//     global `PRAGMA query_only` window;
//   - no namespace collision — each connection's file is its own `main`, so
//     unqualified names resolve to it and there is no core store to shadow.
//
// The statement guard still applies (via `runQuery`): SELECT-only, no
// ATTACH/PRAGMA/multi-statement, so a read can't use its connection to reach
// other files.

import { Database } from "@db/sqlite";
import {
  type QueryColumn,
  runQuery,
  runQueryWithOrigins,
  type SqliteParams,
} from "./exec.ts";

export class ReadConnectionPool {
  #byPath = new Map<string, Database>();
  readonly #max: number;

  constructor(max = 32) {
    this.#max = max;
  }

  #connection(path: string): Database {
    const existing = this.#byPath.get(path);
    if (existing) {
      // LRU bump: re-insert so this path is most-recently-used.
      this.#byPath.delete(path);
      this.#byPath.set(path, existing);
      return existing;
    }
    const db = new Database(path, { readonly: true });
    // Match the engine connection's busy_timeout (engine.ts PRAGMAS). A pooled
    // read uses a SEPARATE OS connection from the writer's engine connection, so
    // a read that races a writer holding the file lock (another process over the
    // same store, or an external writer to a `cf link`ed disk source) would hit
    // an immediate SQLITE_BUSY at the default timeout of 0 — wait instead.
    db.exec("PRAGMA busy_timeout = 5000");
    this.#byPath.set(path, db);
    if (this.#byPath.size > this.#max) {
      const oldest = this.#byPath.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        const victim = this.#byPath.get(oldest);
        this.#byPath.delete(oldest);
        try {
          victim?.close();
        } catch { /* best-effort */ }
      }
    }
    return db;
  }

  /** Run a guarded read-only SELECT on the pooled read-only connection for
   *  `path`. Throws if the file can't be opened read-only (missing/unreadable). */
  query<Row = Record<string, unknown>>(
    path: string,
    sql: string,
    params?: SqliteParams,
  ): Row[] {
    return runQuery<Row>(this.#connection(path), sql, params);
  }

  /** Like {@link query} but also returns each result column's TRUE origin
   *  `(table, column)`, for CFC read-labeling. Used only when the db declares
   *  per-column `ifc`. */
  queryWithOrigins<Row = Record<string, unknown>>(
    path: string,
    sql: string,
    params?: SqliteParams,
  ): { rows: Row[]; columns: QueryColumn[] } {
    return runQueryWithOrigins<Row>(this.#connection(path), sql, params);
  }

  close(): void {
    for (const db of this.#byPath.values()) {
      try {
        db.close();
      } catch { /* best-effort */ }
    }
    this.#byPath.clear();
  }
}
