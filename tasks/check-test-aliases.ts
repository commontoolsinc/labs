#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Guards tasks/test-identity-aliases, the append-only directory that
 * bridges test-identity renames for readers of the test-run record store
 * (docs/history/plans/test-run-telemetry.md). The directory holds one
 * JSON-lines file per test file, which keeps two changes that rename tests
 * in different test files from appending to the same file. Each line maps
 * an old identity — or a whole scope, for package renames — to its
 * replacement, with the date of the rename; readers resolve aliases
 * transitively and apply one only to records older than its date. The
 * parsing and resolution live in @commonfabric/test-support/records; this
 * gate holds the directory itself to history's rules.
 *
 * The directory is history, so existing lines are never edited or removed
 * (the committed content of each file must be a prefix of that file's new
 * content, and no committed file may go missing), every line must parse,
 * no identity may be mapped twice across the whole directory, and the
 * mapping graph must have no cycle — a cycle would send resolution around
 * forever and means someone renamed something back, which is a new rename
 * with its own line, not an edit to an old one. Readers take only the
 * `.jsonl` files directly inside the directory, so anything else there,
 * and a `.jsonl` file of the directory's name beside it, holds aliases
 * that nothing reads, and fails.
 *
 * Usage: check-test-aliases.ts [base-ref]   (default: origin/main)
 */

import {
  ALIAS_DIRECTORY,
  ALIAS_FILE_SUFFIX,
  aliasGraphProblems,
  type AliasLine,
  parseAliasLine,
  readAliasFiles,
} from "@commonfabric/test-support/records";

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

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Names of the entries of an alias directory that `readAliasFiles()` passes
 * over. A missing directory has none.
 */
async function unreadEntries(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.endsWith(ALIAS_FILE_SUFFIX)) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
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

  // `ls-tree` prints nothing for a path absent at that ref, so a directory
  // created after the merge base reads as empty history, and any git
  // failure stops the gate rather than approving a rewrite.
  let committedPaths: string[];
  try {
    committedPaths = (await git(
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      mergeBase,
      "--",
      `${ALIAS_DIRECTORY}/`,
    )).split("\0").filter((path) => path.length > 0);
  } catch (error) {
    console.error(
      `Cannot list ${ALIAS_DIRECTORY} at the merge base: ${error}`,
    );
    Deno.exit(2);
  }

  const problems: string[] = [];

  for (const name of await unreadEntries(ALIAS_DIRECTORY)) {
    problems.push(
      `${ALIAS_DIRECTORY}/${name} is not a \`${ALIAS_FILE_SUFFIX}\` file ` +
        "directly inside the directory, so no reader loads it",
    );
  }
  const stray = `${ALIAS_DIRECTORY}${ALIAS_FILE_SUFFIX}`;
  if (await exists(stray)) {
    problems.push(
      `${stray} is outside ${ALIAS_DIRECTORY}/, so no reader loads it; its ` +
        "lines belong in the files there",
    );
  }

  const files = await readAliasFiles(ALIAS_DIRECTORY);
  const currentText = new Map(
    files.map(({ name, text }) => [`${ALIAS_DIRECTORY}/${name}`, text]),
  );
  for (const path of committedPaths) {
    const committed = await git("show", `${mergeBase}:${path}`);
    const current = currentText.get(path);
    if (current === undefined || !current.startsWith(committed)) {
      problems.push(
        `${path} rewrites history: the content at ${
          mergeBase.slice(0, 12)
        } is no longer a prefix of the working copy. An alias file is ` +
          "append-only — a wrong line is superseded by a newer line, never " +
          "edited.",
      );
    }
  }

  const aliases: AliasLine[] = [];
  for (const { name, text } of files) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      const parsed = parseAliasLine(line);
      if (typeof parsed === "string") {
        problems.push(`${name} line ${i + 1} ${parsed}`);
        continue;
      }
      aliases.push(parsed);
    }
  }
  problems.push(...aliasGraphProblems(aliases));

  if (problems.length > 0) {
    console.error(`${ALIAS_DIRECTORY} has ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    Deno.exit(1);
  }
  console.log(
    `${ALIAS_DIRECTORY}: ${aliases.length} alias(es) in ${files.length} ` +
      "file(s), append-only and acyclic.",
  );
}

if (import.meta.main) {
  await main();
}
