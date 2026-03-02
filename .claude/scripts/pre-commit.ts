#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code PreToolUse hook that intercepts `git commit` commands.
 *
 * IMPORTANT: This hook only acts on files that are about to be committed,
 * NOT the entire repo. Other files in the working tree may be in a
 * half-finished state and must not cause the commit to fail or be modified.
 *
 * The hook parses the Bash command (e.g. `git add file1 file2 && git commit`)
 * to figure out exactly which files will be staged. It then runs:
 *
 *   1. `deno fmt`   — auto-fix formatting (only on those files)
 *   2. `deno lint`  — lint check (only on those files)
 *   3. `deno check` — type check (only on the .ts/.tsx subset)
 *
 * If any check fails, the hook exits 2 to block the commit.
 *
 * Note: this runs as a PreToolUse hook, meaning it fires BEFORE the Bash
 * command executes. `git add` has not yet run, so `git diff --cached` would
 * be empty — that's why we parse file paths from the command string instead.
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

// Only intercept git commit commands
if (!/\bgit\s+commit\b/.test(cmd)) {
  Deno.exit(0);
}

// Skip if using --no-verify
if (/--no-verify/.test(cmd)) {
  Deno.exit(0);
}

/**
 * Parse the command to figure out which files will actually be committed.
 * Handles: `git add file1 file2 && git commit`, `git add . && git commit`,
 * `git add -A && git commit`, `git commit -a`, and already-staged files.
 */
async function getFilesToCommit(cmd: string): Promise<string[]> {
  // Check for broad adds: `git add .`, `git add -A`, `git commit -a`
  const isAddAll = /\bgit\s+add\s+(-A|\.)\s*(&|$)/.test(cmd) ||
    /\bgit\s+commit\s+.*-a/.test(cmd);

  if (isAddAll) {
    // All changed + untracked files
    return await getAllChangedFiles();
  }

  // Parse explicit file paths from `git add file1 file2 ...`
  const addMatch = cmd.match(/\bgit\s+add\s+(.+?)(?:\s*&&|$)/);
  if (addMatch) {
    const args = addMatch[1].trim().split(/\s+/);
    // Filter out flags (e.g. -f, --force)
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length > 0) {
      return files;
    }
  }

  // No `git add` found — files must already be staged
  const staged = await new Deno.Command("git", {
    args: ["diff", "--cached", "--name-only", "--diff-filter=d"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  return new TextDecoder()
    .decode(staged.stdout)
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

async function getAllChangedFiles(): Promise<string[]> {
  const tracked = await new Deno.Command("git", {
    args: ["diff", "--name-only", "--diff-filter=d", "HEAD"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const untracked = await new Deno.Command("git", {
    args: ["ls-files", "--others", "--exclude-standard"],
    stdout: "piped",
    stderr: "piped",
  }).output();

  return [
    ...new TextDecoder().decode(tracked.stdout).trim().split("\n"),
    ...new TextDecoder().decode(untracked.stdout).trim().split("\n"),
  ].filter((f) => f.length > 0);
}

// Figure out which files will be committed by parsing the command.
// At PreToolUse time `git add` hasn't run yet, so `git diff --cached` is empty.
// We parse file paths from `git add <files>` in the command, or fall back to
// all changed files for `git add .`, `git add -A`, or `git commit -a`.
const filesToCheck = await getFilesToCommit(cmd);

if (filesToCheck.length === 0) {
  Deno.exit(0);
}

const errors: string[] = [];

// 1. Auto-fix formatting (only changed files, not the whole repo)
console.error("Running pre-commit checks (fmt, lint, check)...");

const fmtResult = await new Deno.Command("deno", {
  args: ["fmt", ...filesToCheck],
  stdout: "piped",
  stderr: "piped",
}).output();

if (!fmtResult.success) {
  const fmtStderr = new TextDecoder().decode(fmtResult.stderr);
  // "No target files found" means all changed files are in deno.json exclude
  if (!fmtStderr.includes("No target files found")) {
    errors.push("Formatting failed (syntax error?):");
    errors.push(fmtStderr);
  }
}

// 2. Lint (only changed files)
const lintResult = await new Deno.Command("deno", {
  args: ["lint", ...filesToCheck],
  stdout: "piped",
  stderr: "piped",
}).output();

if (!lintResult.success) {
  const lintStderr = new TextDecoder().decode(lintResult.stderr);
  if (!lintStderr.includes("No target files found")) {
    errors.push("Lint errors found:");
    errors.push(new TextDecoder().decode(lintResult.stdout));
  }
}

// 3. Type-check changed .ts/.tsx files only
const tsFiles = filesToCheck.filter((f) => /\.(ts|tsx)$/.test(f));

if (tsFiles.length > 0) {
  const checkResult = await new Deno.Command("deno", {
    args: ["check", ...tsFiles],
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!checkResult.success) {
    errors.push("Type check failed:");
    errors.push(new TextDecoder().decode(checkResult.stderr));
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
