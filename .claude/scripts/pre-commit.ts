#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code Pre-Tool hook for git commit commands.
 * - Runs `deno fmt` on changed files only (auto-fixes before commit).
 * - Runs `deno lint` on changed files only.
 * - Runs `deno check` on changed .ts/.tsx files only.
 * - Exits 2 to block the commit if any check fails.
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

// Get changed files vs HEAD (staged + unstaged + untracked that are about to
// be committed). At PreToolUse time the `git add` hasn't run yet, so
// --cached would be empty. We combine --name-only HEAD (tracked changes) with
// ls-files --others --exclude-standard (new untracked files).
const trackedDiff = await new Deno.Command("git", {
  args: ["diff", "--name-only", "--diff-filter=d", "HEAD"],
  stdout: "piped",
  stderr: "piped",
}).output();

const untrackedResult = await new Deno.Command("git", {
  args: ["ls-files", "--others", "--exclude-standard"],
  stdout: "piped",
  stderr: "piped",
}).output();

const trackedFiles = new TextDecoder().decode(trackedDiff.stdout).trim();
const untrackedFiles = new TextDecoder().decode(untrackedResult.stdout).trim();

const allChangedFiles = [
  ...trackedFiles.split("\n"),
  ...untrackedFiles.split("\n"),
].filter((f) => f.length > 0);

if (allChangedFiles.length === 0) {
  Deno.exit(0);
}

const errors: string[] = [];

// 1. Auto-fix formatting (only changed files, not the whole repo)
console.error("Running pre-commit checks (fmt, lint, check)...");

const fmtResult = await new Deno.Command("deno", {
  args: ["fmt", ...allChangedFiles],
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
  args: ["lint", ...allChangedFiles],
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
const tsFiles = allChangedFiles.filter((f) => /\.(ts|tsx)$/.test(f));

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
