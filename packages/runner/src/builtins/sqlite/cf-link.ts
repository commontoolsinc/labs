// _cf_link codec (spec docs/specs/sqlite-builtin/02).
//
// A column whose name ends in `_cf_link` stores a cell reference as an absolute
// sigil-link JSON string. On write a cell is encoded; on read the string is
// decoded back to a live Cell. Cells may only be persisted via link columns —
// binding a cell to any other column throws (enforced by the write builtin),
// and a non-cell bound to a link column throws here.

import type { JSONSchema } from "../../builder/types.ts";
import type { Runtime } from "../../runtime.ts";
import type { Cell } from "../../cell.ts";
import { isCell } from "../../cell.ts";
import { toCell } from "../../back-to-cell.ts";
import type { IExtendedStorageTransaction } from "../../storage/interface.ts";
import {
  createSigilLinkFromParsedLink,
  isCellLink,
} from "../../link-utils.ts";
import type { NormalizedFullLink } from "../../link-types.ts";

export const CF_LINK_SUFFIX = "_cf_link";

/** A column/parameter is a link column iff its name ends in `_cf_link` (with a
 *  non-empty prefix). */
export function isCfLinkColumn(name: string): boolean {
  return name.length > CF_LINK_SUFFIX.length && name.endsWith(CF_LINK_SUFFIX);
}

/** Recover a Cell from a value that is a cell or carries a `toCell` back-pointer. */
function asCellOrUndefined(value: unknown): Cell<unknown> | undefined {
  if (isCell(value)) return value as Cell<unknown>;
  if (
    value !== null && typeof value === "object" &&
    typeof (value as { [toCell]?: unknown })[toCell] === "function"
  ) {
    return (value as { [toCell]: () => Cell<unknown> })[toCell]();
  }
  return undefined;
}

/**
 * Encode a cell reference to an absolute sigil-link JSON string for storage.
 * The link is absolute (carries id, space, scope) so the row is resolvable
 * independent of any base document or space. Throws if `value` is not a cell.
 */
export function encodeCfLinkValue(value: unknown): string {
  const cell = asCellOrUndefined(value);
  if (!cell) {
    throw new TypeError(
      "_cf_link columns store cell references only; got a non-cell value",
    );
  }
  const link: NormalizedFullLink = cell.getAsNormalizedFullLink();
  // No `base`/`baseSpace` => absolute link (id + space + scope included).
  // `includeSchema: false` => strip schema/asCell flags from the stored sigil.
  const sigil = createSigilLinkFromParsedLink(link, { includeSchema: false });
  return JSON.stringify(sigil);
}

/**
 * Decode a stored `_cf_link` value back to a live Cell. `null` decodes to null.
 * Throws on non-null, non-string values, on malformed JSON, or on JSON that is
 * not a single sigil link.
 */
export function decodeCfLinkValue(
  value: unknown,
  runtime: Runtime,
  schema?: JSONSchema,
  tx?: IExtendedStorageTransaction,
): Cell<unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(
      `_cf_link columns hold a sigil-link string or NULL; got ${typeof value}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("_cf_link value is not valid JSON");
  }
  if (!isCellLink(parsed)) {
    throw new TypeError("_cf_link value is not a sigil link");
  }
  return runtime.getCellFromLink(parsed, schema, tx);
}
