#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Guards tasks/test-identity-aliases.jsonl, the append-only file that
 * bridges test-identity renames for readers of the test-run record store
 * (docs/plans/test-run-telemetry.md). Each line maps an old identity — or
 * a whole scope, for package renames — to its replacement, with the date
 * of the rename; readers resolve aliases transitively and apply one only
 * to records older than its date.
 *
 * The file is history, so this gate holds it to history's rules: existing
 * lines are never edited or removed (the committed content must be a
 * prefix of the new content), every line must parse, no identity may be
 * mapped twice, and the mapping graph must have no cycle — a cycle would
 * send resolution around forever and means someone renamed something back,
 * which is a new rename with its own line, not an edit to an old one.
 *
 * Usage: check-test-aliases.ts [base-ref]   (default: origin/main)
 */

const ALIAS_FILE = "tasks/test-identity-aliases.jsonl";

/** One alias line: a full-identity mapping or a whole-scope mapping. */
export interface AliasLine {
  /** ISO date of the rename; readers apply the alias to older records. */
  date: string;
  from: { k: string; s: string; n?: string };
  to: { k: string; s: string; n?: string };
}

function isIdentityPart(value: unknown, wholeScope: boolean): boolean {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  if (typeof part.k !== "string" || part.k.length === 0) return false;
  if (typeof part.s !== "string" || part.s.length === 0) return false;
  if (wholeScope) return part.n === undefined;
  return typeof part.n === "string" && part.n.length > 0;
}

/** Parses one line; returns an error message instead of a value when bad. */
export function parseAliasLine(line: string): AliasLine | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "is not JSON";
  }
  if (typeof value !== "object" || value === null) return "is not an object";
  const alias = value as Record<string, unknown>;
  if (
    typeof alias.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(alias.date)
  ) {
    return "has no ISO date";
  }
  const wholeScope = (alias.from as Record<string, unknown> | null)?.n ===
    undefined;
  if (!isIdentityPart(alias.from, wholeScope)) {
    return "has a malformed `from`";
  }
  if (!isIdentityPart(alias.to, wholeScope)) {
    return wholeScope
      ? "maps a whole scope to a single identity"
      : "has a malformed `to`";
  }
  return value as AliasLine;
}

function keyOf(part: { k: string; s: string; n?: string }): string {
  // A JSON array: printable, and unambiguous for names with any content.
  return JSON.stringify([part.k, part.s, part.n ?? null]);
}

/**
 * Structural problems across the whole file: a second mapping from one
 * identity, and cycles under transitive resolution.
 */
export function aliasGraphProblems(aliases: readonly AliasLine[]): string[] {
  const problems: string[] = [];
  const byFrom = new Map<string, AliasLine>();
  for (const alias of aliases) {
    const from = keyOf(alias.from);
    if (byFrom.has(from)) {
      problems.push(
        `two mappings from ${JSON.stringify(alias.from)}; an identity is ` +
          "mapped at most once",
      );
      continue;
    }
    byFrom.set(from, alias);
  }
  for (const alias of byFrom.values()) {
    const start = keyOf(alias.from);
    const seen = new Set<string>([start]);
    let cursor = byFrom.get(keyOf(alias.to));
    while (cursor !== undefined) {
      const from = keyOf(cursor.from);
      if (from === start) {
        problems.push(
          `cycle through ${JSON.stringify(alias.from)}; a rename back is a ` +
            "new rename with its own line",
        );
        break;
      }
      if (seen.has(from)) break;
      seen.add(from);
      cursor = byFrom.get(keyOf(cursor.to));
    }
  }
  return problems;
}

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

async function main(): Promise<void> {
  const base = Deno.args[0] ?? "origin/main";
  let mergeBase: string;
  try {
    mergeBase = (await git("merge-base", base, "HEAD")).trim();
  } catch (error) {
    console.error(
      `Cannot find the merge base with ${base}: ${error}\n` +
        "CI must check out with fetch-depth: 0.",
    );
    Deno.exit(2);
  }

  let committed = "";
  try {
    committed = await git("show", `${mergeBase}:${ALIAS_FILE}`);
  } catch {
    // The file did not exist at the merge base; everything present is new.
  }
  const current = await Deno.readTextFile(ALIAS_FILE);

  if (!current.startsWith(committed)) {
    console.error(
      `${ALIAS_FILE} rewrites history: the content at ${
        mergeBase.slice(0, 12)
      } is no longer a prefix of the working copy. The alias file is ` +
        "append-only — a wrong line is superseded by a newer line, never " +
        "edited.",
    );
    Deno.exit(1);
  }

  const problems: string[] = [];
  const aliases: AliasLine[] = [];
  const lines = current.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const parsed = parseAliasLine(line);
    if (typeof parsed === "string") {
      problems.push(`line ${i + 1} ${parsed}`);
      continue;
    }
    aliases.push(parsed);
  }
  problems.push(...aliasGraphProblems(aliases));

  if (problems.length > 0) {
    console.error(`${ALIAS_FILE} has ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    Deno.exit(1);
  }
  console.log(
    `${ALIAS_FILE}: ${aliases.length} alias(es), append-only and acyclic.`,
  );
}

if (import.meta.main) {
  await main();
}
