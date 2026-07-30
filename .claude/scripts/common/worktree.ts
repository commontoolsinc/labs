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
  // Ask git for an absolute answer rather than normalising one ourselves. Left
  // to its own devices git replies relative to the directory it ran in inside a
  // main worktree (`../../.git` from a subdirectory) and absolutely inside a
  // linked one — and resolving that relative form against the wrong base
  // yielded a path outside the repo, so this returned null and both hooks
  // silently skipped every check. The bug was invisible from a linked worktree,
  // which is exactly where it was measured.
  const absolute = await git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (absolute) return await realPath(absolute);

  // Older git without --path-format: resolve against `dir`, git's own base.
  const common = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  if (common.startsWith("/")) return await realPath(common);
  return await realPath(`${dir}/${common}`);
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
 * One global option in a `git <globals> <subcommand>` invocation.
 *
 * A value may be quoted, and may mix quoted and bare spans the way a shell word
 * does (`-c user.name="A B"`), so it is matched as a sequence of those rather
 * than a run of non-space characters. That is not a cosmetic distinction:
 * `git -C "/a b" commit` went unrecognised while the value pattern was
 * `[^\s]+`, and an unrecognised commit is an unchecked one.
 */
/**
 * git's global options that take a value. Every other token before the
 * subcommand is a boolean flag.
 *
 * Listing them is what keeps the invocation pattern from backtracking
 * exponentially. When any option *might* have taken a value, N of them had 2^N
 * readings and a failed match explored them all: 24 flag-like tokens after a
 * word ending in "git" took 1.6 seconds, on a hook that runs on every Bash
 * call. Here each branch consumes a determined number of tokens.
 */
const VALUE_OPTIONS = [
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
];

const SHELL_WORD = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;

const GLOBAL_OPTION = String.raw`(?:(?:${
  VALUE_OPTIONS.join("|")
})(?:=|\s+)${SHELL_WORD}|-{1,2}[\w-]+)\s+`;

/**
 * Matches `git <globals> <subcommand>`, capturing the globals.
 *
 * Those globals are the reason this is not simply /git\s+commit/: written that
 * way, `git -C <dir> commit` does not match, and the hook that used it waved
 * through every commit aimed at another worktree — the one case it most needed
 * to inspect. Matching them is also what lets us find a `-C` at all.
 */
function gitSubcommand(subcommand: string): RegExp {
  return new RegExp(String.raw`\bgit\s+((?:${GLOBAL_OPTION})*)${subcommand}\b`);
}

const GIT_COMMIT = gitSubcommand("commit");

/**
 * `text` with the *contents* of quoted spans replaced by a filler character,
 * preserving length so offsets into the result still address the original.
 *
 * Quoted text is data. Until it was masked, it was parsed as command syntax and
 * got to choose what the hook did:
 *
 *   echo "git -C /other/worktree commit" && git commit -m x
 *
 * matched the quoted mention first, took `-C /other/worktree` from a string
 * literal, and blocked the commit on an unrelated tree's errors. A quoted
 * mention could equally move the split past a real `cd` and hide it, or make
 * `rg 'git commit' docs/` — not a commit at all — run checks and fail.
 *
 * NUL is the filler: it is not whitespace, not a word character, and not any
 * delimiter here, so a masked span cannot match anything we look for.
 */
function maskQuotedSpans(text: string): string {
  return text.replace(
    /"[^"]*"|'[^']*'/g,
    (span) => "\0".repeat(span.length),
  );
}

/** True when `cmd` contains a `git commit`, however git is steered to it. */
export function isGitCommit(cmd: string): boolean {
  return GIT_COMMIT.test(maskQuotedSpans(cmd));
}

/**
 * `cmd` split around a `git … <subcommand>` invocation.
 *
 * Each part answers a different question and only one part can answer it:
 * earlier commands (a `git add`, a `cd`) live in `before`, git's own global
 * options in `options`, the subcommand's arguments in `after`. Splitting once,
 * here, is what keeps every pattern search out of the commit message — free to
 * contain text reading exactly like a `git add`, a `cd`, or a `--work-tree`.
 */
export function splitAtGitSubcommand(
  cmd: string,
  subcommand: string,
): { before: string; options: string; after: string } {
  // Located on the masked copy so quoted text cannot be the match, but sliced
  // out of the original so callers get real values back. The mask preserves
  // length, which is what makes those two the same offsets.
  const masked = maskQuotedSpans(cmd);
  const m = masked.match(gitSubcommand(subcommand));
  if (!m || m.index === undefined) {
    return { before: cmd, options: "", after: "" };
  }
  const optionsStart = m.index + m[0].length - (m[1] ?? "").length -
    subcommand.length;
  return {
    before: cmd.slice(0, m.index),
    options: cmd.slice(optionsStart, optionsStart + (m[1] ?? "").length),
    after: cmd.slice(m.index + m[0].length),
  };
}

