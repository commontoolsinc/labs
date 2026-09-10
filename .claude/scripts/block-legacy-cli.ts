#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * .claude/scripts/block-legacy-cli.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks the legacy `ct` command, which `cf` replaced.
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

// `ct` is two letters, and appears in commands that do not run it. Matching
// only at command position leaves `grep ct` and `a.ct` alone.
const runsLegacyCli = atCommandPosition("(?:\\./)?ct(?![\\w./-])");

if (runsLegacyCli.test(stripLiterals(cmd))) {
  console.error(
    "`ct` no longer exists. `cf` replaced it. Run `deno task cf`, which " +
      "works from any directory inside the repository. " +
      "`skills/cf/SKILL.md` describes the commands it accepts.",
  );
  Deno.exit(2);
}

Deno.exit(0);
