#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code Pre-Tool hook for git commit commands.
 * - Runs `deno fmt` on staged files, then re-stages them.
 * - Runs `deno lint`.
 * - Runs `deno check` on staged .ts/.tsx files only.
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

// Get staged files (excluding deleted files)
const gitDiff = await new Deno.Command("git", {
  args: ["diff", "--cached", "--name-only", "--diff-filter=d"],
  stdout: "piped",
  stderr: "piped",
}).output();

const allStagedFiles = new TextDecoder()
  .decode(gitDiff.stdout)
  .trim()
  .split("\n")
  .filter((f) => f.length > 0);

if (allStagedFiles.length === 0) {
  Deno.exit(0);
}

const errors: string[] = [];

// 1. Auto-fix formatting
console.error("Running pre-commit checks (fmt, lint, check)...");

const fmtResult = await new Deno.Command("deno", {
  args: ["fmt"],
  stdout: "piped",
  stderr: "piped",
}).output();

if (!fmtResult.success) {
  errors.push("Formatting failed (syntax error?):");
  errors.push(new TextDecoder().decode(fmtResult.stderr));
} else {
  // Re-stage files that fmt may have modified
  await new Deno.Command("git", {
    args: ["add", ...allStagedFiles],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

// 2. Lint
const lintResult = await new Deno.Command("deno", {
  args: ["lint"],
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

// 3. Type-check staged .ts/.tsx files only
const tsFiles = allStagedFiles.filter((f) => /\.(ts|tsx)$/.test(f));

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
