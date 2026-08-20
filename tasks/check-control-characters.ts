#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Fails when a tracked source file contains a control codepoint below 0x20
 * other than newline.
 *
 * A literal control character in source is almost always meant as a value —
 * `"\x00"` written as the byte rather than the escape — and it reads
 * identically to the escape at runtime while behaving differently everywhere
 * a person or a tool looks at the FILE.
 *
 * A single NUL is the sharp case, because it flips the binary heuristic for
 * the whole file: `file` reports `data` rather than source, `grep` skips the
 * file silently rather than erroring, and the GitHub diff view renders the
 * line wrong. A reader who greps for a symbol in such a file is told there
 * are no matches, which is worse than being told nothing — the answer looks
 * like an answer. The escape sequence produces the same string with none of
 * that, so nothing is given up by requiring it.
 *
 * Newline is the one exception, since it is what separates the lines. A
 * carriage return is not: a CRLF file is a line-ending accident here, and a
 * lone CR moves the cursor rather than the line. Tab is not either — the
 * formatter indents with spaces, so a literal tab in source is a stray.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-control-characters.ts
 */

import { dirname, fromFileUrl } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * Extensions this governs: the languages the repository AUTHORS.
 *
 * Scoped by extension rather than applied to every tracked file because the
 * tree also carries fixtures and recordings that are text by accident, where
 * a control byte may be the data itself rather than a mistake.
 */
const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".jsonc",
];

/**
 * Paths whose contents this repository does not author.
 *
 * The bundled TypeScript library declarations arrive from upstream with CRLF
 * endings. Rewriting them would be a change to a vendored artifact for the
 * sake of a rule about our own source, and re-vendoring would undo it.
 */
const VENDORED_PREFIXES: readonly string[] = [
  "packages/static/assets/types/",
];

/** The one control codepoint a source file may contain. */
const NEWLINE = 0x0a;

export function isGovernedPath(path: string): boolean {
  if (VENDORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export interface ControlViolation {
  file: string;
  line: number;
  /** The offending codepoint, e.g. `0x00`. */
  code: number;
  /** How many times it occurs in the file, so a CRLF file reports once. */
  count: number;
}

/**
 * Every governed control codepoint in `contents`, one entry per codepoint
 * rather than per occurrence.
 *
 * Reported that way because the failure a reader needs to act on is "this
 * file contains NULs", and a file with CRLF endings would otherwise print a
 * line per line of the file and bury every other finding in the run.
 */
export function controlViolations(contents: string): Omit<
  ControlViolation,
  "file"
>[] {
  const first = new Map<number, number>();
  const counts = new Map<number, number>();
  let line = 1;
  for (const character of contents) {
    const code = character.codePointAt(0)!;
    if (code === NEWLINE) {
      line += 1;
      continue;
    }
    if (code >= 0x20) continue;
    if (!first.has(code)) first.set(code, line);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...first].map(([code, at]) => ({
    line: at,
    code,
    count: counts.get(code)!,
  })).sort((a, b) => a.line - b.line);
}

/** Lists the repo-relative paths of every tracked file. */
async function trackedFiles(root: string): Promise<string[]> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  return new TextDecoder().decode(stdout).split("\0").filter((p) => p !== "");
}

/** Scans every governed tracked file. */
export async function scan(root: string): Promise<ControlViolation[]> {
  const violations: ControlViolation[] = [];

  for (const file of await trackedFiles(root)) {
    if (!isGovernedPath(file)) continue;
    let contents: string;
    try {
      contents = await Deno.readTextFile(`${root}/${file}`);
    } catch (error) {
      // A tracked path can be absent from the working tree (a sparse
      // checkout, a submodule), and a governed extension can still hold bytes
      // that are not UTF-8. Neither is this check's business; anything else
      // is.
      if (
        error instanceof TypeError || error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.IsADirectory
      ) {
        continue;
      }
      throw error;
    }
    for (const found of controlViolations(contents)) {
      violations.push({ file, ...found });
    }
  }

  return violations;
}

const hex = (code: number): string =>
  `0x${code.toString(16).padStart(2, "0").toUpperCase()}`;

function reportViolations(violations: readonly ControlViolation[]): void {
  const lines = [
    "",
    "Control codepoint(s) below 0x20 in tracked source:",
    "",
    ...violations.map((violation) =>
      `  ${violation.file}:${violation.line}: ${hex(violation.code)}` +
      (violation.count > 1 ? ` (${violation.count} occurrences)` : "")
    ),
    "",
    "Write the value as an escape — `\\x00`, `\\t` — rather than the literal",
    "byte. The string is the same either way, and the file stays plain text:",
    "a single NUL makes `file` report `data`, makes `grep` skip the file",
    "silently, and makes a diff view render the line wrong.",
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const violations = await scan(root);
  if (violations.length > 0) {
    reportViolations(violations);
    return 1;
  }
  console.log("No control codepoints below 0x20 in tracked source.");
  return 0;
}

if (import.meta.main) Deno.exit(await main());
