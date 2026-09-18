import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { Logger } from "@commonfabric/utils/logger";

import type { Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import { markDurableReadTx } from "../storage/reactivity-log.ts";

/**
 * Seed a list coordinator's result container with `[]` once `pull` settles, if
 * the container is still absent at that point.
 *
 * A resume reconcile that reads an undefined container defers instead of
 * reconciling against a value that has not arrived, and pulls the container so
 * that the value's arrival re-triggers the reconcile. A container that was
 * never persisted has no value to arrive: the pull settles with the container
 * still undefined. The seed writes the empty array a fresh coordinator would
 * have written, so the next reconcile has a value to build on.
 *
 * The pull settling is what ends the deferring coordinator's wait: `rearm`
 * re-triggers its reconcile once this chain completes, whatever the container
 * turned out to hold. A seed that writes nothing — because the container's
 * durable value arrived, or was already there — leaves no notification behind,
 * and the coordinator deferred on a read that may disagree with the durable
 * view a write is decided against, so a wait that ended only on the write is a
 * wait that can never end.
 *
 * The seed belongs to the deferral that started it, so it writes to `container`
 * and to nothing else. `stillHeld` reports whether the coordinator is still
 * holding that same container: a coordinator that has been torn down holds
 * nothing, and one that has swapped in a replacement defers and seeds for the
 * replacement through its own reconcile, which is what confirms the
 * replacement's own state before anything writes to it.
 *
 * `stillHeld` is asked once before the transaction opens, so that a torn-down
 * coordinator does not reach into a runtime that is shutting down, and again
 * inside the transaction body, which `editWithRetry` re-runs per attempt after
 * awaiting a conflict's catch-up gate. A commit already in flight is beyond
 * either question, since `editWithRetry` takes no cancellation, so the window
 * that remains is the span between an attempt's writes and its commit
 * landing.
 *
 * The seed runs whether the pull resolved or rejected, because a rejected pull
 * leaves the container as absent as a resolved one does. A rejected pull and a
 * failed seed are each reported through `logger`. The returned promise resolves
 * once the pull and the seed have both settled, and rejects for neither.
 *
 * `seedActionId` names the seed's write for the server-run stamp. The seed is
 * an out-of-band recovery write (serving-loop.md §3d, RULED 2026-08-05):
 * minted outside any scheduler run, so nothing else stamps it, and a SERVING
 * runtime's wave refuses an unstamped seal — the seed would never land and
 * the demanded derivation stay wedged while `editWithRetry` burns on the
 * refusal (the lunch-gate throw storm). It is legitimate server work but
 * neither a derivation nor a handler run, so it is declared with the
 * sanctioned internal bookkeeping kind, like the pattern-swap setup write.
 * Stamped inside the transaction body so every retry's fresh transaction
 * carries it. A no-op on the OFF arm; under client speculation bookkeeping
 * commits exactly as unstamped txs do (the overlay routes only
 * derivation-kind runs).
 *
 * The seed reads the durable replica view. Its question is whether a value
 * has reached the store, and its own write is the value the deferral is
 * waiting for, so a client speculation layer standing on the container must
 * neither answer that question nor enter the commit's read basis: a basis
 * naming one of those layers is refused terminally (speculation.md §6), and
 * a refused seed strands the coordinator on a container that never arrives.
 * The mark excludes the process-local speculation layers alone, so a durable
 * in-flight layer still stands the seed down. A no-op on a serving runtime,
 * which holds no speculation overlay.
 *
 * The chain is registered with the storage manager's settle barrier, so
 * `Cell.pull()` and `storageManager.synced()` hold until the seed's write has
 * settled. The pull reaches that barrier through the replica's own sync
 * bookkeeping, and this registration carries the wait across the span between
 * the pull settling and the seed's commit being issued.
 * `Runtime.dispose({ closeStorage: false })` drains the runtime through
 * `settled(Infinity)` before it tears anything down, so the store a reader is
 * handed afterwards carries whatever the seed wrote. A caller does not register
 * the returned promise; this function registers the chain.
 *
 * `scopeKeyIdentity` carries the deferring run's viewing identity through the
 * asynchronous pull and each seed attempt, so scoped containers initialize the
 * instance whose absence caused the deferral.
 */
export function seedResultContainerWhenPullSettles(
  runtime: Runtime,
  container: Cell<any[]>,
  stillHeld: () => boolean,
  rearm: () => void,
  pull: Promise<unknown>,
  logger: Logger,
  seedActionId: string,
  identity?: ScopeKeyIdentity,
): Promise<void> {
  const seedIfStillAbsent = (): Promise<void> => {
    if (!stillHeld()) return Promise.resolve();
    return runtime.editWithRetry((seedTx) => {
      if (!stillHeld()) return;
      markDurableReadTx(seedTx);
      if (identity !== undefined) seedTx.tx.scopeKeyIdentity = identity;
      runtime.stampServerRun(seedTx, {
        actionId: seedActionId,
        kind: "bookkeeping",
        scopeKeyIdentity: identity,
      });
      const scoped = container.withTx(seedTx);
      if (scoped.getRaw() === undefined) scoped.set([]);
    }).then(({ error }) => {
      if (error) {
        logger.warn(
          "resume-seed",
          "seeding the empty result container failed",
          { error },
        );
      }
    });
  };
  const settled = pull.finally(seedIfStillAbsent).then(
    () => {},
    (error: unknown) => {
      logger.warn("resume-pull", "resume container pull rejected", { error });
    },
  ).finally(() => {
    if (stillHeld()) rearm();
  });
  runtime.storageManager.trackUntilSettled(settled);
  return settled;
}
