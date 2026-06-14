#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/block-legacy-cli.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks legacy `ct` shell commands.
 * - Fails hard so only `cf` remains supported.
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

import { guardProjectDir, isGitCommit, parseCommand } from "./common/guard.ts";
guardProjectDir();

const cmd = await parseCommand();
if (!cmd) Deno.exit(0);

// Don't inspect git commit message content for command patterns
if (isGitCommit(cmd)) Deno.exit(0);

// Remove quoted strings and heredoc content before checking for legacy ct commands
// This prevents false positives from file paths or heredocs containing "ct"
let cmdWithoutQuotes = cmd.replace(/(['"`])[^'"`]*?\1/g, "");
// Remove heredoc content: <<'EOF' ... EOF or <<EOF ... EOF
cmdWithoutQuotes = cmdWithoutQuotes.replace(
  /<<'?(\w+)'?[\s\S]*?\n\1/g,
  "",
);

// Match legacy `ct` as a standalone command (not part of another word).
// Matches: ct, ./ct, /path/to/ct, deno task ct.
if (/(?:^|[\s;|&])(?:\.\/)?ct(?:\s|$)/.test(cmdWithoutQuotes)) {
  console.error(
    "Legacy `ct` commands are no longer supported. Use `deno task cf` instead.",
  );
  Deno.exit(2); // Claude interprets exit-code 2 as "block & surface stderr"
}

Deno.exit(0); // Let the tool call proceed
