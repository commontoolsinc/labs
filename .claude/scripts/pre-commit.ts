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
  env,
  isGitCommit,
  sameRepository,
  splitAtGitCommit,
  splitAtGitSubcommand,
  targetDirArgs,
  withoutQuotedSpans,
} from "./common/worktree.ts";
import { checkFiles } from "./common/checks.ts";

const rawInput = await new Response(Deno.stdin.readable).text();

let cmd = "";
let payloadCwd = "";
try {
  const payload = JSON.parse(rawInput);
  // Typed, not just defaulted: a non-string `command` reached `.match()` and
  // took the hook down with it. Whatever we cannot read, we do not judge.
  const raw = payload?.tool_input?.command;
  cmd = typeof raw === "string" ? raw : "";
  payloadCwd = typeof payload?.cwd === "string" ? payload.cwd : "";
} catch {
  Deno.exit(0);
}

// The commit's own flags, with quoted spans blanked so the message cannot be
// read as one. `git commit -m "docs: --no-verify escape"` used to disable this
// hook completely and silently, just by describing it.
const commitFlags = withoutQuotedSpans(splitAtGitCommit(cmd).after);

if (!isGitCommit(cmd) || /(?:^|\s)--no-verify(?:\s|$)/.test(commitFlags)) {
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
const projectDir = env("CLAUDE_PROJECT_DIR");
if (projectDir && !(await sameRepository(worktree, projectDir))) {
  Deno.exit(0);
}

// --- Determine which files will be committed ---

async function gitFrom(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stdout).trim().split("\n").filter(Boolean);
}

/** git, run at the worktree root, where its output is worktree-relative. */
function git(...args: string[]): Promise<string[]> {
  return gitFrom(worktree, args);
}

// The same redirects the command applies to git. Needed to resolve any paths
// written on a `git add`, which are relative to the shell's directory.
const dirArgs = targetDirArgs(cmd) ?? [];

// The `git add` in this command, if any, and its arguments up to the next
// command separator, message text removed. Parsed with the same globals-aware
// matcher as the commit, because `git -C <dir> add -A && git -C <dir> commit`
// is how staging for another worktree is normally written — and a plain
// /git\s+add/ does not see it, which left that whole flow unchecked.
const addArgs = withoutQuotedSpans(
  splitAtGitSubcommand(splitAtGitCommit(cmd).before, "add").after,
).split(/\s*(?:&&|\|\||;|\n)/)[0].trim();

async function getFilesToCommit(): Promise<string[]> {
  // Already staged by an earlier tool call.
  const files = await git("diff", "--cached", "--name-only", "--diff-filter=d");

  // `-a` / `--all` on the commit, in either the separate or the combined short
  // form (`-am`). Read off the flags with quoted spans already blanked: while
  // this scanned the raw text, a message merely *mentioning* `-a` swept the
  // whole dirty tree and blocked on files the commit would never have staged.
  //
  // `-a` stages tracked modifications only. Adding `ls-files --others` here put
  // every untracked file in the tree on the list — in the main worktree, 6000
  // of them including whole nested checkouts — and blocked the commit on files
  // it would never have touched.
  if (
    /(?:^|\s)(?:--all(?:\s|$)|-[a-zA-Z]*a[a-zA-Z]*(?:\s|$))/.test(commitFlags)
  ) {
    files.push(...await git("diff", "--name-only", "--diff-filter=d", "HEAD"));
  }

  // Whatever a `git add` in this command will stage. Asked of git with
  // `--dry-run` rather than worked out here: git alone knows how the pathspec,
  // the ignore rules and the shell's directory combine. Parsing it ourselves
  // read `git add .` in a subdirectory as the whole tree, lost absolute paths,
  // and lost any path followed by a `;`. `--dry-run` writes nothing — verified
  // against a scratch repo, the index is untouched — and prints one
  // `add '<repo-relative path>'` per file.
  if (addArgs) {
    const args = addArgs.split(/\s+/).filter(Boolean);
    for (
      const line of await gitFrom(fallbackCwd, [
        ...dirArgs,
        "add",
        "--dry-run",
        ...args,
      ])
    ) {
      const m = line.match(/^add '(.*)'$/);
      if (m) files.push(m[1]);
    }
  }

  return [...new Set(files)];
}

// Above this, the file list stops being a description of one commit and starts
// being a description of the tree. Checking it would be slow, would report
// failures the commit is not responsible for, and past ARG_MAX would crash the
// hook outright — so say so and let the commit through, which is what this hook
// does with every other question it cannot answer.
const MAX_FILES = 400;

const files = await getFilesToCommit();
if (files.length === 0) Deno.exit(0);

if (files.length > MAX_FILES) {
  console.error(
    `pre-commit: ${files.length} files in this commit, over the ${MAX_FILES} ` +
      "this hook will check at once. Skipping — commit not blocked.",
  );
  Deno.exit(0);
}

// --- Run checks ---

console.error(`Running pre-commit checks in ${worktree} ...`);

const { checked, missing, inapplicable, unavailable, errors } =
  await checkFiles(
    worktree,
    files,
  );

if (unavailable.length > 0) console.error(unavailable.join("\n\n"));

if (errors.length > 0) {
  console.error(errors.join("\n\n"));
  Deno.exit(2);
}

// Say what actually ran. "All checks passed" over an empty file list, or over
// paths deno.jsonc excludes from fmt and lint, is a pass nobody earned — and
// this hook exists because a verdict that does not match reality is worse than
// no verdict at all.
if (checked.length === 0) {
  console.error(
    `pre-commit: none of the ${files.length} file(s) are on disk; nothing checked.`,
  );
  Deno.exit(0);
}
const ran = ["fmt", "lint", "check"].filter((c) => !inapplicable.includes(c));
let summary = `Pre-commit checks passed on ${checked.length} file(s)`;
summary += ran.length > 0 ? ` (${ran.join(", ")}).` : ".";
if (inapplicable.length > 0) {
  summary += ` Not run — deno.jsonc excludes these paths: ${
    inapplicable.join(", ")
  }.`;
}
if (missing.length > 0) {
  summary += ` Skipped ${missing.length} missing path(s).`;
}
console.error(summary);
Deno.exit(0);
