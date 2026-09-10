#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * .claude/scripts/block-node.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks shell commands that run npm, npx, yarn, pnpm or node.
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

import {
  atCommandPosition,
  guardProjectDir,
  parseCommand,
  stripLiterals,
} from "./common/guard.ts";
guardProjectDir();

const cmd = await parseCommand();
if (!cmd) Deno.exit(0);

// `\b` excludes a path such as node_modules/.bin. An underscore is a word
// character, so there is no word boundary after the `node` in `node_modules`.
const runsNodeTooling = atCommandPosition("(?:npm|npx|yarn|pnpm|node)\\b");

if (runsNodeTooling.test(stripLiterals(cmd))) {
  console.error(
    "This repository uses Deno. It does not use `npm`, `npx`, `yarn`, " +
      "`pnpm` or `node`. Run a script with `deno run`, and a repository " +
      "command with `deno task`. Running `deno task` with no argument " +
      "lists the tasks. To add a dependency, run `deno add npm:<package>` " +
      "in the directory of the workspace member that imports it, which " +
      "writes it to that member's `deno.jsonc`. " +
      "`docs/development/DEPENDENCIES.md` describes the rest.",
  );
  Deno.exit(2);
}

Deno.exit(0);
