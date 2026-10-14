/**
 * Where a piece's setup keeps the stored argument slots its new argument
 * schema refused, so that leaving a slot out of an update never destroys what
 * the slot held.
 *
 * A nested piece whose code changed is set up again over its existing argument
 * document, and a stored slot the new schema refuses is left out of that
 * argument and filled with its default. The value it held is copied first, in
 * the same transaction, into a store of the piece's own: a document minted
 * from the piece's result cell, in its space. The copy carries the stored bytes
 * as they were, links included, so a later version or a person can read and
 * restore it.
 */

import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";

import { isCellLink, type NormalizedFullLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/** The address of a piece's result cell, which is all that names its store. */
export type PieceAddress = Pick<NormalizedFullLink, "space" | "id">;

/** One refused value, as the setup that refused it left it. */
export interface RefusedArgumentSlot {
  /** The slot's stored value, as raw stored bytes. */
  value: FabricValue;

  /** Why the new argument schema refused it. */
  reason: string;
}

/**
 * The store's contents: by slot, then by the `identity#symbol` of the pattern
 * whose setup refused it. Setting the same pattern up again over the same
 * value rewrites the same entry, so the store grows only as new versions
 * refuse new values.
 */
export type RefusedArgumentSlots = Record<
  string,
  Record<string, RefusedArgumentSlot>
>;

/**
 * The cause naming the refused-slot store of the piece whose result cell is
 * `piece`.
 * Derived from that cell alone, so anything holding the piece can find the
 * store without its address having been written anywhere, and the runtime can
 * name it as a store it owns for that piece.
 */
export function refusedArgumentSlotsCause(piece: PieceAddress) {
  return { refusedArgumentSlots: piece.id };
}

/** The refused-slot store of the piece whose result cell is `piece`. */
export function refusedArgumentSlotsCell(
  runtime: Runtime,
  piece: PieceAddress,
  tx?: IExtendedStorageTransaction,
) {
  return runtime.getCell<RefusedArgumentSlots>(
    piece.space,
    refusedArgumentSlotsCause(piece),
    undefined,
    tx,
  );
}

/**
 * Copies each slot in `refused` out of `stored`, the raw value of the argument
 * document of the piece whose result cell is `piece`, into that piece's store
 * under `refusedBy`, through `tx`. A slot holding nothing has nothing to keep
 * and is skipped. Returns the store, or `undefined` when nothing was copied.
 */
export function keepRefusedArgumentSlots(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  piece: PieceAddress,
  stored: unknown,
  refused: ReadonlyMap<string, string>,
  refusedBy: string,
): NormalizedFullLink | undefined {
  if (!isFabricPlainObject(stored as FabricValue) || isCellLink(stored)) {
    return undefined;
  }
  const slots = stored as Record<string, FabricValue>;
  const kept = [...refused].filter(([slot]) =>
    Object.hasOwn(slots, slot) && slots[slot] !== undefined
  );
  if (kept.length === 0) return undefined;

  const store = refusedArgumentSlotsCell(runtime, piece, tx);
  const current = store.getRawUntyped({ meta: ignoreReadForScheduling });
  const next: Record<string, FabricValue> = isFabricPlainObject(current)
    ? { ...current }
    : {};
  for (const [slot, reason] of kept) {
    const prior = next[slot];
    next[slot] = {
      ...(isFabricPlainObject(prior) ? prior : {}),
      [refusedBy]: { value: slots[slot], reason },
    };
  }
  store.setRawUntyped(next);
  return store.getAsNormalizedFullLink();
}
