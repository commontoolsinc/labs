import type { Runtime } from "@commonfabric/runner";

/**
 * Resolve once the reconciler has flushed the ops a change produced.
 *
 * Cells backed by the runtime deliver their updates through the scheduler,
 * which dispatches with `setTimeout(fn, 0)`, so `runtime.idle()` is the wait
 * that covers them. The reconciler queues its ops synchronously and flushes
 * them from a microtask, so a microtask queued afterwards runs after that
 * flush.
 *
 * Both waits are needed: the reconciler tests mix synchronous mock cells, which
 * never reach the scheduler, with runtime-backed cells, which are unreachable
 * by yielding to the microtask queue.
 */
export function opsFlushed(runtime: Runtime): Promise<void> {
  return runtime.idle().then(() =>
    new Promise<void>((resolve) => queueMicrotask(resolve))
  );
}
