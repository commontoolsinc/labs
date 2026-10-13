/**
 * Runs guarded read-only SQLite queries on a few Deno workers, so that a read
 * taking seconds holds a worker instead of the server's event loop. A full
 * scan of a multi-gigabyte file, or a read waiting on another process's write
 * lock, otherwise leaves every connection of every space unanswered for as
 * long as it runs: `@db/sqlite` steps a statement synchronously on the thread
 * that calls it.
 *
 * Only files the server's own engine never writes may be read here. A worker
 * reading a rollback-journal file holds its shared lock across the read, and a
 * commit that writes the same file from the main thread would then wait for it
 * in SQLite's busy handler, on the main thread.
 *
 * * A read is cancelled through its `AbortSignal`: still queued, it is dropped;
 * running, the pool calls `sqlite3_interrupt` on the worker's connection, the
 * one SQLite call documented as safe on a connection another thread is using.
 * Terminating a worker would not stop it, since a thread inside the SQLite
 * library runs on to the statement's end. SQLite does not consult an
 * interrupt while it waits for another connection's lock, so a read waiting
 * on one ends when the wait does, after at most its `busy_timeout`. A read
 * that finishes before the interrupt reaches it returns its rows.
 *
 * A pool that has started a worker keeps the process alive until it is
 * closed. The workers exchange `read-worker-protocol.ts`'s messages.
 */

import { terminateWorker } from "@commonfabric/utils/worker-lifetime";
import type { SqliteNativeRow } from "../../v2.ts";
import {
  bindArgs,
  columnsFromNative,
  type NativeQueryResult,
  type QueryColumn,
  rowsFromNative,
  type SqliteParams,
} from "./exec.ts";
import { assertReadOnly } from "./guard.ts";
import {
  ensureNativeSymbols,
  nativeSymbols,
  nativeSymbolsUnavailableReason,
} from "./native-symbols.ts";
import {
  CONNECTIONS_PER_WORKER,
  type ReadWorkerReply,
  type ReadWorkerRequest,
} from "./read-worker-protocol.ts";

/** How one read is run. */
export type ReadWorkerQueryOptions = {
  /**
   * Whether the read is labeled: its INTEGER values arrive whole (a value past
   * 2^53 as a `bigint`) and it returns each result column's TRUE origin, for
   * CFC read labeling.
   */
  labeled: boolean;

  /** Cancels the read: a queued one is dropped, a running one interrupted. */
  signal?: AbortSignal;
};

/** How a {@link ReadWorkerPool} runs its workers. */
export type ReadWorkerPoolOptions = {
  /** The most reads run at once, one per worker. Four unless given. */
  maxWorkers?: number;

  /**
   * The module each worker runs, `read-worker.ts` unless given; a test passes
   * one that fails in the way it is testing.
   */
  workerModule?: URL;
};

/** A read's rows, and, for a labeled read, its result columns' origins. */
export type ReadWorkerQueryResult<Row extends SqliteNativeRow> = {
  /** The rows, keyed by output column name. */
  rows: Row[];

  /** Each result column's TRUE origin, present for a labeled read. */
  columns?: QueryColumn[];
};

/** One read, from the call that asked for it to the reply that settles it. */
type ReadJob = {
  /** What the worker is asked to run. */
  request: Extract<ReadWorkerRequest, { type: "query" }>;

  /** Settles the read with its rows. */
  resolve: (result: NativeQueryResult) => void;

  /** Settles the read with an error. */
  reject: (error: Error) => void;

  /** The connection the read runs on, once its worker reported `started`. */
  connection?: bigint;

  /** Why the read is being cancelled, once something asked for that. */
  cancelled?: Error;
};

/**
 * Runs guarded read-only queries on up to `maxWorkers` workers, starting each
 * worker the first time no idle one is free and keeping it until the pool
 * closes. A read waits in a queue while every worker is busy.
 */
export class ReadWorkerPool {
  #maxWorkers: number;
  #workerModule: URL;
  #workers = new Set<ReadWorker>();
  #queue: ReadJob[] = [];
  #nextId = 1;
  #terminations = new Set<Promise<void>>();
  #closing: Promise<void> | undefined;
  #symbols: Promise<void> | undefined;

