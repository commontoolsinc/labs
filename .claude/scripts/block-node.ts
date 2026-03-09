#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/block-node.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks shell commands that invoke npm, npx, yarn, pnpm, or node as a
 *   command (at the start of a line or after && / ; / |).
 * - Does NOT trigger on incidental mentions like paths containing "node_modules".
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

import { guardProjectDir, isGitCommit, parseCommand } from "./common/guard.ts";
guardProjectDir();

const cmd = await parseCommand();
if (!cmd) Deno.exit(0);

// Don't inspect git commit message content for command patterns
if (isGitCommit(cmd)) Deno.exit(0);

// Match node/npm/npx/yarn/pnpm only when used as a command:
// - at the start of the string
// - after && ; or |
const pattern = /(?:^|[;&|]\s*)(npm|npx|yarn|pnpm|node)\b/;

if (pattern.test(cmd)) {
  console.error(
    "We use **Deno** in this repo – please rewrite the command accordingly.",
  );
  Deno.exit(2);
}

Deno.exit(0);
