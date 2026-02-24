#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/ask-before-delete-spaces.ts
 *
 * Claude Code Pre-Tool hook.
 * - Forces user confirmation when `--dangerously-clear-all-spaces` is detected
 * - Allows all other commands through
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

if (/--dangerously-clear-all-spaces/.test(cmd)) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        "WARNING: This will permanently delete all spaces/databases in packages/toolshed/cache/memory. Are you sure?",
    },
  };
  console.log(JSON.stringify(output));
}

Deno.exit(0);
