/**
 * Working-directory resolution for Claude Code hook scripts.
 *
 * A hook must decide *which checkout* it is talking about before it runs a
 * single check, and none of the obvious answers is right on its own. Measured
 * against a live session (2026-07-29):
 *
 * - `$CLAUDE_PROJECT_DIR` is pinned to the checkout the session started in. It
 *   never follows the agent into another worktree, so it is wrong precisely
 *   when it matters.
 * - The hook payload's `cwd` (and `Deno.cwd()`, which equals it) tracks the
 *   Bash tool's *persisted* shell cwd — a `cd` in an earlier tool call does
 *   move it. It is the right default, but it is captured BEFORE the command
 *   runs, so a `cd` or `git -C` inside the very command being inspected is
 *   invisible to it.
 * - On `SubagentStop`, the payload's `cwd` is the *parent* session's. A
 *   subagent given its own worktree reports the parent's directory here; the
 *   only record of where it actually worked is its own transcript.
 *
 * So: parse the command for an explicit target, fall back to the payload cwd,
 * and resolve the result through git rather than by string surgery. When none
 * of that yields an answer, say so and let the caller pass — a hook that
 * cannot tell which tree it is judging must not block a correct commit.
 */

/**
 * Read defensively: this module is imported by hooks invoked with differing
 * permission sets, and a hook that dies on a missing `--allow-env` is itself a
 * blocker. Without HOME we simply do not expand `~`.
 */
export function env(name: string): string {
  try {
    return Deno.env.get(name) ?? "";
  } catch {
    return "";
  }
}

const HOME = env("HOME");

/** Run git in `cwd`; trimmed stdout, or null when git itself failed. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!success) return null;
    const out = new TextDecoder().decode(stdout).trim();
    return out || null;
  } catch {
    // cwd does not exist, or git is not installed.
    return null;
  }
}

/** The root of the worktree containing `dir`, or null if there is none. */
export async function worktreeRoot(dir: string): Promise<string | null> {
  return await git(dir, ["rev-parse", "--show-toplevel"]);
}

/**
 * Identity of the *repository* `dir` belongs to. Every worktree of one
 * repository shares a common git dir, so this is what distinguishes "another
 * branch of our repo" (check it) from "an unrelated project" (leave it alone).
 */
export async function repositoryId(dir: string): Promise<string | null> {
  const common = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  // git answers relatively (".git") inside the main worktree and absolutely
  // inside a linked one. Normalise through the filesystem so the two forms of
  // the same repository compare equal.
  if (common.startsWith("/")) return await realPath(common);
  const root = await worktreeRoot(dir);
  return root ? await realPath(`${root}/${common}`) : null;
}

async function realPath(p: string): Promise<string | null> {
  try {
    return await Deno.realPath(p);
  } catch {
    return null;
  }
}

/** True when `a` and `b` are worktrees of the same repository. */
export async function sameRepository(a: string, b: string): Promise<boolean> {
  const [ida, idb] = await Promise.all([repositoryId(a), repositoryId(b)]);
  return ida !== null && ida === idb;
}

/**
 * A `git … commit` invocation, capturing whatever global options sit between
 * `git` and `commit`.
 *
 * Those options are the reason this is not simply /git\s+commit/: written that
 * way, `git -C <dir> commit` does not match, and the hook that used it waved
 * through every commit aimed at another worktree — the one case it most needed
 * to inspect. Matching the options is also what lets us find a `-C` at all.
 */
const GIT_COMMIT = /\bgit\s+((?:-{1,2}[^\s]+(?:[=\s]+[^\s]+)?\s+)*)commit\b/;

/** True when `cmd` contains a `git commit`, however git is steered to it. */
export function isGitCommit(cmd: string): boolean {
  return GIT_COMMIT.test(cmd);
}

/**
 * `cmd` split around the `git … commit` invocation.
 *
 * Callers want the two halves for different reasons, and both matter: earlier
 * commands (a `git add`, a `cd`) are only meaningful in `before`, while the
 * commit's own flags are in `after`. Splitting here also keeps pattern
 * searches out of the commit message, which can contain any text at all —
 * including something that reads exactly like a `git add`.
 */
export function splitAtGitCommit(
  cmd: string,
): { before: string; after: string } {
  const m = cmd.match(GIT_COMMIT);
  if (!m || m.index === undefined) return { before: cmd, after: "" };
  return {
    before: cmd.slice(0, m.index),
    after: cmd.slice(m.index + m[0].length),
  };
}

/**
 * git's own `-C` arguments for the directory a shell command will operate in.
 *
 * Returned as arguments rather than a path so that git — not us — does the
 * resolving: git composes repeated `-C` exactly the way a shell would compose
 * `cd`, including relative segments, and we never have to reimplement that.
 *
 * `null` means "this command steers git in a way this parser does not model";
 * callers should report that and pass rather than guess.
 */
export function targetDirArgs(cmd: string): string[] | null {
  // An explicit tree override changes the answer completely and has forms we
  // deliberately do not try to model. Refuse rather than answer wrongly.
  if (/--git-dir[=\s]|--work-tree[=\s]/.test(cmd)) return null;

  // Isolate the `git … commit` invocation. The options between `git` and
  // `commit` are the only place a `-C` can affect the commit, and anchoring
  // here keeps us out of the commit *message*, which may contain anything.
  const invocation = cmd.match(GIT_COMMIT);
  const optionsBeforeCommit = invocation?.[1] ?? "";
  const prefix = invocation ? cmd.slice(0, invocation.index) : cmd;

  const args: string[] = [];

  // The last `cd` before the commit wins, as it would in the shell. Require a
  // command boundary so `--author "cd fred"` cannot masquerade as one — but
  // count `(` and `{` as boundaries too, because `(cd dir && git commit)` is a
  // real form and missing its `cd` puts us back to judging the wrong tree.
  const cds = [
    ...prefix.matchAll(
      /(?:^|[;&|({])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|)}]+)/g,
    ),
  ];
  const lastCd = cds.at(-1)?.[1];
  if (lastCd) args.push("-C", expand(lastCd));

  // Then each `-C` the commit itself carries, in order.
  for (
    const m of optionsBeforeCommit.matchAll(
      /-C\s+("[^"]*"|'[^']*'|[^\s]+)/g,
    )
  ) {
    args.push("-C", expand(m[1]));
  }

  return args;
}

/** Strip one layer of quoting and expand a leading `~`. */
function expand(raw: string): string {
  let p = raw;
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  if (p === "~") return HOME || p;
  if (p.startsWith("~/") && HOME) return HOME + p.slice(1);
  return p;
}

/**
 * The worktree a `git commit` command will actually commit to.
 *
 * `fallbackCwd` should be the hook payload's `cwd`: correct whenever the
 * command does not redirect git itself.
 */
export async function commitTargetWorktree(
  cmd: string,
  fallbackCwd: string,
): Promise<string | null> {
  const dirArgs = targetDirArgs(cmd);
  if (dirArgs === null) return null;
  return await git(fallbackCwd, [...dirArgs, "rev-parse", "--show-toplevel"]);
}
