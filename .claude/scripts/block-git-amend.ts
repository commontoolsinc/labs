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

/**
 * Split a command into shell-like words, honoring single quotes, double
 * quotes, and backslash escapes. Quoting joins characters into the current
 * word (so a message passed as -m "mentions --amend" stays one word), while
 * a quoted-but-real argument like "--amend" still surfaces as its own word.
 * Unterminated quotes swallow the rest of the string into the current word,
 * which errs toward blocking.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      inWord = true;
      const end = command.indexOf("'", i + 1);
      current += end === -1
        ? command.slice(i + 1)
        : command.slice(i + 1, end);
      i = end === -1 ? command.length : end + 1;
    } else if (ch === '"') {
      inWord = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          current += command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      i++; // skip closing quote
    } else if (ch === "\\" && i + 1 < command.length) {
      inWord = true;
      current += command[i + 1];
      i += 2;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      i++;
    } else {
      inWord = true;
      current += ch;
      i++;
    }
  }
  if (inWord) words.push(current);
  return words;
}

// Block git commit --amend (including abbreviated forms: --am, --ame, --amen,
// --amend). Matching whole words means a quoted flag ("--amend") is still
// caught, while a commit message that merely mentions the flag is not — the
// message is a single word containing more than the flag itself.
const words = shellWords(cmd);
const invokesGitCommit = words.some((word, i) =>
  word === "git" && words[i + 1] === "commit"
);
const hasAmendFlag = words.some((word) => /^--am(e(nd?)?)?$/.test(word));

if (invokesGitCommit && hasAmendFlag) {
  console.error(
    "git commit --amend is not allowed. Create a new commit instead.",
  );
  Deno.exit(2);
}

// Allow all other commands
Deno.exit(0);
