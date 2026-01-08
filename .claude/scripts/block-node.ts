#!/usr/bin/env -S deno run --allow-read
/**
 * .claude/scripts/block-node.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks shell commands that invoke npm, npx, yarn, pnpm, or node.
 * - Prints a Deno-friendly reminder to stderr.
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
} catch {
  // If the JSON is malformed we allow the call rather than choke the hook.
}

// Remove quoted strings before checking for node commands
const cmdWithoutQuotes = cmd.replace(/(['"`])[^'"`]*?\1/g, "");

if (/\b(npm|npx|yarn|pnpm|node)\b/.test(cmdWithoutQuotes)) {
  console.error(
    "We use **Deno** in this repo – please rewrite the command accordingly.",
  );
  Deno.exit(2); // Claude interprets exit-code 2 as "block & surface stderr"
}

Deno.exit(0); // Let the tool call proceed
