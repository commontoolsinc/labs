#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * .claude/scripts/subagent-stop.ts
 *
 * Claude Code SubagentStop hook.
 * - Runs validation suite: deno task check, deno fmt --check, deno lint.
 * - Blocks the subagent from stopping if checks fail.
 * - Suggests considering git commit with current branch info.
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let stopHookActive = false;
try {
  const payload = JSON.parse(rawInput);
  stopHookActive = payload?.stop_hook_active ?? false;
} catch {
  // Continue with checks even if JSON is malformed
}

// Prevent infinite loops - if we're already in a stop hook, allow through
if (stopHookActive) {
  Deno.exit(0);
}

// Run checks in parallel for speed
const [checkResult, fmtResult, lintResult] = await Promise.all([
  new Deno.Command("deno", {
    args: ["task", "check"],
    stdout: "piped",
    stderr: "piped",
  }).output(),
  new Deno.Command("deno", {
    args: ["fmt", "--check"],
    stdout: "piped",
    stderr: "piped",
  }).output(),
  new Deno.Command("deno", {
    args: ["lint"],
    stdout: "piped",
    stderr: "piped",
  }).output(),
]);

const errors: string[] = [];

if (!checkResult.success) {
  errors.push("Type check failed:");
  errors.push(new TextDecoder().decode(checkResult.stderr));
}

if (!fmtResult.success) {
  errors.push("Formatting issues found. Run `deno fmt` to fix:");
  errors.push(new TextDecoder().decode(fmtResult.stdout));
}

if (!lintResult.success) {
  errors.push("Lint errors found:");
  errors.push(new TextDecoder().decode(lintResult.stdout));
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  Deno.exit(2); // Block stop, tell Claude to fix
}

// Get branch info for commit suggestion
const branch = await new Deno.Command("git", {
  args: ["branch", "--show-current"],
  stdout: "piped",
  stderr: "piped",
}).output();
const branchName = new TextDecoder().decode(branch.stdout).trim();

// Get status to check for uncommitted changes
const status = await new Deno.Command("git", {
  args: ["status", "--porcelain"],
  stdout: "piped",
  stderr: "piped",
}).output();
const hasChanges = new TextDecoder().decode(status.stdout).trim().length > 0;

let context = `All checks passed (type check, formatting, lint).`;
context += `\nCurrent branch: ${branchName}`;

if (hasChanges) {
  context +=
    `\nThere are uncommitted changes. Consider committing if this unit of work is complete.`;
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SubagentStop",
    additionalContext: context,
  },
}));

Deno.exit(0);
