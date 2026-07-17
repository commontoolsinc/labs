import type { Cell } from "../cell.ts";
import { createCell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { resolveLink } from "../link-resolution.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import { narrowestScope, scopeRank } from "../scope.ts";
import {
  createSigilLinkFromParsedLink,
  getMetaLink,
  parseLink,
} from "../link-utils.ts";

export function resolvedCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<any>,
): CellScope {
  return resolveLink(runtime, tx, cell.getAsNormalizedFullLink()).scope;
}

export function scopedCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  scope: CellScope,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.scope === scope) {
    return cell;
  }
  return createCell<T>(runtime, { ...link, scope }, tx);
}

/**
 * The position-derived identity coordinates (`space`/`id`/`path`) of a node's
 * resolved output binding — the stable, program-independent cause that
 * map/filter/flatMap key their result container on (CT-1623). Deliberately
 * drops `scope`/`schema` so the identity stays scope-independent (a scoped vs
 * unscoped container at the same spot share one id; scope re-addresses the
 * instance, it does not fork identity).
 */
export function outputSpotFromBinding(
  binding: NormalizedFullLink | undefined,
): { space: string; id: string; path: readonly unknown[] } | undefined {
  if (!binding) return undefined;
  return { space: binding.space, id: binding.id, path: [...binding.path] };
}

/** The output-spot identity coordinates a list builtin keys its container on. */
export type ListBuiltinOutputSpot = NonNullable<
  ReturnType<typeof outputSpotFromBinding>
>;

/** Canonical registry names of the container-minting list builtins. */
export type ListBuiltinContainerKey = "map" | "filter" | "flatMap";

/**
 * The `getCell` cause map/filter/flatMap key their result container on
 * (CT-1623): the builtin name paired with the parent entity and the
 * position-derived output spot. The container is a side document distinct from
 * the node's direct output — the builtin writes the whole output collection
 * (array plus per-slot element links) into it. Extracted as the single source
 * of that identity so the servability layer can re-derive the SAME container
 * entity at registration for the materializer write envelope (W2.16). Both
 * sites MUST agree on this cause or a claimed run de-claims fail-closed. Schema
 * and scope deliberately do not participate (see `outputSpotFromBinding`), so a
 * caller may pass any schema/tx to `getCell` and still land the same entity id.
 */
export function listBuiltinResultContainerCause(
  builtinKey: ListBuiltinContainerKey,
  parentEntityId: unknown,
  outputSpot: ListBuiltinOutputSpot,
): Record<string, unknown> {
  return { [builtinKey]: parentEntityId, outputSpot };
}

/** Canonical registry names of the result-minting pure selector builtins. */
export type SelectorBuiltinKey = "ifElse" | "when" | "unless";

/**
 * The `getCell` cause ifElse/when/unless key their minted result document on:
 * the builtin name paired with the per-node registration cause (the
 * `{ inputs, parents, outputSpot }` object the runner hands every raw builtin).
 * The minted result is a side document distinct from the node's direct output
 * spot — the spot only ever stores a link to it, while every output-producing
 * run `setRawUntyped`s the selected branch's reference INTO it. Extracted as
 * the single source of that identity so the servability layer can re-derive
 * the SAME minted document at registration for the selector descriptor's write
 * surface (W2.15a re-open, FB3) — the exact `listBuiltinResultContainerCause`
 * precedent. Both sites MUST agree on this cause or every output-producing
 * selector run de-claims fail-closed at the dynamic write firewall.
 */
export function selectorBuiltinResultCause(
  builtinKey: SelectorBuiltinKey,
  cause: unknown,
): Record<string, unknown> {
  return { [builtinKey]: cause };
}

export function cellIdentityKey(cell: Cell<any>): {
  dedupKey: string;
  linkKey: readonly unknown[];
} {
  const { space, id, path, scope } = cell.getAsNormalizedFullLink();
  const linkKey = [space, id, scope, path] as const;
  return {
    dedupKey: JSON.stringify(linkKey),
    linkKey,
  };
}

export function narrowestCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cells: Iterable<Cell<any> | undefined>,
): CellScope {
  return narrowestScope(
    Array.from(
      cells,
      (cell) =>
        cell === undefined ? undefined : resolvedCellScope(runtime, tx, cell),
    ),
  );
}

/**
 * If the cell contains a top level link, and its scope is narrower than the
 * cell's scope, create a copy of the cell.
 *
 * Copy over the value and the "result" meta link.
 */
export function exposedResultCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
): Cell<T> {
  // Ideally, we'd just call getRaw on the cell, but since that may be a link,
  // we need to know the base to use to parse that link.
  // Coordinator scaffolding (machineryRead): the redirect resolution reads
  // link topology only and must not consume `*`-path membership templates
  // on plumbing containers (template-population §6). The value COPY below
  // stays unmarked — the exposed cell genuinely depends on it.
  const target = tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      resolveLink(
        runtime,
        tx,
        cell.getAsNormalizedFullLink(),
        "writeRedirect",
      ),
  );
  const initialCell = cell.withTx(tx);
  // Identity probe: the raw value is only link-parsed to decide which
  // target the exposed cell should point at — content is never consumed
  // (a non-link value just fails the parse). Run it under the
  // link-resolution-probe scope so flow-label derivation treats it as
  // link topology, not a content read (S16 — without this, a list
  // coordinator rebuilding its output array re-consumes every reused
  // element result's label and smears it across fresh elements).
  const raw = tx.runWithAmbientReadMeta(
    { ...linkResolutionProbe, ...machineryRead },
    () => initialCell.getRaw({ lastNode: "writeRedirect" }),
  );
  // If the last writeRedirect target is a link, use that, but otherwise use
  // the last writeRedirect target.
  const link = parseLink(raw, target) ?? target;
  if (
    link === undefined ||
    scopeRank(link.scope) <= scopeRank(cell.getAsNormalizedFullLink().scope)
  ) {
    return cell;
  }

  const exposed = scopedCell(runtime, tx, cell, link.scope);
  // Copy the value and result linkage into the new exposed cell
  const resultLink = getMetaLink(initialCell, "result");
  if (resultLink !== undefined) {
    exposed.setMetaRaw(
      "result",
      createSigilLinkFromParsedLink(resultLink, {
        base: exposed,
        includeSchema: true,
      }),
    );
  }
  const value = initialCell.get();
  if (value !== undefined) {
    exposed.withTx(tx).set(value);
  }
  return exposed;
}
