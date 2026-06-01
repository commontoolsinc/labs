// Tokenizer-level statement guard for the SQLite builtins.
//
// `@db/sqlite` exposes no `sqlite3_set_authorizer`, so we cannot have SQLite
// enumerate the objects a statement touches. Instead we apply a conservative,
// tokenizer-level guard (no full SQL parser): mask string literals and strip
// comments, then check the leading keyword, statement count, schema-qualified
// references, forbidden verbs (PRAGMA/ATTACH/DETACH), and references to core
// engine table names.
//
// This is intentionally conservative — it can have minor false positives (e.g.
// a column literally named `commit`). That residual is documented in
// docs/specs/sqlite-builtin/08-open-questions.md (Q8a). The full structural fix
// is the space-DID core-table rename, deferred behind a flag.

/** Core engine table names a pattern statement must never reference. */
export const CORE_TABLE_NAMES: readonly string[] = [
  "commit",
  "revision",
  "head",
  "snapshot",
  "branch",
  "blob_store",
  "authorization",
  "invocation",
  "scheduler_observation",
  "scheduler_action_snapshot",
  "scheduler_read_index",
  "scheduler_write_index",
  "_cf_commit_watermark",
];

export type StatementKind = "select" | "write" | "other";

export interface StatementClassification {
  /** Leading-keyword classification. */
  kind: StatementKind;
  /** More than one statement (after dropping a trailing `;`). */
  multiple: boolean;
  /** A schema-qualified table reference (`db.table`) in a table position. */
  qualified: boolean;
  /** Contains a forbidden verb: PRAGMA / ATTACH / DETACH. */
  forbidden: boolean;
  /** References a core engine table name. */
  coreRef: boolean;
}

export class GuardError extends Error {
  override name = "GuardError";
  constructor(reason: string, sql: string) {
    super(`SQLite statement rejected: ${reason}\n  in: ${sql}`);
  }
}

const WRITE_LEADING = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

/**
 * Remove SQL comments and replace the contents of string/quoted-identifier
 * literals with spaces, so subsequent regexes don't trip on `;`, keywords, or
 * table names that appear inside literals.
 */
function maskLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    // line comment
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // string / quoted identifier literals: ' " `  and [ ... ]
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      out += " ";
      while (i < n) {
        if (sql[i] === quote) {
          // doubled quote = escaped quote, stays inside the literal
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (ch === "[") {
      i++;
      out += " ";
      while (i < n && sql[i] !== "]") i++;
      i++;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function classifyStatement(sql: string): StatementClassification {
  const masked = maskLiteralsAndComments(sql);
  const trimmed = masked.replace(/;[\s;]*$/, "").trim();

  const multiple = /;/.test(trimmed);

  const firstKeyword = (trimmed.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  const hasTopLevelWrite = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(masked);

  let kind: StatementKind;
  if (WRITE_LEADING.has(firstKeyword)) {
    kind = "write";
  } else if (firstKeyword === "SELECT") {
    kind = "select";
  } else if (firstKeyword === "WITH") {
    kind = hasTopLevelWrite ? "write" : "select";
  } else {
    kind = "other";
  }

  const qualified =
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*/i.test(
      masked,
    );

  const forbidden = /\b(?:PRAGMA|ATTACH|DETACH)\b/i.test(masked);

  const coreRe = new RegExp(`\\b(?:${CORE_TABLE_NAMES.join("|")})\\b`, "i");
  const coreRef = coreRe.test(masked);

  return { kind, multiple, qualified, forbidden, coreRef };
}

function assertCommon(c: StatementClassification, sql: string): void {
  if (c.multiple) throw new GuardError("multiple statements are not allowed", sql);
  if (c.forbidden) {
    throw new GuardError("PRAGMA/ATTACH/DETACH are not allowed", sql);
  }
  if (c.qualified) {
    throw new GuardError(
      "schema-qualified table references are not allowed",
      sql,
    );
  }
  if (c.coreRef) {
    throw new GuardError("references a reserved core table name", sql);
  }
}

/** Throw unless `sql` is a single, safe, read-only SELECT (or read-only CTE). */
export function assertReadOnly(sql: string): void {
  const c = classifyStatement(sql);
  if (c.kind !== "select") {
    throw new GuardError("only a single read-only SELECT is allowed", sql);
  }
  assertCommon(c, sql);
}

/** Throw unless `sql` is a single, safe INSERT/UPDATE/DELETE (no DDL). */
export function assertWriteSafe(sql: string): void {
  const c = classifyStatement(sql);
  if (c.kind !== "write") {
    throw new GuardError(
      "only a single INSERT/UPDATE/DELETE is allowed (DDL is owned by the database)",
      sql,
    );
  }
  assertCommon(c, sql);
}
