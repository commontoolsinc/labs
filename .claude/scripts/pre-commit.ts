#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code Pre-Tool hook.
 * - Intercepts `git commit` commands.
 * - Runs `deno fmt` and `deno lint`.
 * - Exits 2 to block the commit if checks fail.
 * - Tests are skipped (CI will run them).
 */

import { guardProjectDir } from "./common/guard.ts";
guardProjectDir();

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  // If the JSON is malformed we allow the call rather than choke the hook.
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

// Skip if this is an amend with no changes (e.g., just editing message)
if (/--amend\s+--no-edit/.test(cmd) || /--amend\s+-C/.test(cmd)) {
  Deno.exit(0);
}

console.error("Running pre-commit checks (fmt, lint)...");

// Auto-fix formatting first (fast)
const fmtResult = await new Deno.Command("deno", {
  args: ["fmt"],
  stdout: "piped",
  stderr: "piped",
}).output();

// Run lint
const lintResult = await new Deno.Command("deno", {
  args: ["lint"],
  stdout: "piped",
  stderr: "piped",
}).output();

const errors: string[] = [];

if (!fmtResult.success) {
  errors.push("Formatting failed (syntax error?):");
  errors.push(new TextDecoder().decode(fmtResult.stderr));
}

if (!lintResult.success) {
  const lintStderr = new TextDecoder().decode(lintResult.stderr);
  // "No target files found" is not a real lint error — just means no .ts/.tsx files exist
  if (!lintStderr.includes("No target files found")) {
    errors.push("Lint errors found:");
    errors.push(new TextDecoder().decode(lintResult.stdout));
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
