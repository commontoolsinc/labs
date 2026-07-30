#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
/**
 * .claude/scripts/subagent-stop.ts
 *
 * Claude Code SubagentStop hook.
 * - Runs fmt --check / lint / check over the files THIS subagent changed, in
 *   the worktree it was actually working in.
 * - Blocks the subagent from stopping if those files fail.
 * - Otherwise reports branch state as context.
 *
 * Two things it deliberately does not do, because doing them made its verdict
 * useless as a gate:
 *
 * Repo-wide checks. A wave of sibling agents editing one tree means a repo-wide
 * check reports their in-flight edits to whichever agent happens to finish
 * first, and pre-existing failures on the branch to all of them. Every agent
 * then spends real tokens investigating a failure it did not cause. Scoped to
 * the files an agent touched, the verdict is about that agent's work.
 *
 * Trusting the payload's `cwd`. On this event it is the *parent* session's
 * directory; a subagent handed its own worktree is not described by it at all.
 * The subagent's own transcript records where it worked, so that is what we
 * read. See common/worktree.ts.
 *
 * The cost of scoping this way, stated plainly: attribution comes from the
 * Edit/Write tool calls in the transcript, so a file changed through Bash
 * instead — `sed -i`, a codegen task — is not checked here. That is the
 * accepted trade. An unattributable check is what made this hook's verdict
 * worth ignoring, and a gate everyone ignores catches nothing at all. CI and
 * the pre-commit hook still see those files.
 */

import { env, sameRepository, worktreeRoot } from "./common/worktree.ts";
import { checkFiles } from "./common/checks.ts";

const rawInput = await new Response(Deno.stdin.readable).text();

let payload: Record<string, unknown> = {};
try {
  payload = JSON.parse(rawInput) ?? {};
} catch {
  // A payload we cannot read tells us nothing to check. Do not block on it.
  Deno.exit(0);
}

// Prevent infinite loops - if we're already in a stop hook, allow through
if (payload.stop_hook_active === true) {
  Deno.exit(0);
}

/**
 * What the subagent did, read from its own transcript: the directory it ran in
 * and the files it wrote. The transcript is append-only and this hook fires
 * after the agent's last turn, so both are complete by now.
 */
function readAgentActivity(
  transcriptPath: string,
): { cwd: string | null; files: string[] } {
  let text: string;
  try {
    text = Deno.readTextFileSync(transcriptPath);
  } catch {
    return { cwd: null, files: [] };
  }

  const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
  let cwd: string | null = null;
  const files = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;

    const content = (entry.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type !== "tool_use" || !WRITE_TOOLS.has(block?.name)
      ) continue;
      const p = block?.input?.file_path ?? block?.input?.notebook_path;
      if (typeof p === "string" && p) files.add(p);
    }
  }

  return { cwd, files: [...files] };
}

const transcriptPath = typeof payload.agent_transcript_path === "string"
  ? payload.agent_transcript_path
  : "";
const activity = transcriptPath
  ? readAgentActivity(transcriptPath)
  : { cwd: null, files: [] };

// The transcript is the authority. Falling back to the payload's `cwd` is
// falling back to the very signal this file's header calls wrong for this event
// — right for a subagent sharing the parent's tree, wrong for one given its
// own. It is used only when the transcript records no cwd at all, and the
// containment check below is what keeps a wrong guess from doing damage.
const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : "";
const agentDir = activity.cwd ?? payloadCwd;

if (!transcriptPath || !agentDir) {
  console.log(JSON.stringify({
    systemMessage:
      "Subagent checks skipped: could not determine which worktree this " +
      "subagent was working in. Not blocking.",
  }));
  Deno.exit(0);
}

const resolvedWorktree = await worktreeRoot(agentDir);
if (!resolvedWorktree) {
  console.log(JSON.stringify({
    systemMessage:
      `Subagent checks skipped: ${agentDir} is not inside a git worktree. ` +
      "Not blocking.",
  }));
  Deno.exit(0);
}

