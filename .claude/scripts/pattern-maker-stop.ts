#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/pattern-maker-stop.ts
 *
 * Claude Code Stop hook for pattern-maker subagent.
 * - Reminds to verify tests and run critic before completing.
 */

const rawInput = await new Response(Deno.stdin.readable).text();
let input: { stop_hook_active?: boolean } = {};

try {
  input = JSON.parse(rawInput);
} catch {
  Deno.exit(0);
}

// Prevent infinite loops
if (input.stop_hook_active) {
  Deno.exit(0);
}

console.log(JSON.stringify({
  systemMessage:
    "Before completing: ensure tests pass (deno task ct test) and run Skill('pattern-critic') for violation check.",
}));

Deno.exit(0);
