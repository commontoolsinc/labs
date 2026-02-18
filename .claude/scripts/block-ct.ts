#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/block-ct.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks shell commands that invoke `ct` binary directly.
 * - Redirects to `deno task ct` instead.
 * - Exits 2 so Claude blocks the tool call and shows the message.
 */

import { guardProjectDir, isGitCommit, parseCommand } from "./common/guard.ts";
guardProjectDir();

const cmd = await parseCommand();
if (!cmd) Deno.exit(0);

// Don't inspect git commit message content for command patterns
if (isGitCommit(cmd)) Deno.exit(0);

// Remove quoted strings and heredoc content before checking for ct commands
// This prevents false positives from file paths or heredocs containing "ct"
let cmdWithoutQuotes = cmd.replace(/(['"`])[^'"`]*?\1/g, "");
// Remove heredoc content: <<'EOF' ... EOF or <<EOF ... EOF
cmdWithoutQuotes = cmdWithoutQuotes.replace(
  /<<'?(\w+)'?[\s\S]*?\n\1/g,
  "",
);

// Match `ct` as a standalone command (not `deno task ct` or part of another word)
// Matches: ct, ./ct, /path/to/ct but not `deno task ct` or `select`
if (/(?:^|[\s;|&])(?:\.\/)?ct(?:\s|$)/.test(cmdWithoutQuotes)) {
  // Allow if it's already using deno task ct
  if (/deno\s+task\s+ct/.test(cmdWithoutQuotes)) {
    Deno.exit(0);
  }
  console.error(
    "Use `deno task ct` instead of `ct` binary directly. Try `deno task ct --help` first.",
  );
  Deno.exit(2); // Claude interprets exit-code 2 as "block & surface stderr"
}

Deno.exit(0); // Let the tool call proceed
