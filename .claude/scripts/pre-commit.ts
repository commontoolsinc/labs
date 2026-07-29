#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/pre-commit.ts
 *
 * Claude Code PreToolUse hook that intercepts `git commit` commands.
 * Runs deno fmt --check, lint, and check on ONLY the files being committed,
 * in the worktree the commit actually targets.
 * Exits 2 to block the commit if any check fails.
 *
 * This fires BEFORE the Bash command executes, so any `git add` in
 * the command hasn't run yet. We combine already-staged files (from
 * `git diff --cached`) with files parsed from the command string.
 *
 * The target worktree is derived from the command plus the payload's `cwd`,
 * never from `$CLAUDE_PROJECT_DIR` — see common/worktree.ts for why each of
 * those is or is not trustworthy. Getting this wrong is not a near-miss: it
 * reports another branch's errors against this commit, and blocks on them.
 */

import {
  commitTargetWorktree,
  isGitCommit,
  sameRepository,
  splitAtGitCommit,
} from "./common/worktree.ts";
import { checkFiles } from "./common/checks.ts";

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
let payloadCwd = "";
try {
  const payload = JSON.parse(rawInput);
  cmd = payload?.tool_input?.command ?? "";
  payloadCwd = payload?.cwd ?? "";
} catch {
  Deno.exit(0);
}

if (!isGitCommit(cmd) || /--no-verify/.test(cmd)) {
  Deno.exit(0);
}

// --- Resolve the worktree this commit lands in ---

const fallbackCwd = payloadCwd || Deno.cwd();
const targetWorktree = await commitTargetWorktree(cmd, fallbackCwd);

if (!targetWorktree) {
  // Requirement of last resort: a hook that cannot identify the tree it would
  // be judging must not block. Report the miss so a real misconfiguration is
  // visible, and let the commit through.
  console.error(
    "pre-commit: could not determine which worktree this commit targets " +
      `(cwd ${fallbackCwd}). Skipping checks — commit not blocked.`,
  );
  Deno.exit(0);
}

// Bound after the guard so the closures below see a plain string.
const worktree: string = targetWorktree;

// Leave other repositories alone. Worktrees of *this* repository are fair game
// (that is the whole point), but a commit in an unrelated project checked out
// nearby is none of our business.
const projectDir = Deno.env.get("CLAUDE_PROJECT_DIR");
if (projectDir && !(await sameRepository(worktree, projectDir))) {
  Deno.exit(0);
}

// --- Determine which files will be committed ---

async function git(...args: string[]): Promise<string[]> {
  const { stdout } = await new Deno.Command("git", {
    args,
    cwd: worktree,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean);
}

// Only ever search the half of the command each pattern can legitimately
// appear in — a commit message is free to contain the text "git add".
const { before: preCommit, after: commitFlags } = splitAtGitCommit(cmd);

async function getFilesToCommit(): Promise<string[]> {
  // `-a` / `--all` on the commit, in either the separate or the combined short
  // form (`-am`). Reading it off the commit's own flags rather than the whole
  // command is what makes this work for `git -C <dir> commit -am …` too.
  const commitsAll = /(?:^|\s)(?:--all(?:\s|$)|-[a-zA-Z]*a[a-zA-Z]*(?:\s|$))/
    .test(commitFlags);
  const addsAll = /\bgit\s+add\s+(-A|\.)\s*(&|$)/.test(preCommit) || commitsAll;

  if (addsAll) {
    const tracked = await git("diff", "--name-only", "--diff-filter=d", "HEAD");
    const untracked = await git("ls-files", "--others", "--exclude-standard");
    return [...new Set([...tracked, ...untracked])];
  }

  // Start with files already staged from prior `git add` calls
  const files = await git("diff", "--cached", "--name-only", "--diff-filter=d");

  // Add any files from a `git add <paths>` in this command (not yet staged).
  const addMatch = preCommit.match(/\bgit\s+add\s+(.+?)(?:\s*&&|$)/);
  if (addMatch) {
    for (const arg of addMatch[1].trim().split(/\s+/)) {
      if (!arg.startsWith("-")) files.push(arg);
    }
  }

  return [...new Set(files)];
}

const files = await getFilesToCommit();
if (files.length === 0) Deno.exit(0);

// --- Run checks ---

console.error(
  `Running pre-commit checks (fmt, lint, check) in ${worktree} ...`,
);

const errors = await checkFiles(worktree, files);

if (errors.length > 0) {
  console.error(errors.join("\n\n"));
  Deno.exit(2);
}

console.error("All pre-commit checks passed.");
Deno.exit(0);
