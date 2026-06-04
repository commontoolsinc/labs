// Pure `_cf_link` codec — the cell↔sigil-string encode and the sigil
// parse/validate prologue — shared by BOTH the write path (`encodeSqliteParams`
// / `db.exec` in cell.ts) and the read/write helpers in cf-link.ts, so they
// produce and parse BYTE-IDENTICAL sigil strings.
//
// This module depends only on `link-utils` + types — it has NO runtime import
// of cell.ts (the `Cell` import below is type-only, erased at build) — so cell.ts
// can import it without the cell.ts ↔ cf-link.ts cycle (08-open-questions #24).

import type { Cell } from "../../cell.ts";
import type { NormalizedFullLink } from "../../link-types.ts";
import {
  type CellLink,
  createSigilLinkFromParsedLink,
  isCellLink,
} from "../../link-utils.ts";

/**
 * Encode a bound Cell to the stored `_cf_link` sigil-link JSON string: an
 * ABSOLUTE link (id + space + scope, no `base`/`baseSpace`) with `schema`/
 * `asCell` stripped (`includeSchema: false`), so the row resolves independent of
 * any base document and stores no schema flags.
 */
export function encodeCellToSigilString(cell: Cell<unknown>): string {
  const link: NormalizedFullLink = cell.getAsNormalizedFullLink();
  const sigil = createSigilLinkFromParsedLink(link, { includeSchema: false });
  return JSON.stringify(sigil);
}

/**
 * Parse + validate a stored `_cf_link` value to its sigil-link OBJECT (or `null`
 * for SQL NULL). This is the shared prologue of both `decodeCfLinkValue` (which
 * then hydrates the sigil to a live Cell via the runtime) and the `asCell`
 * query-result read path (which stores the sigil for deferred rehydration).
 * Throws on a non-null/non-string value, malformed JSON, or JSON that is not a
 * single sigil link.
 */
export function parseCfLinkToSigil(value: unknown): CellLink | null {
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
  return parsed;
}
