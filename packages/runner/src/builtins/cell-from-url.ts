import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { MemorySpace } from "../storage/interface.ts";
import type { URI } from "../sigil-types.ts";
import { parseFabricUrl } from "../fabric-url.ts";
import { slugIdForSpace } from "../slugs.ts";

/**
 * cellFromUrl({ url, hosts }) — the cell a URL names, if it names one.
 *
 * A URL that names no cell resolves with no `cell`. That is an answer, not a
 * failure: most URLs are web pages, and a caller asking this question expects
 * to be told no.
 *
 * **Why this is a builtin.** Every part of the question is on its way to being
 * asynchronous. Deciding whether an unfamiliar host is a fabric host will mean
 * probing it, and turning a space name into a DID is a cached derivation today
 * and a lookup later. Only reading the string apart and hashing a slug stay
 * synchronous. Callers get the `{ pending, … }` shape every other builtin has,
 * so none of them changes when the work behind it grows.
 *
 * **What this implementation does not do yet.** It resolves from the host list
 * it is given and from space names the runtime has already cached
 * (`resolveSpaceNameSync`). A URL naming a space by a name this runtime has
 * not seen resolves to no cell rather than waiting for one — the narrow case,
 * since a same-space URL carries no space at all and a cross-space one usually
 * carries a DID.
 */
export function cellFromUrl(
  inputsCell: Cell<{ url: string; hosts?: string[] }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const pending = runtime.getCell<boolean>(
      parentCell.space,
      { cellFromUrl: { pending: cause } },
      undefined,
      tx,
    );
    const cell = runtime.getCell<unknown>(
      parentCell.space,
      { cellFromUrl: { cell: cause } },
      undefined,
      tx,
    );
    sendResult(tx, { pending, cell });

    const inputs = inputsCell.withTx(tx);
    const url = inputs.key("url").get();
    const hosts = inputs.key("hosts").get();

    const target = typeof url === "string"
      ? parseFabricUrl(url, { hosts: Array.isArray(hosts) ? hosts : undefined })
      : undefined;

    const space = resolveSpace(runtime, parentCell.space, target?.space);
    const id = target && space ? entityUri(space, target) : undefined;

    const cellWithTx = cell.withTx(tx);
    if (id === undefined) {
      // The SLOT, not what it points at: reading through a stored link to an
      // empty cell answers undefined, and a guard on that would leave the
      // previous URL's link in place after the input stopped naming anything.
      if (cellWithTx.getRaw() !== undefined) cellWithTx.set(undefined);
    } else {
      const targetCell = runtime.getCellFromLink({
        id,
        space,
        path: target!.path,
        scope: "space",
      } as any);
      cellWithTx.setRawUntyped(targetCell.getAsLink({ base: cell }));
    }

    const pendingWithTx = pending.withTx(tx);
    if (pendingWithTx.get() !== false) pendingWithTx.set(false);
  };
}

/**
 * The space a target names, as a DID. A target naming none is in the space
 * doing the asking, which is what an unqualified URL means.
 */
function resolveSpace(
  runtime: Runtime,
  ownSpace: MemorySpace,
  named: string | undefined,
): MemorySpace | undefined {
  if (named === undefined) return ownSpace;
  return runtime.resolveSpaceNameSync(named);
}

/**
 * The URI of the cell a target addresses. A slug addresses the redirect
 * document that names the piece rather than the piece itself, which is why
 * hashing it is enough: reads follow the redirect.
 */
function entityUri(
  space: MemorySpace,
  target: { id?: string; slug?: string },
): URI | undefined {
  if (target.id !== undefined) return target.id as URI;
  if (target.slug === undefined) return undefined;
  return `of:${slugIdForSpace(space, target.slug)}` as URI;
}
