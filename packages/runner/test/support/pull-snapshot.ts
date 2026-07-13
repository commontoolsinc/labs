import {
  type FabricValue,
  nativeFromFabricValue,
} from "@commonfabric/data-model/fabric-value";

/**
 * Test-support helpers for capturing a running pattern's output as
 * fully-detached, fabric-safe plain data.
 *
 * ## Why this exists
 *
 * These tests read a pattern's output with `await result.pull()`, which returns
 * a LIVE query-result view backed by the runtime. The test then disposes the
 * runtime in a `finally` immediately after reading. Two properties are required
 * at the read site, and both are subtle:
 *
 * 1. **Detach before dispose.** The live view must be materialized into plain,
 *    self-contained data *before* `runtime.dispose()`, or a later read/compare
 *    would hit a torn-down runtime. The historical idiom
 *    `JSON.parse(JSON.stringify(await result.pull()))` achieved this as a side
 *    effect of the serialize round-trip: it eagerly reads every nested value and
 *    rebuilds a fresh tree of plain containers.
 *
 * 2. **Fabric-safety.** `JSON.stringify` serializes non-plain "fabric" values
 *    (`FabricInstance` / `FabricPrimitive` wrappers such as `FabricBytes`,
 *    `FabricHash`, `FabricEpochNsec`) as `{}` — a SILENT, total loss of the
 *    payload. Today's callers only ever pull plain JSON, so the round-trip is
 *    currently harmless, but the idiom becomes a trap the moment a
 *    fabric-valued output (or a fabric-valued field inside an otherwise-plain
 *    result) is snapshotted.
 *
 * `nativeFromFabricValue` — the canonical inverse of `fabricFromNativeValue`,
 * the exact converter the runner applies on writes — does both jobs correctly:
 * it unwraps native-backed fabric wrappers (e.g. `FabricError`) to their native
 * equivalents, passes immutable fabric primitives through by identity (they are
 * self-contained and survive dispose — never collapsed to `{}`), and rebuilds a
 * fresh, detached tree of plain containers. We reuse it rather than rolling our
 * own codec (repo rule against duplicating serialization/clone machinery).
 *
 * Note `cloneIfNecessary` is deliberately NOT used here: it is typed for an
 * already-valid `FabricValue` tree, deep-clones fabric values *keeping them as
 * fabric* (it would never turn a wrapper into its native form), and freezes by
 * default — none of which fits detaching a query-result view into plain data.
 */

/**
 * Convert an already-pulled value into a fabric-safe, fully-detached plain-data
 * snapshot. `frozen: false` yields mutable plain containers, matching the
 * mutability of the old `JSON.parse(JSON.stringify(...))` output.
 */
export function snapshotValue(pulled: unknown): unknown {
  return nativeFromFabricValue(pulled as FabricValue, false);
}

/**
 * Await `result.pull()` and return a fabric-safe, fully-detached snapshot of the
 * pulled value. Drop-in replacement for
 * `JSON.parse(JSON.stringify(await result.pull()))` that additionally survives a
 * fabric-valued output (which `JSON.stringify` would corrupt to `{}`). The
 * snapshot is materialized before returning, so it is safe to compare after the
 * runtime has been disposed.
 */
export async function pullSnapshot(
  result: { pull(): Promise<unknown> },
): Promise<unknown> {
  return snapshotValue(await result.pull());
}
