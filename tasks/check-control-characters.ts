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
 * tree also carries text that is not authored code, where a control byte
 * may be the data itself rather than a mistake: a `.txt` hashing fixture
 * whose CRLF endings are its whole point, a `.tldr` drawing, and the prose
 * under `docs/history/`, which is a frozen record that may not be edited to
 * satisfy a rule about today's source.
 */
const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".jsonc",
  ".sh",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".py",
  ".toml",
  ".cfg",
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

/**
 * `git ls-files -sz` output as `[blob id, path]` pairs.
 *
 * Each record is `<mode> <object> <stage>\t<path>`, NUL-separated. Split out
 * from the command so the parse is provable without a repository, including
 * the shapes it must decline rather than guess at.
 */
export function parseIndexRecords(output: string): [string, string][] {
  const blobs: [string, string][] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const id = record.slice(0, tab).split(" ")[1];
    blobs.push([id, record.slice(tab + 1)]);
  }
  return blobs;
}

/**
 * The blob id and path of every tracked file, read from the INDEX.
 *
 * Ids rather than paths because the content this judges is the content git
 * stores, not the bytes a checkout materialized. Those differ: with
 * `core.autocrlf=true` git writes a stored LF blob into the working tree as
 * CRLF, so scanning the working tree would report a carriage return in source
 * nobody wrote one in — a verdict that depends on the reader's git config
 * rather than on the repository.
 */
async function trackedBlobs(root: string): Promise<[string, string][]> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "-sz"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  return parseIndexRecords(new TextDecoder().decode(stdout));
}

/**
 * `git cat-file --batch` output as one byte range per blob.
 *
 * Each record is `<id> blob <size>\n`, then exactly `<size>` bytes, then a
 * newline. The size comes from the header rather than from scanning for a
 * delimiter, because the content may hold any byte — including the newline
 * that ends its own record. A header that does not carry a size stops the
 * parse rather than being guessed at: continuing would slice the following
 * blobs at the wrong offsets and report violations against the wrong files.
 */
export function parseBatchBlobs(
  output: Uint8Array,
  count: number,
): Uint8Array[] {
  const contents: Uint8Array[] = [];
  let at = 0;
  while (at < output.length && contents.length < count) {
    let lineEnd = at;
    while (lineEnd < output.length && output[lineEnd] !== 0x0a) lineEnd++;
    const header = new TextDecoder().decode(output.subarray(at, lineEnd));
    const size = Number(header.split(" ")[2]);
    if (!Number.isInteger(size)) break;
    const start = lineEnd + 1;
    contents.push(output.subarray(start, start + size));
    at = start + size + 1;
  }
  return contents;
}

/**
 * The stored bytes of each blob, in the order asked for.
 *
 * One `cat-file --batch` for the whole tree rather than a process per file:
 * the repository tracks thousands of governed files, and the difference is
 * between a gate that runs in a second and one nobody wants in CI.
 */
async function blobContents(
  root: string,
  ids: readonly string[],
): Promise<Uint8Array[]> {
  if (ids.length === 0) return [];
  const command = new Deno.Command("git", {
    args: ["cat-file", "--batch"],
    cwd: root,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  // Start draining stdout BEFORE writing the ids. git writes as it reads, and
  // the whole tree's contents far exceed a pipe buffer, so a writer that held
  // the output unread until it finished would deadlock against a git that
  // cannot accept more input until someone consumes what it has already
  // produced.
  const output = command.output();
  const writer = command.stdin.getWriter();
  await writer.write(new TextEncoder().encode(ids.join("\n") + "\n"));
  await writer.close();

  const { success, stdout } = await output;
  if (!success) throw new Error("git cat-file failed");

  return parseBatchBlobs(stdout, ids.length);
}

/** Scans every governed tracked file, as git stores it. */
export async function scan(root: string): Promise<ControlViolation[]> {
  const governed = (await trackedBlobs(root))
    .filter(([, path]) => isGovernedPath(path));
  const contents = await blobContents(root, governed.map(([id]) => id));

  const violations: ControlViolation[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < governed.length && i < contents.length; i++) {
    const file = governed[i][1];
    let text: string;
    try {
      text = decoder.decode(contents[i]);
    } catch {
      // A governed extension can still hold bytes that are not UTF-8. A file
      // this cannot read is one it cannot judge, not a violation.
      continue;
    }
    for (const found of controlViolations(text)) {
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
