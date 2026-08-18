#!/usr/bin/env -S deno run --allow-read --allow-run=git
/**
 * Fails when a `FileSystemProgramResolver` is constructed outside the one
 * operation that builds a program from local files.
 *
 * A program assembled by hand -- `resolve(new FileSystemProgramResolver(...))`
 * -- is complete in every way a compiler or a type checker can see. What it
 * silently lacks is any data file the caller meant to attach, and that absence
 * surfaces nowhere until a pattern calls `dataFile()` and is told the file is
 * not there. Three separate rounds of exactly that produced this check: the
 * warm load path, the multi-user test worker, and every pattern integration
 * harness. Each time the code was correct on its own terms and wrong only in
 * what it had no reason to remember.
 *
 * `resolveLocalProgram` composes resolution and attachment into one call, so a
 * new call site cannot take one without the other. This check is what keeps
 * that the only route: reaching for the resolver directly is the mistake, and
 * it is caught here rather than in a pattern that reads a file months later.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-local-program.ts
 */

import { dirname, fromFileUrl } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * Files permitted to construct the resolver directly, each for a reason that
 * does not end in a compiled program.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "packages/runner/src/harness/local-program.deno.ts",
    "the operation itself",
  ],
  [
    "tasks/check-local-program.ts",
    "names the constructor in its own diagnostics",
  ],
  [
    "packages/js-compiler/program.ts",
    "declares the resolver",
  ],
  [
    "packages/js-compiler/test/program.test.ts",
    "tests the resolver's own containment rules",
  ],
  [
    "packages/cli/commands/deps.ts",
    "walks imports to rewrite pins; compiles nothing, so has no data files",
  ],
  [
    "packages/cli/lib/dev.ts",
    "scans for fabric specifiers before resolving, to report them better",
  ],
  [
    "packages/runner/test/engine-test-support.ts",
    "builds programs for engine unit tests, which supply files in memory",
  ],
  [
    "packages/runner/test/manual-compile-wedge.ts",
    "a hand-run debugging script, not part of any suite",
  ],
]);

const tracked = new TextDecoder().decode(
  (await new Deno.Command("git", {
    // The whole repository, not just `packages`: the pattern-compatibility
    // and vintage tasks compile authored source too, and a scope that stopped
    // at `packages` would leave exactly the sites a check like this exists to
    // reach.
    args: ["ls-files", "-z"],
    cwd: REPO_ROOT,
  }).output()).stdout,
).split("\0").filter((path) => /\.tsx?$/.test(path));

const offenders: string[] = [];
for (const path of tracked) {
  if (ALLOWLIST.has(path)) continue;
  // A file git still tracks may already be gone from the working tree, which
  // is what a deletion looks like before it is staged. Nothing to scan.
  let source: string;
  try {
    source = await Deno.readTextFile(`${REPO_ROOT}/${path}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) continue;
    throw error;
  }
  if (!source.includes("new FileSystemProgramResolver")) continue;
  offenders.push(path);
}

if (offenders.length > 0) {
  console.error(
    "These files build a program from local files by hand, so any data file\n" +
      "the caller attaches is silently dropped:\n",
  );
  for (const path of offenders) console.error(`  ${path}`);
  console.error(
    "\nUse `resolveLocalProgram` from " +
      "`@commonfabric/runner/local-program.deno`,\nwhich resolves the entry, " +
      "its attached test entries, and its data files as one\noperation. If a " +
      "site genuinely never compiles the program it builds, add it to\n" +
      "ALLOWLIST in tasks/check-local-program.ts with the reason.",
  );
  Deno.exit(1);
}

console.log(
  `Local programs are built through one operation ` +
    `(${ALLOWLIST.size} allowlisted exception(s)).`,
);
