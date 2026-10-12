import { isObjectOrArray } from "@commonfabric/utils/types";

import { isCell } from "./cell.ts";
import { ensureSpaceRootPattern } from "./ensure-space-root.ts";
import type { Runtime } from "./runtime.ts";
import { spaceCellId } from "./space-root-slot.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";

/**
 * The creation of a Home's root under way in a runtime, by Home space, shared
 * by every handler that waits on it.
 */
const homeRootCreations = new WeakMap<
  Runtime,
  Map<MemorySpace, Promise<void>>
>();

/**
 * Helper for {@link bringUpHomeRootForWrites}, which brings the root of `home`
 * into being, sharing a creation already under way in `runtime`. Resolves once
 * `home` links a root, whoever created it.
 */
function createHomeRoot(runtime: Runtime, home: MemorySpace): Promise<void> {
  let creations = homeRootCreations.get(runtime);
  if (!creations) {
    creations = new Map();
    homeRootCreations.set(runtime, creations);
  }
  let creation = creations.get(home);
  if (!creation) {
    const settling = creations;
    creation = ensureSpaceRootPattern(runtime, home, { isHomeSpace: true })
      .then(() => {})
      .finally(() => settling.delete(home));
    creations.set(home, creation);
  }
  return creation;
}

/**
 * Brings the user's Home root into being ahead of a handler that writes
 * beneath it, on a client runtime. `inputs` is the handler's argument, as its
 * input presync materializes it in `tx`. When a cell among the top-level values
 * of its bound state resolves beneath the `defaultPattern` slot of the user's own Home space while
 * that slot is empty, the root is created first, so that the handler's write
 * lands under the root rather than being refused (`SpaceRootMissingError`). A
 * wish hands out such a cell for a Home target while Home has no root. A
 * serving runtime creates no Home root, so there such a write is refused.
 */
export async function bringUpHomeRootForWrites(
  runtime: Runtime,
  inputs: unknown,
  tx: IExtendedStorageTransaction,
): Promise<void> {
  if (runtime.servingPosture) return;
  // A handler's argument carries its bound state under `$ctx`, beside the
  // event under `$event`.
  const state = isObjectOrArray(inputs) && "$ctx" in inputs
    ? inputs.$ctx
    : undefined;
  if (!isObjectOrArray(state)) return;
  const home = runtime.userIdentityDID as MemorySpace;
  const homeSpaceCellId = spaceCellId(home);
  for (const value of Object.values(state)) {
    if (!isCell(value)) continue;
    const { space, id, path } = value.withTx(tx).resolveAsCell()
      .getAsNormalizedFullLink();
    if (
      space !== home || id !== homeSpaceCellId || path.length < 2 ||
      path[0] !== "defaultPattern"
    ) {
      continue;
    }
    const slot = runtime.getHomeSpaceCell(tx).key("defaultPattern").getRaw();
    if (slot === undefined) await createHomeRoot(runtime, home);
    return;
  }
}
