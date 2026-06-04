// Map each positional `?` in a write statement to the column it writes — for the
// CFC write-ceiling check (a labeled value must fit its target column's ceiling).
//
// CONSERVATIVE + FAIL-CLOSED. Returns `undefined` for any shape it can't
// confidently attribute (columnless INSERT, INSERT…SELECT, upsert, a complex SET
// expression, a subquery in SET, mixed/named params); the caller then REJECTS a
// labeled value it cannot verify. A column write maps to the column name; a
// non-column param (e.g. a `WHERE` filter value, a `DELETE` filter) maps to
// `null` (no ceiling check needed). A complex `WHERE` is fine — its params are
// simply `null` — only a complex SET/target fails closed.

/** Blank string literals and comments to spaces so `?`/keywords/`,` inside them
 *  can't fool the structural checks. Identifiers are left intact. */
function blankStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " '' "; // a blanked string literal placeholder (no inner chars)
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Count positional `?` placeholders (the blanked SQL has no string `?`s). A
 *  named/numbered param (`:x`, `@x`, `$x`, `?1`) makes positional attribution
 *  unsafe → caller should fail closed; we surface that via `hasNonPositional`. */
function placeholderInfo(
  blanked: string,
): { count: number; hasNonPositional: boolean } {
  let count = 0;
  let hasNonPositional = false;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === "?") {
      // `?NNN` numbered params are non-positional for our purposes.
      if (/[0-9]/.test(blanked[i + 1] ?? "")) hasNonPositional = true;
      else count++;
    } else if (c === ":" || c === "@" || c === "$") {
      if (/[A-Za-z_]/.test(blanked[i + 1] ?? "")) hasNonPositional = true;
    }
  }
  return { count, hasNonPositional };
}

const COLUMN_LIST_VALUES =
  /\binsert\b[\s\S]*?\binto\b\s+[^()]+?\(([^)]*)\)\s*values\b/i;

function leadingKeyword(blanked: string): string {
  return (blanked.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
}

function unquoteIdent(raw: string): string {
  return raw.trim().replace(/^["'`[]|["'`\]]$/g, "");
}

export function parseWriteParamColumns(
  sql: string,
): (string | null)[] | undefined {
  const blanked = blankStringsAndComments(sql);
  const { count, hasNonPositional } = placeholderInfo(blanked);
  if (hasNonPositional) return undefined; // mixed/named/numbered → fail closed
  if (count === 0) return [];

  const kw = leadingKeyword(blanked);

  if (kw === "DELETE") {
    // DELETE writes no column values; every param is a filter → null.
    return new Array(count).fill(null);
  }

  if (kw === "INSERT" || kw === "REPLACE") {
    // Upsert binds params in a trailing DO UPDATE SET — positional cycling would
    // mis-map them. Fail closed.
    if (/\bon\s+conflict\b/i.test(blanked)) return undefined;
    const m = blanked.match(COLUMN_LIST_VALUES);
    if (!m) return undefined; // columnless INSERT or INSERT…SELECT → fail closed
    const cols = m[1].split(",").map(unquoteIdent);
    if (cols.length === 0 || cols.some((c) => c.length === 0)) return undefined;
    // Positional params cycle across multi-row `VALUES (?),(?)` tuples.
    return Array.from({ length: count }, (_, i) => cols[i % cols.length]);
  }

  if (kw === "UPDATE") {
    // Isolate the SET region: between the first top-level `SET` and the first
    // top-level boundary keyword (WHERE/RETURNING/FROM) or end. Track paren depth
    // so a subquery's own WHERE/comma doesn't end the region prematurely.
    const setIdx = blanked.search(/\bset\b/i);
    if (setIdx === -1) return undefined;
    let i = setIdx + 3;
    let depth = 0;
    let region = "";
    for (; i < blanked.length; i++) {
      const c = blanked[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0) {
        const rest = blanked.slice(i);
        if (/^\s*\b(where|returning|from)\b/i.test(rest)) break;
      }
      region += c;
    }
    if (depth !== 0) return undefined; // unbalanced → fail closed
    // The SET region must be ONLY simple `ident = ?` assignments (top-level
    // commas). A parenthesis, subquery, or non-`?` value → fail closed.
    if (region.includes("(") || region.includes(")")) return undefined;
    const assignments = region.split(",");
    const setCols: string[] = [];
    for (const a of assignments) {
      const m = a.match(
        /^\s*("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*=\s*\?\s*$/,
      );
      if (!m) return undefined; // not exactly `ident = ?` → fail closed
      setCols.push(unquoteIdent(m[1]));
    }
    // SET params come first (one `?` each, before WHERE); remaining params (in
    // WHERE/RETURNING) write no column.
    if (setCols.length > count) return undefined;
    return Array.from(
      { length: count },
      (_, idx) => (idx < setCols.length ? setCols[idx] : null),
    );
  }

  return undefined; // unknown write shape → fail closed
}