// Bound after the guard so the closures below see a plain string.
const worktree: string = resolvedWorktree;

// Another repository checked out nearby is not ours to judge.
const projectDir = env("CLAUDE_PROJECT_DIR");
if (projectDir && !(await sameRepository(worktree, projectDir))) {
  Deno.exit(0);
}

function canonical(path: string): string | null {
  try {
    return Deno.realPathSync(path);
  } catch {
    return null;
  }
}

// Repo-relative, and only files genuinely inside the worktree we resolved: a
// path somewhere else is not something this tree's config can be asked about.
//
// Canonicalised first, on both sides. A plain string prefix accepts
// `<worktree>/../sibling/x.ts` — it starts with the prefix, and slicing it
// leaves `../sibling/x.ts`, which points deno straight back into another
// agent's tree. That is the cross-worktree pollution this hook is here to end,
// arriving through the check meant to prevent it. Symlinked paths need the same
// treatment to be recognised as inside at all.
const canonicalWorktree = canonical(worktree) ?? worktree;
const prefix = canonicalWorktree.endsWith("/")
  ? canonicalWorktree
  : `${canonicalWorktree}/`;
const resolved = activity.files.map(canonical).filter((f): f is string =>
  f !== null
);
const changed = resolved
  .filter((f) => f.startsWith(prefix))
  .map((f) => f.slice(prefix.length))
  .sort();

if (changed.length === 0) {
  // A subagent that wrote nothing has nothing to answer for. Checking the repo
  // anyway is what produced the false verdicts this hook used to hand out.
  //
  // But say so when it wrote something we then discarded: this is the branch a
  // containment or worktree-resolution mistake hides in, so it must be the one
  // branch that is never silent.
  if (activity.files.length > 0) {
    console.log(JSON.stringify({
      systemMessage:
        `Subagent checks skipped: none of its ${activity.files.length} ` +
        `written file(s) resolved inside ${canonicalWorktree}. Not blocking.`,
    }));
  }
  Deno.exit(0);
}

const { checked, missing, inapplicable, unavailable, errors } =
  await checkFiles(
    worktree,
    changed,
  );

if (unavailable.length > 0) console.error(unavailable.join("\n\n"));

if (errors.length > 0) {
  console.error(
    `Checks failed on files changed by this subagent (in ${worktree}):\n\n` +
      errors.join("\n\n"),
  );
  Deno.exit(2); // Block stop, tell the subagent to fix
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await new Deno.Command("git", {
    args,
    cwd: worktree,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stdout).trim();
}

const [branchName, status] = await Promise.all([
  git("branch", "--show-current"),
  git("status", "--porcelain"),
]);

// Report what ran, not what was attempted. Claiming fmt and lint passed on
// paths deno.jsonc excludes from both — `.claude/**` among them — is how a gate
// launders an unchecked change into an approved one.
const LABELS: Array<[flag: string, name: string]> = [
  ["fmt", "fmt"],
  ["lint", "lint"],
  ["check", "type check"],
];
const ran = LABELS.filter(([flag]) => !inapplicable.includes(flag)).map((
  [, name],
) => name);

let context = `Checks passed on ${checked.length} file(s) changed by this ` +
  `subagent` + (ran.length > 0 ? ` (${ran.join(", ")}).` : ".");
if (inapplicable.length > 0) {
  context += `\nNot run — deno.jsonc excludes these paths: ${
    inapplicable.join(", ")
  }.`;
}
if (missing.length > 0) {
  context += `\nSkipped ${missing.length} path(s) no longer on disk.`;
}
context += `\nWorktree: ${worktree}`;
context += `\nBranch: ${branchName}`;

if (status.length > 0) {
  context +=
    `\nThere are uncommitted changes. Consider committing if this unit of work is complete.`;
}

console.log(JSON.stringify({ systemMessage: context }));

Deno.exit(0);