  /** Constructs an instance which runs workers as `options` says. */
  constructor(options: ReadWorkerPoolOptions = {}) {
    const {
      maxWorkers = 4,
      workerModule = new URL("./read-worker.ts", import.meta.url),
    } = options;
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new RangeError(
        `sqlite: a read pool needs at least one worker, not ${maxWorkers}`,
      );
    }
    this.#maxWorkers = maxWorkers;
    this.#workerModule = workerModule;
  }

  /**
   * Runs the single read-only statement `sql` against the SQLite file at
   * `path` on a worker, and returns its rows. The statement guard runs here as
   * well as in the worker, so a refused statement throws before it is queued.
   *
   * Throws what the read threw, with that error's `name` and `message`; an
   * `AbortError` when `options.signal` or `close()` cancelled it; a
   * `DataCloneError` for a parameter a worker cannot be sent, such as a
   * symbol; and an error when the pool was already closed, or the worker
   * running the read failed.
   */
  async query<Row extends SqliteNativeRow = SqliteNativeRow>(
    path: string,
    sql: string,
    params: SqliteParams | undefined,
    options: ReadWorkerQueryOptions,
  ): Promise<ReadWorkerQueryResult<Row>> {
    assertReadOnly(sql);
    const result = await this.#enqueue({
      type: "query",
      id: this.#nextId++,
      path,
      sql,
      args: bindArgs(params),
      labeled: options.labeled,
    }, options.signal);
    return options.labeled
      ? {
        rows: rowsFromNative<Row>(result),
        columns: columnsFromNative(result),
      }
      : { rows: rowsFromNative<Row>(result) };
  }

  /**
   * Rejects every queued read, interrupts every running one, and settles once
   * each worker has closed its connections and been torn down. Reads asked
   * for afterwards are rejected.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  /**
   * Helper for `query()`, which queues `request` and settles with its worker's
   * reply.
   */
  #enqueue(
    request: ReadJob["request"],
    signal: AbortSignal | undefined,
  ): Promise<NativeQueryResult> {
    if (this.#closing !== undefined) {
      return Promise.reject(new Error("sqlite: the read pool is closed"));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const { promise, resolve, reject } = Promise.withResolvers<
      NativeQueryResult
    >();
    const onAbort = () => {
      if (signal !== undefined) this.#cancel(job, abortError(signal));
    };
    const job: ReadJob = {
      request,
      resolve: (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#queue.push(job);
    this.#dispatch();
    return promise;
  }

  /**
   * Hands queued reads to idle workers, preferring one that recently read the
   * same file and so may still hold it open, and starts a worker when none is
   * idle and the pool is below its size.
   */
  #dispatch(): void {
    while (this.#queue.length > 0) {
      const idle = [...this.#workers].filter((worker) => worker.idle);
      if (idle.length === 0) {
        const starting = [...this.#workers].filter((worker) => !worker.ready)
          .length;
        if (
          this.#workers.size < this.#maxWorkers &&
          starting < this.#queue.length
        ) {
          try {
            this.#workers.add(this.#start());
          } catch (error) {
            // Dispatch runs in worker event handlers, so a worker that cannot
            // even be constructed fails the reads waiting for one instead of
            // escaping into them.
            const failure = error instanceof Error
              ? error
              : new Error(String(error));
            for (const job of this.#queue.splice(0)) job.reject(failure);
          }
        }
        return;
      }
      const job = this.#queue.shift();
      if (job === undefined) return;
      const path = job.request.path;
      const worker = idle.find((candidate) => candidate.hasRead(path)) ??
        idle[0];
      // A request the worker could not take was rejected, and the worker is
      // still idle for the next one.
      worker.run(job);
    }
  }

  /** Helper for `#dispatch()`, which starts a worker. */
  #start(): ReadWorker {
    // A worker takes no read before the interrupt symbol is bound, so that a
    // read can always be interrupted once it is running.
    this.#symbols ??= ensureNativeSymbols().then(
      (bound) => {
        if (!bound) warnUninterruptible(nativeSymbolsUnavailableReason());
      },
      (error: unknown) => warnUninterruptible(error),
    );
    const worker = new ReadWorker(this.#workerModule, this.#symbols, {
      onReady: () => this.#dispatch(),
      onSettled: () => this.#dispatch(),
      onStarted: (job) => {
        if (job.cancelled !== undefined) interrupt(job);
      },
      onFailed: (failed, error, started) => {
        this.#workers.delete(failed);
        const termination = failed.terminate();
        this.#terminations.add(termination);
        void termination.then(() => this.#terminations.delete(termination));
        if (!started) {
          // A worker that fails before it can receive anything (its module
          // missing from a compiled binary, a permission it lacks) is how the
          // next one would fail too, so the reads waiting for it fail with it
          // rather than starting worker after worker. A later read tries again.
          for (const job of this.#queue.splice(0)) job.reject(error);
          return;
        }
        if (this.#closing === undefined) this.#dispatch();
      },
    });
    return worker;
  }

  /**
   * Helper for the abort listener and `close()`, which drops `job` if it is
   * still queued and otherwise interrupts it once it has started.
   */
  #cancel(job: ReadJob, reason: Error): void {
    const queued = this.#queue.indexOf(job);
    if (queued !== -1) {
      this.#queue.splice(queued, 1);
      job.reject(reason);
      return;
    }
    job.cancelled ??= reason;
    if (job.connection !== undefined) interrupt(job);
  }

  /** Helper for `close()`, which does the closing once. */
  async #shutDown(): Promise<void> {
    const closed = new Error("sqlite: the read pool closed");
    closed.name = "AbortError";
    for (const job of [...this.#queue]) this.#cancel(job, closed);
    for (const worker of this.#workers) {
      if (worker.job !== undefined) this.#cancel(worker.job, closed);
    }
    await Promise.all([...this.#workers].map((worker) => worker.shutDown()));
    this.#workers.clear();
    await Promise.all(this.#terminations);
    this.#terminations.clear();
  }
}

/** What a {@link ReadWorker} tells its pool. */
type ReadWorkerEvents = {
  /** The worker can take a read. */
  onReady: () => void;

  /** The worker's read is about to step, on `job.connection`. */
  onStarted: (job: ReadJob) => void;

  /** The worker's read settled, and the worker is idle again. */
  onSettled: (job: ReadJob) => void;

  /**
   * The worker failed with `error`, before it announced itself unless
   * `started`; its read, if it had one, was rejected.
   */
  onFailed: (worker: ReadWorker, error: Error, started: boolean) => void;
};

/** One worker of a {@link ReadWorkerPool}, and the read it is running. */
class ReadWorker {
  /** Whether the worker has announced itself and not failed. */
  ready = false;

  /** The read the worker is running. */
  job: ReadJob | undefined;

  #worker: Worker;
  #symbols: Promise<void>;
  #events: ReadWorkerEvents;
  #lifetimeLock: string | undefined;
  #recentPaths: string[] = [];
  #failed = false;
  #announced = Promise.withResolvers<void>();
  #settled: PromiseWithResolvers<void> | undefined;
  #closed: PromiseWithResolvers<void> | undefined;

  /**
   * Constructs an instance which starts a worker running `module` and reports
   * to `events`, taking reads once the worker has announced itself and
   * `symbols` settled.
   */
  constructor(
    module: URL,
    symbols: Promise<void>,
    events: ReadWorkerEvents,
  ) {
    this.#symbols = symbols;
    this.#events = events;
    this.#worker = new Worker(module, {
      type: "module",
      name: "memory-sqlite-read",
    });
    this.#worker.onmessage = (event: MessageEvent<ReadWorkerReply>) =>
      this.#receive(event.data);
    this.#worker.onerror = (event) => {
      event.preventDefault();
      // The worker's own message can name files on the server (a module it
      // could not load, say), so it goes to the log and the read gets the
      // bare fact.
      console.error(`[memory-sqlite] a read worker failed: ${event.message}`);
      this.#fail("sqlite: a read worker failed");
    };
    this.#worker.onmessageerror = () => {
      this.#fail("sqlite: a read worker's reply could not be received");
    };
  }

  /** Whether the worker can take a read now. */
  get idle(): boolean {
    return this.ready && this.job === undefined && this.#closed === undefined;
  }

  /** Whether one of the worker's recent reads was of the file at `path`. */
  hasRead(path: string): boolean {
    return this.#recentPaths.includes(path);
  }

  /**
   * Hands the idle worker `job`, and returns whether it took it. A request
   * that cannot be posted — a parameter structured cloning refuses, such as a
   * symbol — rejects `job` and leaves the worker idle.
   */
  run(job: ReadJob): boolean {
    try {
      this.#post(job.request);
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    this.job = job;
    this.#settled = Promise.withResolvers<void>();
    const path = job.request.path;
    this.#recentPaths = [
      path,
      ...this.#recentPaths.filter((recent) => recent !== path),
    ].slice(0, CONNECTIONS_PER_WORKER);
    return true;
  }

  /**
   * Settles once the worker's read has settled, it has closed its
   * connections, and it has been torn down. Its read should already have been
   * cancelled, or this waits for the read to end on its own.
   */
  async shutDown(): Promise<void> {
    await this.#announced.promise;
    await this.#settled?.promise;
    if (!this.#failed) {
      this.#closed = Promise.withResolvers<void>();
      this.#post({ type: "close" });
      await this.#closed.promise;
    }
    await this.terminate();
  }

  /** Terminates the worker, settling once it has been torn down. */
  terminate(): Promise<void> {
    return terminateWorker(this.#worker, this.#lifetimeLock);
  }

  /** Helper for the message handler, which acts on one reply. */
  #receive(reply: ReadWorkerReply): void {
    switch (reply.type) {
      case "ready":
        this.#lifetimeLock = reply.lifetimeLock;
        void this.#symbols.then(() => {
          if (this.#failed) return;
          this.ready = true;
          this.#announced.resolve();
          this.#events.onReady();
        });
        return;
      case "started":
        if (this.job?.request.id !== reply.id) return;
        this.job.connection = reply.connection;
        this.#events.onStarted(this.job);
        return;
      case "rows":
        this.#settle(reply.id, (job) => job.resolve(reply.result));
        return;
      case "failed":
        this.#settle(reply.id, (job) => {
          const error = new Error(reply.message);
          error.name = reply.name;
          if (job.cancelled === undefined) {
            job.reject(error);
            return;
          }
          // Cancelled, so the read most likely ended because it was
          // interrupted; why it was cancelled is what the caller asked about.
          const cancelled = new Error(job.cancelled.message, { cause: error });
          cancelled.name = job.cancelled.name;
          job.reject(cancelled);
        });
        return;
      case "closed":
        this.#closed?.resolve();
        return;
    }
  }

  /** Helper for `#receive()`, which settles the read `id` with `settle`. */
  #settle(id: number, settle: (job: ReadJob) => void): void {
    const job = this.job;
    if (job?.request.id !== id) return;
    this.job = undefined;
    settle(job);
    this.#settled?.resolve();
    this.#events.onSettled(job);
  }

  /** Helper for the error handlers, which fails the worker and its read. */
  #fail(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    const started = this.ready;
    this.ready = false;
    const error = new Error(message);
    const job = this.job;
    this.job = undefined;
    job?.reject(error);
    this.#announced.resolve();
    this.#settled?.resolve();
    this.#closed?.resolve();
    this.#events.onFailed(this, error, started);
  }

  /** Helper for the worker's requests, which posts `request` to it. */
  #post(request: ReadWorkerRequest): void {
    this.#worker.postMessage(request);
  }
}

/**
 * Interrupts the running read `job`, which its worker keeps pending until the
 * read's statement sees it (see `read-worker.ts`). The connection stays open
 * until the worker's next request, which the pool sends only after this read's
 * reply, and an interrupt arriving once the read is done is cleared when the
 * next read starts, so it cannot reach a later read.
 */
function interrupt(job: ReadJob): void {
  if (job.connection === undefined) return;
  nativeSymbols()?.sqlite3_interrupt(Deno.UnsafePointer.create(job.connection));
}

/** Logs that a cancelled or closing read cannot be stopped, and why. */
function warnUninterruptible(reason: unknown): void {
  console.warn(
    "[memory-sqlite] SQLite reads cannot be interrupted, so a cancelled or " +
      `closing read runs to its end: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
  );
}

/** The error a read cancelled through `signal` rejects with. */
function abortError(signal: AbortSignal): Error {
  const error = new Error(
    `sqlite: the read was cancelled${
      signal.reason instanceof Error ? `: ${signal.reason.message}` : ""
    }`,
  );
  error.name = "AbortError";
  return error;
}
