import type { Cell } from "../cell.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";

/**
 * Whether a list coordinator (filter/map/flatMap) must (re)instantiate the
 * per-element op run it believes is already there.
 *
 * The coordinators track elements in an in-memory `elementRuns` map, and treat
 * the presence of an entry as proof that the element's op has been run. It is
 * not. The entry is bookkeeping in this process; the run it records is a WRITE,
 * and the two do not fail together. A resume reconcile reads sibling element
 * results that are still streaming in from storage, so it commits on a stale
 * basis and is rejected — every write in that transaction is reverted,
 * including the op instantiation for an element first seen in that reconcile.
 * The map entry survives the revert, so the next reconcile takes the
 * "already running" branch and the element is frozen out of the aggregate
 * forever. Nothing re-triggers it: a per-element op can compile to a pure
 * projection with no standing action of its own.
 *
 * The result cell is the evidence the map is not. `getRaw()` is the run's own
 * output — the redirect link a projection writes, or the result structure a
 * pattern writes — present from the instantiating transaction onward and absent
 * exactly when that write did not survive. So ask the cell, not the map, and
 * re-run when it is empty. Re-running is the operation the coordinators already
 * perform when an index-dependent element moves, and it is idempotent.
 *
 * This replaces an armed post-sync recovery that re-applied the reverted write
 * from outside the coordinator. That recovery had to guess, from a `getRaw()`
 * sample taken at a storage sync barrier with no causal relation to the
 * rejected commit, whether the revert had happened yet — and it lost that race
 * whenever the barrier resolved first, which is a timing accident. Deciding
 * inside the reconcile removes the race rather than retuning it.
 *
 * The read is a PRESENCE probe, so it runs under the coordinators' scaffolding
 * scope (S16): it asks whether anything is written here, never what. Without
 * `linkResolutionProbe` this would be an unprobed content read of every
 * element's result on every reconcile, smearing each element's flow label into
 * the coordinator's per-tx join — the exact leak `map.ts` wraps its own
 * container reads to avoid. `machineryRead` rides along so plumbing containers
 * do not consume `*`-path membership templates (template-population §6, SC-8).
 * It stays journaled either way, so a result arriving later still re-triggers
 * the reconcile.
 */
export function elementRunOutputMissing(
  // deno-lint-ignore no-explicit-any
  resultCell: Cell<any>,
  tx: IExtendedStorageTransaction,
): boolean {
  return tx.runWithAmbientReadMeta(
    { ...linkResolutionProbe, ...machineryRead },
    () => resultCell.withTx(tx).getRaw() === undefined,
  );
}
