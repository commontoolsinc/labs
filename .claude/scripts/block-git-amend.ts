#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * .claude/scripts/block-git-amend.ts
 *
 * Claude Code Pre-Tool hook.
 * - Blocks `git commit --amend` commands
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
  // If JSON is malformed, allow the call
  Deno.exit(0);
}

// Drop quoted segments so only actual shell words are inspected — a commit
// message that merely mentions the flag must not trip the block. Double-quoted
// segments can span newlines (e.g. -m "$(cat <<'EOF' ... EOF)").
//
// Known gap, accepted: a deliberately quoted flag (git commit "--amend") is
// erased along with the message text and slips through. This hook is a
// guardrail against accidental amends, not a security boundary — a deliberate
// bypass has routes no string check can catch (FLAG=--amend, sh -c, a script
// file), so shell-aware parsing would add complexity without closing anything.
const bareWords = cmd
  .replace(/"(?:\\.|[^"\\])*"/gs, '""')
  .replace(/'[^']*'/g, "''");

// Block git commit --amend (including abbreviated forms: --am, --ame, --amen, --amend)
if (
  /\bgit\s+commit\b/.test(bareWords) &&
  /(^|\s)--am(e(nd?)?)?\b/.test(bareWords)
) {
  console.error(
    "git commit --amend is not allowed. Create a new commit instead.",
  );
  Deno.exit(2);
}

// Allow all other commands
Deno.exit(0);
