/**
 * The messages `ReadWorkerPool` and its workers (`read-worker.ts`) exchange.
 *
 * A worker announces itself with `ready` once it can receive, and is sent
 * nothing before: a message posted to a worker still evaluating its module
 * graph (`@db/sqlite` loads its library with a top-level await) is dropped. A
 * worker holds at most one read at a time. For each read it reports `started`,
 * naming the connection the read runs on, before it steps the statement, and
 * then exactly one of `rows` or `failed`. `close` is sent only to an idle
 * worker, which closes its connections and replies `closed`.
 */

import type { BindValue } from "@db/sqlite";
import type { NativeQueryResult } from "./exec.ts";

/** Read-only connections one worker keeps open at most. */
export const CONNECTIONS_PER_WORKER = 8;

/** A message the pool sends a worker. */
export type ReadWorkerRequest =
  | {
    /** Runs one guarded read. */
    type: "query";

    /** The pool's id for this read, echoed in every reply about it. */
    id: number;

    /** Canonical path of the SQLite file to read. */
    path: string;

    /** A single read-only statement. */
    sql: string;

    /** Bind values, already converted by `bindArgs`. */
    args: BindValue[];

    /**
     * Whether the read is labeled: run in `int64` mode and return each result
     * column's TRUE origin.
     */
    labeled: boolean;
  }
  | {
    /** Closes the worker's connections, after which it replies `closed`. */
    type: "close";
  };

/** A message a worker sends the pool. */
export type ReadWorkerReply =
  | {
    /** The worker can now receive requests. */
    type: "ready";

    /** The worker's lifetime lock, for `terminateWorker`. */
    lifetimeLock: string | undefined;
  }
  | {
    /** The read `id` is about to step on `connection`. */
    type: "started";

    /** The read this reports on. */
    id: number;

    /**
     * Address of the `sqlite3*` the read runs on, which the pool passes to
     * `sqlite3_interrupt` to cancel it. It stays a live connection until the
     * worker's next request, since only a request opens (and so evicts) one.
     */
    connection: bigint;
  }
  | {
    /** The read `id` returned its rows. */
    type: "rows";

    /** The read this reports on. */
    id: number;

    /** What the driver returned, unconverted. */
    result: NativeQueryResult;
  }
  | {
    /** The read `id` threw. */
    type: "failed";

    /** The read this reports on. */
    id: number;

    /** The thrown error's `name`. */
    name: string;

    /** The thrown error's `message`. */
    message: string;
  }
  | {
    /** The worker closed its connections. */
    type: "closed";
  };
