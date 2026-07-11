/**
 * Scheduler-owned control-flow signal for work that cannot run until an
 * asynchronous prerequisite becomes ready.
 *
 * Unlike {@link RetryImmediately}, this signal never asks the current
 * scheduler turn to wait or consumes an authored retry budget. The scheduler
 * aborts the current transaction, keeps the work subscribed, and installs a
 * generation-fenced continuation on {@link readiness}.
 */
export class RetryWhenReady extends Error {
  readonly readiness: Promise<unknown>;

  constructor(
    readiness: PromiseLike<unknown>,
    message = "Retry work when readiness resolves",
  ) {
    super(message);
    this.name = "RetryWhenReady";
    this.readiness = Promise.resolve(readiness);
  }
}

export function isRetryWhenReady(error: unknown): error is RetryWhenReady {
  return error instanceof RetryWhenReady;
}
