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
  argumentRegion,
  commitsAllTracked,
  commitSkipsVerify,
  commitTargetWorktree,
  env,
  gitAddInvocations,
  isGitCommit,
  MAX_COMMAND_LENGTH,
  sameRepository,
  splitAtGitCommit,
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

// This commit's own flags: cut at the next command separator, with quoted spans
// blanked so a message cannot be read as one.
//
// Both halves of that are load-bearing. Reading the raw text let
// `git commit -m "docs: --no-verify escape"` disable the hook by describing it.
// Reading to end-of-command let a *later* command do it for real:
// `git commit -m one && git commit -m two --no-verify` turned verification off
// for the first commit too, silently, and the same leak made a later `-am` sweep
// the whole tree on behalf of an earlier plain commit.
const commitAfter = splitAtGitCommit(cmd).after;
const commitFlags = withoutQuotedSpans(argumentRegion(commitAfter));

if (!isGitCommit(cmd) || commitSkipsVerify(commitFlags)) {
  Deno.exit(0);
}

if (cmd.length > MAX_COMMAND_LENGTH) {
  console.error(
    `pre-commit: command is ${cmd.length} characters, over the ` +
      `${MAX_COMMAND_LENGTH} this hook will parse. Skipping — not blocked.`,
  );
  Deno.exit(0);
}

// Only the first commit in a command is modelled, so anything staged for a
// second one is invisible. Reporting a clean pass over the first commit's files
// would be a false verdict on a change that does get committed — worse than a
// skip, by the standard this hook is held to.
if (splitAtGitCommit(commitAfter).matched) {
  console.error(
    "pre-commit: more than one `git commit` in this command; only the first " +
      "is modelled. Skipping — commit not blocked.",
  );
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
    // `--no-optional-locks` because several read-shaped commands are not reads:
    // `git status --porcelain` refreshes and rewrites the index, verified in a
    // scratch repo. That breaks the read-only contract, and it takes
    // `.git/index.lock` in a tree a sibling agent may be committing in.
    // `core.quotePath=false` because otherwise a non-ASCII path comes back
    // octal-escaped and double-quoted, and we would stat that literal string.
    args: ["--no-optional-locks", "-c", "core.quotePath=false", ...args],
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

// Every `git add` in this command: where each runs and what it stages. Resolved
// at each add's own position, with its own directory redirects — an add and the
// commit need not run in the same place, and reusing the commit's looked for the
// file somewhere it never was.
const adds = gitAddInvocations(cmd) ?? [];

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
  if (commitsAllTracked(commitFlags)) {
    files.push(...await git("diff", "--name-only", "--diff-filter=d", "HEAD"));
  }

  // Whatever a `git add` in this command will stage. Asked of git with
  // `--dry-run` rather than worked out here: git alone knows how the pathspec,
  // the ignore rules and the shell's directory combine. Parsing it ourselves
  // read `git add .` in a subdirectory as the whole tree, lost absolute paths,
  // and lost any path followed by a `;`. `--dry-run` writes nothing — verified
  // against a scratch repo, the index is untouched — and prints one
  // `add '<repo-relative path>'` per file.
  for (const add of adds) {
    if (add.flags.length === 0 && add.paths.length === 0) continue;
    if (!add.dryRunnable) {
      // An unrecognised flag might be `--edit`, which writes to the index even
      // under --dry-run. Say so; do not stage on the user's behalf to satisfy
      // our own curiosity.
      const glob = add.paths.find((p) => /[*?[]/.test(p));
      console.error(
        glob
          ? `pre-commit: \`git add ${glob}\` is an unexpanded glob, which git ` +
            "would match recursively rather than as the shell expanded it. " +
            "Not resolving its file list."
          : "pre-commit: `git add` here carries a flag not known to be safe " +
            `under --dry-run (${
              add.flags.join(" ")
            }). Not resolving its file list.`,
      );
      continue;
    }
    // An add can be steered somewhere else entirely: `git -C /other add -A &&
    // git commit`. Its paths are relative to *that* worktree, so folding them in
    // here would check — and block on — files this commit has never heard of.
    const addWorktree = (await gitFrom(fallbackCwd, [
      ...add.dirArgs,
      "rev-parse",
      "--show-toplevel",
    ]))[0];
    // Same tree only. Not merely "same repository": a `git add` steered
    // elsewhere stages files this commit will not contain, and running anything
    // against an unrelated checkout is outside this hook's remit entirely.
    if (!addWorktree || addWorktree !== worktree) continue;

    for (
      const line of await gitFrom(fallbackCwd, [
        ...add.dirArgs,
        "add",
        "--dry-run",
        ...add.flags,
        // Everything after this is a pathspec, never an option — so a file
        // named `--cached` cannot become a flag we did not intend to pass.
        "--",
        ...add.paths,
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
if (files.length === 0) {
  // Never silently. Every silent bypass this hook has had looked exactly like
  // this line: a parse went wrong upstream, the list came back empty, and the
  // commit sailed through indistinguishably from "nothing to check". One line
  // of output here would have surfaced all of them.
  console.error(
    "pre-commit: no files resolved for this commit; nothing checked.",
  );
  Deno.exit(0);
}

if (files.length > MAX_FILES) {
  console.error(
    `pre-commit: ${files.length} files in this commit, over the ${MAX_FILES} ` +
      "this hook will check at once. Skipping — commit not blocked.",
  );
  Deno.exit(0);
}

// --- Run checks ---

console.error(`Running pre-commit checks in ${worktree} ...`);

const { checked, missing, inapplicable, partial, unavailable, errors } =
  await checkFiles(worktree, files);

if (unavailable.length > 0) {
  console.error(unavailable.map((u) => u.message).join("\n\n"));
}

if (errors.length > 0) {
  console.error(errors.join("\n\n"));
  Deno.exit(2);
}

// Say what actually ran. "All checks passed" over an empty file list, or over
// paths a check silently narrowed away, is a pass nobody earned — and this hook
// exists because a verdict that does not match reality is worse than none.
if (checked.length === 0) {
  console.error(
    `pre-commit: none of the ${files.length} file(s) are on disk; nothing checked.`,
  );
  Deno.exit(0);
}
const notRun = new Set([...inapplicable, ...unavailable.map((u) => u.check)]);
const ran = ["fmt", "lint", "check"].filter((c) => !notRun.has(c));
let summary = `Pre-commit checks passed on ${checked.length} file(s)`;
summary += ran.length > 0 ? ` (${ran.join(", ")}).` : ".";
if (inapplicable.length > 0) {
  summary += ` No files here for: ${inapplicable.join(", ")}.`;
}
if (partial.length > 0) {
  summary += ` Saw only part of the list: ${partial.join(", ")}.`;
}
if (missing.length > 0) {
  summary += ` Skipped ${missing.length} missing path(s).`;
}
console.error(summary);
Deno.exit(0);
