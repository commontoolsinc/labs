#!/usr/bin/env -S deno run --allow-read --allow-run
/**
 * .claude/scripts/stop-check.ts
 *
 * Claude Code Stop hook.
 * - Checks if there are uncommitted changes.
 * - If so, reminds to consider running tests before finishing.
 * - Does NOT block (just provides context).
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let stopHookActive = false;
try {
  const payload = JSON.parse(rawInput);
  stopHookActive = payload?.stop_hook_active ?? false;
} catch {
  // Continue even if JSON is malformed
}

// Prevent infinite loops
if (stopHookActive) {
  Deno.exit(0);
}

// Check for uncommitted changes
const status = await new Deno.Command("git", {
  args: ["status", "--porcelain"],
  stdout: "piped",
  stderr: "piped",
}).output();

const changes = new TextDecoder().decode(status.stdout).trim();

if (changes.length === 0) {
  // No uncommitted changes, allow stop
  Deno.exit(0);
}

// Get current branch
const branch = await new Deno.Command("git", {
  args: ["branch", "--show-current"],
  stdout: "piped",
  stderr: "piped",
}).output();
const branchName = new TextDecoder().decode(branch.stdout).trim();

// Count changed files
const changedFiles = changes.split("\n").filter((l) => l.trim()).length;

// Provide context but don't block
console.log(JSON.stringify({
  decision: undefined, // Don't block, just provide context
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      `There are ${changedFiles} uncommitted change(s) on branch '${branchName}'. ` +
      `If you made code changes, consider running \`deno task check\` and tests before finishing.`,
  },
}));

Deno.exit(0);
