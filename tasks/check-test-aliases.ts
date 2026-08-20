#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Guards tasks/test-identity-aliases.jsonl, the append-only file that
 * bridges test-identity renames for readers of the test-run record store
 * (docs/history/plans/test-run-telemetry.md). Each line maps an old
 * identity — or a whole scope, for package renames — to its replacement,
 * with the date of the rename; readers resolve aliases transitively and
 * apply one only to records older than its date. The parsing and
 * resolution live in @commonfabric/test-support/records; this gate holds
 * the file itself to history's rules.
 *
 * The file is history, so existing lines are never edited or removed (the
 * committed content must be a prefix of the new content), every line must
 * parse, no identity may be mapped twice, and the mapping graph must have
 * no cycle — a cycle would send resolution around forever and means
 * someone renamed something back, which is a new rename with its own
 * line, not an edit to an old one.
 *
 * Usage: check-test-aliases.ts [base-ref]   (default: origin/main)
 */

import {
  ALIAS_FILE,
  aliasGraphProblems,
  type AliasLine,
  parseAliasLine,
} from "@commonfabric/test-support/records";

/**
 * Whether a failed `git show <ref>:<path>` means the path was absent at
 * that ref. Only that failure reads as empty history; any other git
 * failure fails the gate, since treating it as an absent file would
 * approve a rewrite on an error.
 */
export function gitShowFailureMeansAbsent(message: string): boolean {
  return message.includes("does not exist") ||
    message.includes("exists on disk, but not in");
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
  } catch (error) {
    if (!gitShowFailureMeansAbsent(String(error))) {
      console.error(`Cannot read ${ALIAS_FILE} at the merge base: ${error}`);
      Deno.exit(2);
    }
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
