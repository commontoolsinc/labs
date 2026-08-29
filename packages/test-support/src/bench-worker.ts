/**
 * The near side of a benchmark that measures a crossing to a worker.
 *
 * A benchmark of this shape sends one message, waits for the far side to
 * acknowledge it, and counts the round trip as one iteration. That is what a
 * `Deno.bench()` iteration can measure -- a pipeline of overlapping sends would
 * report throughput while the harness is timing latency -- and it is the shape
 * the connections these benchmarks stand in for actually use.
 *
 * One worker serves a whole run. A fresh one per iteration would measure worker
 * startup, which is milliseconds against the microseconds of a payload and
 * would swamp everything such a benchmark is trying to see.
 *
 * The far side is a module of the benchmark's own, since what it should do with
 * a message is the benchmark's question. What this fixes is the near side:
 * holding one request in flight, settling it against the ack, and failing
 * rather than hanging when the worker cannot answer.
 */

/**
 * What a far side reports. One boolean and, on failure, why.
 *
 * Deliberately this small: a reply carrying any part of what was sent would put
 * a second clone of it on the return leg and bury the cost being measured.
 */
export type BenchWorkerAck = {
  readonly ok: boolean;
  readonly error?: string;
};

/** The outstanding request's settlement, held while it is in flight. */
type PendingRequest = {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
};

/**
 * A worker held for a whole benchmark run, with one message outstanding at a
 * time.
 *
 * @typeParam Request What the benchmark posts. The far side reads it; nothing
 *   here does.
 */
export class BenchWorker<Request> {
  readonly #worker: Worker;
  #pending: PendingRequest | undefined;

  /**
   * A failure the worker reported with nothing in flight, kept so the next
   * send reports it instead of waiting for an ack that cannot come.
   */
  #terminal: Error | undefined;

  /**
   * Constructs an instance, starting the worker.
   *
   * @param moduleUrl The far side's module, as `import.meta.resolve()` gives
   *   it.
   */
  constructor(moduleUrl: string) {
    this.#worker = new Worker(moduleUrl, { type: "module" });

    this.#worker.onmessage = (ev: MessageEvent<BenchWorkerAck>) => {
      const pending = this.#pending;

      this.#pending = undefined;

      if (ev.data.ok) {
        pending?.resolve();
      } else {
        pending?.reject(new Error(`Far side refused: ${ev.data.error}`));
      }
    };

    // A worker that fails to start, or throws where nothing catches, sends no
    // ack -- and a benchmark waiting on one that will never arrive hangs rather
    // than failing, which is the worst way for a measurement to end. Both
    // routes below settle a request in flight AND record the failure, because
    // the first of them can arrive before the first send: a worker that dies
    // during startup has nothing to reject, and without the record every later
    // send would wait on it.
    this.#worker.onerror = (ev: ErrorEvent) => {
      // Handled here, so it stops here: an error left to its default course
      // reaches the host as an unhandled worker error and takes the process
      // with it, which ends the run rather than the measurement.
      ev.preventDefault();
      this.#fail(new Error(`Far side failed: ${ev.message}`));
    };

    // Covers the far side receiving something it cannot deserialize, which no
    // `error` event reports.
    this.#worker.onmessageerror = () => {
      this.#fail(new Error("Far side could not deserialize the message"));
    };
  }

  /**
   * Sends one request and settles when the far side acknowledges it.
   *
   * @throws If the far side reports failure, or has already failed. An
   *   unexamined ack is what makes a benchmark measure the wrong thing
   *   silently.
   */
  send(request: Request): Promise<void> {
    if (this.#terminal !== undefined) return Promise.reject(this.#terminal);

    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#worker.postMessage(request);
    });
  }

  /** Stops the worker. */
  close(): void {
    this.#worker.terminate();
  }

  /** Settles anything in flight with `error`, and records it for later sends. */
  #fail(error: Error): void {
    const pending = this.#pending;

    this.#pending = undefined;
    this.#terminal = error;
    pending?.reject(error);
  }
}
