#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * .claude/scripts/stop-check.ts
 *
 * Claude Code Stop hook.
 * - Tells the user how many uncommitted changes the turn is ending on, and on
 *   which branch.
 * - Does not block.
 */

import { guardProjectDir } from "./common/guard.ts";
guardProjectDir();

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
  // `--no-optional-locks` stops `git status` writing to the tree. Without it,
  // `git status` refreshes and rewrites the index whenever a tracked file is
  // racily clean, meaning its content matches the index but its modification
  // time differs. Editing a file and reverting it leaves a file in that state.
  // This hook only reports, so it must not write the index or take
  // `.git/index.lock`.
  args: ["--no-optional-locks", "status", "--porcelain"],
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
  args: ["--no-optional-locks", "branch", "--show-current"],
  stdout: "piped",
  stderr: "piped",
}).output();
const branchName = new TextDecoder().decode(branch.stdout).trim();

// Count changed files
const changedFiles = changes.split("\n").filter((l) => l.trim()).length;

// Provide context via systemMessage (shown to user, doesn't block)
console.log(JSON.stringify({
  systemMessage:
    `Note: ${changedFiles} uncommitted change(s) on branch '${branchName}'.`,
}));

Deno.exit(0);
