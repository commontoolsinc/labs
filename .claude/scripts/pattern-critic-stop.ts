#!/usr/bin/env -S deno run --allow-read
/**
 * Hook: Stop for pattern-critic agent.
 * Reminds to check all 10 categories before completing.
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
    "Before completing: ensure all 10 violation categories have been checked and results output in the specified format with [PASS]/[FAIL]/[N/A] for each.",
}));

Deno.exit(0);
