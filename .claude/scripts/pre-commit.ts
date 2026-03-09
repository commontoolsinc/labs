#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code PreToolUse hook that intercepts `git commit` commands.
 * Runs deno fmt, lint, and check on ONLY the files being committed.
 * Exits 2 to block the commit if any check fails.
 *
 * This fires BEFORE the Bash command executes, so any `git add` in
 * the command hasn't run yet. We combine already-staged files (from
 * `git diff --cached`) with files parsed from the command string.
 */

import { guardProjectDir } from "./common/guard.ts";
guardProjectDir();

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  Deno.exit(0);
}

if (!/\bgit\s+commit\b/.test(cmd) || /--no-verify/.test(cmd)) {
  Deno.exit(0);
}

// Resolve the repo root so all paths are consistent, even when CWD is a
// subdirectory (e.g. packages/runner/).  Without this, git returns paths
// relative to the repo root while deno resolves them relative to CWD,
// doubling the prefix (packages/runner/packages/runner/...).
const repoRoot = new TextDecoder()
  .decode(
    (await new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      stdout: "piped",
      stderr: "piped",
    }).output()).stdout,
  )
  .trim();
if (!repoRoot) Deno.exit(0);

// --- Determine which files will be committed ---

async function git(...args: string[]): Promise<string[]> {
  const { stdout } = await new Deno.Command("git", {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean);
}

async function getFilesToCommit(): Promise<string[]> {
  const addsAll = /\bgit\s+add\s+(-A|\.)\s*(&|$)/.test(cmd) ||
    /\bgit\s+commit\s+.*-a/.test(cmd);

  if (addsAll) {
    const tracked = await git("diff", "--name-only", "--diff-filter=d", "HEAD");
    const untracked = await git("ls-files", "--others", "--exclude-standard");
    return [...new Set([...tracked, ...untracked])];
  }

  // Start with files already staged from prior `git add` calls
  const files = await git("diff", "--cached", "--name-only", "--diff-filter=d");

  // Add any files from a `git add <paths>` in this command (not yet staged).
  // Only search before `git commit` to avoid false-matching inside commit messages.
  const preCommit = cmd.split(/\bgit\s+commit\b/)[0] ?? "";
  const addMatch = preCommit.match(/\bgit\s+add\s+(.+?)(?:\s*&&|$)/);
  if (addMatch) {
    for (const arg of addMatch[1].trim().split(/\s+/)) {
      if (!arg.startsWith("-")) files.push(arg);
    }
  }

  return [...new Set(files)];
}

const files = await getFilesToCommit();
if (files.length === 0) Deno.exit(0);

// --- Run checks ---

async function run(
  label: string,
  args: string[],
): Promise<string | null> {
  const result = await new Deno.Command("deno", {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) return null;
  const stderr = new TextDecoder().decode(result.stderr);
  if (stderr.includes("No target files found")) return null;
  const stdout = new TextDecoder().decode(result.stdout);
  return `${label}:\n${stdout || stderr}`;
}

console.error("Running pre-commit checks (fmt, lint, check)...");

// Snapshot partially-staged files BEFORE fmt (which modifies the working tree).
// Files with unstaged changes must not be re-added or we'd commit unintended hunks.
const stagedFiles = await git(
  "diff",
  "--cached",
  "--name-only",
  "--diff-filter=d",
);
const partiallyStaged = new Set(await git("diff", "--name-only"));
const safeToRestage = stagedFiles.filter((f) => !partiallyStaged.has(f));

// 1. Format first — must complete before lint/check see the files
const fmtErr = await run("Formatting failed", ["fmt", ...files]);
if (safeToRestage.length > 0) {
  await new Deno.Command("git", {
    args: ["add", ...safeToRestage],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

// 2. Lint and type-check can run in parallel (both read-only)
const tsFiles = files.filter((f) => /\.(ts|tsx)$/.test(f));

const errors = [
  fmtErr,
  ...(await Promise.all([
    run("Lint errors", ["lint", ...files]),
    tsFiles.length > 0
      ? run("Type check failed", ["check", ...tsFiles])
      : null,
  ])),
].filter(Boolean);

if (errors.length > 0) {
  console.error(errors.join("\n\n"));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