/** `cmd` split around its `git … commit`. */
export function splitAtGitCommit(
  cmd: string,
): { before: string; options: string; after: string } {
  return splitAtGitSubcommand(cmd, "commit");
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
  // The options between `git` and `commit` are the only place a `-C` can affect
  // the commit; `before` is the only place a `cd` can.
  const { before: prefix, options } = splitAtGitCommit(cmd);

  // An explicit tree override changes the answer completely and has forms we
  // deliberately do not try to model. Refuse rather than answer wrongly — but
  // only when it is really one of git's options. Searching the whole command
  // meant `git commit -m 'handle --work-tree correctly'` refused to resolve,
  // and refusing to resolve turns every check off: a commit message could
  // silently disable the hook by describing it.
  if (/--git-dir|--work-tree/.test(options)) return null;

  // Two shapes a regex cannot read, where guessing produced a *confidently
  // wrong* tree rather than no answer:
  //
  // Parentheses. A `cd` inside `( … )` or `$( … )` does not outlive the
  // subshell, so `(cd /a && git add -A) && git commit` must not resolve to
  // /a — but `(cd /a && git commit)` must. Telling those apart means knowing
  // whether the commit shares the subshell, which is parsing, not matching.
  //
  // Heredocs. Their body is data, and a line of data reading `cd /elsewhere`
  // is not a command. Only `before` matters: `git commit -F - <<'EOF'` keeps
  // its heredoc after the commit, where we never look.
  //
  // So refuse. Skipping a check is a cost; asserting the wrong branch's errors
  // against someone's commit is the bug this module exists to remove.
  const maskedPrefix = maskQuotedSpans(prefix);
  if (/[()]/.test(maskedPrefix)) return null;
  if (maskedPrefix.includes("<<")) return null;
  // `popd` returns to a directory we never saw pushed. Nothing to compose.
  if (/(?:^|[;&|{\n])\s*popd\b/.test(maskedPrefix)) return null;

  const args: string[] = [];

  // Every `cd` before the commit, in order — not just the last. They compose:
  // `cd /a && cd sub` ends in /a/sub, and taking only `cd sub` resolved it
  // against whatever directory the hook happened to start in. Passing them all
  // to git reproduces the composition exactly, absolute paths overriding
  // earlier ones just as they do in a shell.
  //
  // A command boundary is required so `--author "cd fred"` cannot masquerade as
  // one. A newline is such a boundary: agents write commit sequences as
  // multi-line scripts, and while `\n` was missing every `cd` after the first
  // line was invisible — the original bug, surviving in its most common form.
  // `{` counts too; unlike `(` a brace group runs in the current shell, so its
  // `cd` holds. `pushd` moves the shell the same way `cd` does.
  //
  // Matched against the mask and read out of the original by index, so a quoted
  // path arrives intact while quoted prose cannot pose as a command.
  for (
    const m of maskedPrefix.matchAll(
      /(?:^|[;&|{\n])\s*(?:cd|pushd)\s+([^\s;&|}]+)/dg,
    )
  ) {
    const span = m.indices?.[1];
    if (!span) continue;
    args.push("-C", expand(prefix.slice(span[0], span[1])));
  }

  // Then each `-C` the commit itself carries, in order. git rejects a glued
  // `-C<path>` ("unknown option"), so a space is required here too.
  for (
    const m of options.matchAll(
      /-C\s+("[^"]*"|'[^']*'|[^\s]+)/g,
    )
  ) {
    args.push("-C", expand(m[1]));
  }

  return args;
}

/**
 * Strip one layer of quoting and expand `~` and `$VAR`.
 *
 * The shell expands these before git ever sees them; we are reading the command
 * before it runs, so we have to. `cd "$CLAUDE_PROJECT_DIR" && git commit` is a
 * shape agents actually write, and without expansion it resolved to nothing.
 * Single-quoted values are left alone, as the shell leaves them.
 */
function expand(raw: string): string {
  let p = raw;
  const singleQuoted = p.startsWith("'") && p.endsWith("'") && p.length >= 2;
  if (
    singleQuoted || (p.startsWith('"') && p.endsWith('"') && p.length >= 2)
  ) {
    p = p.slice(1, -1);
  }
  if (!singleQuoted) {
    p = p.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => {
      const value = env(braced ?? bare);
      // An unset variable expands to nothing in the shell. Keeping the literal
      // would send git looking for a directory named `$FOO`.
      return value || (value === "" ? "" : whole);
    });
  }
  if (p === "~") return HOME || p;
  if (p.startsWith("~/") && HOME) return HOME + p.slice(1);
  return p;
}

/**
 * `text` with quoted spans blanked out.
 *
 * For scanning a region that contains both flags and free text: a commit
 * message is quoted, so removing quoted spans leaves the flags and drops the
 * prose. Without this, `git commit -m "fix: honour the -a flag"` read as a
 * `-a` commit and swept the entire dirty tree — blocking on files the commit
 * would never have touched, which is the failure this whole change is about.
 * Flags after the message (`git commit -m "x" -a`) still register.
 */
export function withoutQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'/g, " ");
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
