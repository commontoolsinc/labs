#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * .claude/scripts/ask-before-delete-spaces.ts
 *
 * Claude Code Pre-Tool hook.
 * - Asks the user before a command carrying
 *   `--dangerously-clear-all-spaces` runs.
 */

import { guardProjectDir, parseCommand } from "./common/guard.ts";
guardProjectDir();

const cmd = await parseCommand();

if (/--dangerously-clear-all-spaces/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        "This permanently deletes every local space database, which is " +
        "the `cache/memory` directory under `packages/toolshed`. Nothing " +
        "restores them afterwards. To clear the disposable caches and " +
        "leave the databases alone, use `--clear-cache` instead.",
    },
  }));
}

Deno.exit(0);
