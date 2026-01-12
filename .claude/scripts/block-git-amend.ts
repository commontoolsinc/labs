#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/block-git-amend.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks `git commit --amend` commands
 * - Allows all other commands through
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  // If JSON is malformed, allow the call
  Deno.exit(0);
}

// Block git commit --amend (including abbreviated forms: --am, --ame, --amen, --amend)
if (/\bgit\s+commit\b/.test(cmd) && /--am(e(nd?)?)?\b/.test(cmd)) {
  console.error(
    "git commit --amend is not allowed. Create a new commit instead.",
  );
  Deno.exit(2);
}

// Allow all other commands
Deno.exit(0);
