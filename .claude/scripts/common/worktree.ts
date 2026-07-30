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

/**
 * A value may be quoted, and may mix quoted and bare spans the way a shell word
 * does (`-c user.name="A B"`), so it is matched as a sequence of those rather
 * than a run of non-space characters. Not cosmetic: `git -C "/a b" commit` went
 * unrecognised while this was `[^\s]+`, and an unrecognised commit is an
 * unchecked one.
 */
const SHELL_WORD = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;

/**
 * A boolean global option.
 *
 * `\w` after the dashes, not `[\w-]`, is the whole point: with `-{1,2}[\w-]+`,
 * `--foo` matched two ways — `--` + `foo` and `-` + `-foo` — over the same span,
 * so N consecutive dash-flags had 2^N parses and a failing match walked all of
 * them. 24 of them cost 2.4 seconds of hook time; 26 cost 9.6. Requiring a word
 * character immediately after the dashes leaves exactly one reading.
 *
 * The first version of this fix listed the value-taking options (below) to stop
 * every option consuming one-or-two tokens. That was necessary and insufficient:
 * the flag branch was still ambiguous with itself, and the regression test built
 * its input as `--exclude dirN`, which breaks the chain after one iteration and
 * so measured nothing.
 */
const BOOLEAN_OPTION = String.raw`-{1,2}\w[\w-]*`;

/**
 * Repetition is bounded rather than open. A real `git` invocation carries a
 * handful of global options; a bound turns any residual ambiguity from
 * unbounded-exponential into a fixed ceiling, which is the property worth having
 * on a hook that runs on every Bash call in the session.
 */
const GLOBAL_OPTION = String.raw`(?:(?:${
  VALUE_OPTIONS.join("|")
})(?:=|\s+)${SHELL_WORD}|${BOOLEAN_OPTION})\s+`;

const MAX_GLOBAL_OPTIONS = 12;

/**
 * Matches `git <globals> <subcommand>`, capturing the globals.
 *
 * Those globals are the reason this is not simply /git\s+commit/: written that
 * way, `git -C <dir> commit` does not match, and the hook that used it waved
 * through every commit aimed at another worktree — the one case it most needed
 * to inspect. Matching them is also what lets us find a `-C` at all.
 */
function gitSubcommand(subcommand: string): RegExp {
  return new RegExp(
    String
      .raw`\bgit\s+((?:${GLOBAL_OPTION}){0,${MAX_GLOBAL_OPTIONS}})${subcommand}(?![-\w])`,
  );
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
  return maskLineContinuations(maskComments(maskQuotesOnly(text)));
}

/**
 * Blank a `#` comment to end of line. Applied after quoting, so a `#` inside a
 * string is already NUL and cannot start one.
 *
 * `git status # remember to git commit -m x` was read as a commit: the hook then
 * checked whatever happened to be staged and, finding a fault, exited 2 on a
 * `git status`. A hard block on a read-only command, with `--no-verify`
 * meaningless as an escape because there is no commit to pass it to.
 */
function maskComments(text: string): string {
  return text.replace(
    /(^|\s)#[^\n]*/g,
    (span, lead: string) => lead + "\0".repeat(span.length - lead.length),
  );
}

/**
 * Turn `\<newline>` into spaces. It is a line continuation: the shell removes it
 * and joins the lines, so it is neither an argument nor a separator.
 *
 *   git add \
 *     bad.ts && git commit -m x
 *
 * cut the argument region at the newline and handed git a lone `\` as the
 * pathspec, so bad.ts was staged, committed, and never checked. Two spaces, not
 * one, because the mask must not change any offset.
 */
function maskLineContinuations(text: string): string {
  return text.replace(/\\\n/g, "  ");
}

function maskQuotesOnly(text: string): string {
  // `\\[\s\S]` in the double-quoted branch is load-bearing, and the character
  // class rather than `.` doubly so: `.` does not match a newline, so a shell
  // line continuation inside a quoted string ended the span early and reopened
  // this whole family — a `--no-verify` written across two lines disabled the
  // hook again, exactly the bypass a test claimed to have closed.
  //
  // Ending the branch at the first `"` was the first version of the same
  // mistake: an escaped quote closed the span, leaving the rest of the message
  // unmasked, and unmasked text carrying its own separator got read as commands:
  //
  //   echo "a \" && cd /evil && echo \"" && git commit -m x
  //
  // resolved to /evil. A single-quoted span has no escapes in the shell, so
  // that branch is a plain run to the next quote.
  return text.replace(
    /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g,
    (span) => "\0".repeat(span.length),
  );
}

/**
 * A backtracking-free `git … commit` check, by walking tokens.
 *
 * The bounded regex above is fast but gives up past its option limit, and giving
 * up there meant `isGitCommit` returned false and the hook skipped the commit in
 * silence — the one outcome this file is built to avoid. The bound cannot simply
 * be lifted: measured unbounded, the residual ambiguity between a value-taking
 * option and a boolean one still runs past 300 seconds. So the regex keeps its
 * bound for structure, and this decides, in linear time, whether there is a
 * commit here at all.
 */
function looksLikeGitCommit(masked: string): boolean {
  const tokens = masked.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git" && !tokens[i].endsWith("/git")) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith("-")) {
      j += VALUE_OPTIONS.includes(tokens[j]) ? 2 : 1;
    }
    if (tokens[j] === "commit") return true;
  }
  return false;
}

/**
 * Beyond this, refuse to parse. The mask is quadratic on a long contiguous run
 * of escaped quotes — 64 KB of them cost 5.8 seconds, paid several times over as
 * each entry point re-masks — and no real commit command is anywhere near it.
 */
export const MAX_COMMAND_LENGTH = 16384;

/** True when `cmd` contains a `git commit`, however git is steered to it. */
export function isGitCommit(cmd: string): boolean {
  const masked = maskQuotedSpans(cmd);
  return GIT_COMMIT.test(masked) || looksLikeGitCommit(masked);
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
): { matched: boolean; before: string; options: string; after: string } {
  // Located on the masked copy so quoted text cannot be the match, but sliced
  // out of the original so callers get real values back. The mask preserves
  // length, which is what makes those two the same offsets.
  const masked = maskQuotedSpans(cmd);
  const m = masked.match(gitSubcommand(subcommand));
  if (!m || m.index === undefined) {
    return { matched: false, before: cmd, options: "", after: "" };
  }
  const optionsStart = m.index + m[0].length - (m[1] ?? "").length -
    subcommand.length;
  return {
    matched: true,
    before: cmd.slice(0, m.index),
    options: cmd.slice(optionsStart, optionsStart + (m[1] ?? "").length),
    after: cmd.slice(m.index + m[0].length),
  };
}

/** `cmd` split around its `git … commit`. */
export function splitAtGitCommit(
  cmd: string,
): { matched: boolean; before: string; options: string; after: string } {
  return splitAtGitSubcommand(cmd, "commit");
}

/**
 * The argument region of a command: everything up to the first separator that
 * is not inside quotes.
 *
 * Found on the mask so `git add 'a&b.ts'` is one argument rather than two
 * commands.
 */
export function argumentRegion(text: string): string {
  // Redirections end the argument list too, and the whole operator has to go,
  // file descriptor included. Cutting at the bare `>` left the `2` of
  // `2>/dev/null` behind as a pathspec, git failed on it, the file list came
  // back empty, and the commit went through unchecked — the same silent pass as
  // not handling redirection at all.
  const sep = maskQuotedSpans(text).search(/[;\n&|]|\d*[<>]/);
  return sep === -1 ? text : text.slice(0, sep);
}

/**
 * Shell words in `text`, with one layer of quoting removed.
 *
 * Split on the mask, so a quoted argument containing spaces stays one word, and
 * read back out of the original, so the word itself survives. Blanking quotes
 * before splitting is what erased them: `git add "packages/foo.ts"` produced no
 * arguments at all, the file was never checked, and the commit sailed through.
 */
export function shellWords(text: string): string[] {
  const masked = maskQuotedSpans(text);
  return [...masked.matchAll(/\S+/g)].map((m) =>
    expand(text.slice(m.index, m.index + m[0].length))
  );
}

/**
 * The `-C` arguments in effect after `prefix` has run — every `cd` and `pushd`
 * it contains, in order.
 *
 * `null` for the shapes a regex cannot read; see targetDirArgs.
 *
 * Taken at a point in the command, not once for the whole thing, because
 * different git invocations in one command run in different directories:
 * `git add foo.ts && cd sub && git commit` stages from here and commits from
 * there, and resolving the add with the commit's directory looked for the file
 * in the wrong place and quietly dropped it.
 */
export function dirArgsAt(prefix: string): string[] | null {
  const masked = maskQuotedSpans(prefix);

  // Two shapes a regex cannot read, where guessing produced a *confidently
  // wrong* tree rather than no answer:
  //
  // Parentheses. A `cd` inside `( … )` or `$( … )` does not outlive the
  // subshell, so `(cd /a && git add -A) && git commit` must not resolve to
  // /a — but `(cd /a && git commit)` must. Telling those apart means knowing
  // whether the commit shares the subshell, which is parsing, not matching.
  //
  // Heredocs. Their body is data, and a line of data reading `cd /elsewhere`
  // is not a command.
  //
  // So refuse. Skipping a check is a cost; asserting the wrong branch's errors
  // against someone's commit is the bug this module exists to remove.
  if (/[()]/.test(masked)) return null;
  if (masked.includes("<<")) return null;
  // `popd` returns to a directory we never saw pushed. Nothing to compose.
  if (/(?:^|[;&|{\n])\s*popd\b/.test(masked)) return null;

  const args: string[] = [];

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
    const m of masked.matchAll(
      /(?:^|[;&|{\n])\s*(?:cd|pushd)\s+([^\s;&|}]+)/dg,
    )
  ) {
    const span = m.indices?.[1];
    if (!span) continue;
    args.push("-C", expand(prefix.slice(span[0], span[1])));
  }

  return args;
}

/**
 * `git add` flags known not to write anything under `--dry-run`.
 *
 * A whitelist, deliberately, and this is the second attempt. `--edit` writes to
 * the index *even with* `--dry-run` — git rejects `-i`/`-p` outright but honours
 * `--edit`, applying the patch regardless, and Claude Code sets
 * `GIT_EDITOR=true` so the editor step silently accepts everything. A hook whose
 * entire purpose is to stop touching the trees it inspects staged the user's
 * working tree for them, before their command had run.
 *
 * The first attempt blacklisted `--edit`, `--interactive`, `--patch` as exact
 * words. git accepts any unambiguous abbreviation, so `--e`, `--ed` and `--edi`
 * all still mutated — verified against a scratch repo, `git write-tree` before
 * and after. No blacklist can be complete against prefix matching, so the
 * polarity is wrong for a mutation guard: an unrecognised flag has to mean "do
 * not run this", not "assume it is fine".
 *
 * Rejecting an abbreviation of a *safe* flag costs a skipped file list and says
 * so. Accepting an abbreviation of an unsafe one costs the read-only contract.
 */
const SAFE_ADD_LONG = new Set([
  "--all",
  "--no-all",
  "--update",
  "--force",
  "--dry-run",
  "--verbose",
  "--ignore-errors",
  "--ignore-removal",
  "--no-ignore-removal",
  "--renormalize",
  "--sparse",
  "--no-warn-embedded-repo",
]);

/** Short clusters of safe flags only: all, update, force, dry-run, verbose. */
const SAFE_ADD_SHORT = /^-[Aufnv]+$/;

/**
 * `--refresh` is deliberately absent, and its absence is the third correction to
 * this guard. It writes the index under `--dry-run` in the racily-clean case —
 * content matching the index with a stale mtime, which is exactly what a fresh
 * checkout or a `touch` leaves behind. Isolated in a scratch repo: with content
 * changed it is inert, with content unchanged the index file is rewritten. An
 * earlier probe missed it by changing the content first.
 *
 * Every name here was verified individually rather than assumed, because the
 * previous two versions of this guard were each wrong about a flag nobody had
 * run.
 */
function isSafeAddFlag(flag: string): boolean {
  if (SAFE_ADD_SHORT.test(flag)) return true;
  // `--chmod` only in its attached form. Separated (`--chmod +x`), the value is
  // an argument we would classify as a pathspec and move after `--`, leaving
  // git with a `--chmod` that has lost its parameter: it fails, the file list
  // comes back empty, and the commit goes unchecked.
  if (flag.startsWith("--chmod=")) return true;
  return SAFE_ADD_LONG.has(flag);
}

export interface GitAddInvocation {
  dirArgs: string[];
  /** Options to pass through, `--dry-run` excluded. */
  flags: string[];
  /** Pathspecs, to be passed after `--`. */
  paths: string[];
  /** True when every flag is known safe to pass to `git add --dry-run`. */
  dryRunnable: boolean;
}

/**
 * Every `git add` in `cmd` before its commit: where each runs and what it
 * stages.
 *
 * All of them, not just the first. `git add ok.ts && git add bad.ts && git
 * commit` reported only ok.ts, so bad.ts was staged, committed, and never
 * checked — a silent pass.
 *
 * `null` when the command steers git somewhere this parser does not model.
 */
export function gitAddInvocations(cmd: string): GitAddInvocation[] | null {
  const invocations: GitAddInvocation[] = [];
  let region = splitAtGitCommit(cmd).before;
  let consumed = 0;

  while (true) {
    const add = splitAtGitSubcommand(region, "add");
    if (!add.matched) break;

    // The prefix for this add is everything in the original command up to it.
    const dirArgs = dirArgsAt(cmd.slice(0, consumed + add.before.length));
    if (dirArgs === null) return null;
    for (const m of add.options.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s]+)/g)) {
      dirArgs.push("-C", expand(m[1]));
    }

    const words = shellWords(argumentRegion(add.after));

    // Split at the caller's own `--`: after it everything is a pathspec, however
    // it is spelled. Classifying by a leading `-` alone put that `--` in with
    // the flags, where it was re-emitted ahead of ours and git died on the
    // duplicate — `git add -- foo.ts` checked nothing and passed in silence.
    const sentinel = words.indexOf("--");
    const head = sentinel === -1 ? words : words.slice(0, sentinel);
    const tail = sentinel === -1 ? [] : words.slice(sentinel + 1);
    const flags = head.filter((w) => w.startsWith("-"));
    const paths = [...head.filter((w) => !w.startsWith("-")), ...tail];

    invocations.push({
      dirArgs,
      flags,
      paths,
      // An unexpanded glob is not the same pathspec the shell will produce:
      // `git add *.ts` expands to this directory, while git's pathspec matches
      // recursively. Resolving it here blocked commits on files in
      // subdirectories that the command never staged.
      dryRunnable: flags.every(isSafeAddFlag) &&
        !paths.some((p) => /[*?[]/.test(p)),
    });

    const advance = add.before.length +
      (region.length - add.before.length - add.after.length);
    consumed += advance;
    region = region.slice(advance);
  }

  return invocations;
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
  const { matched, before: prefix, options } = splitAtGitCommit(cmd);

  // No structural parse — the commit is past the option bound, or there is none.
  // Either way we have no idea where it lands, and the caller reports that
  // rather than resolving from a prefix we never located.
  if (!matched) return null;

  // An explicit tree override changes the answer completely and has forms we
  // deliberately do not try to model. Refuse rather than answer wrongly — but
  // only when it is really one of git's options. Searching the whole command
  // meant `git commit -m 'handle --work-tree correctly'` refused to resolve,
  // and refusing to resolve turns every check off: a commit message could
  // silently disable the hook by describing it.
  if (/--git-dir|--work-tree/.test(options)) return null;

  // Only `before` is scanned for directory changes: `git commit -F - <<'EOF'`
  // keeps its heredoc after the commit, where a `cd` could not affect it.
  const args = dirArgsAt(prefix);
  if (args === null) return null;

  // Then each `-C` the commit itself carries, in order. git rejects a glued
  // `-C<path>` ("unknown option"), so a space is required here too.
  for (const m of options.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s]+)/g)) {
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
/**
 * True when a commit's flags stage all tracked changes (`-a` / `--all`).
 *
 * Short flags are read cluster by cluster, stopping at the first one that takes
 * an attached value, because everything after it *is* that value. `git commit
 * -mdata` is a valid attached message, and a pattern looking for `a` anywhere in
 * a dash-token read it as `-a`: the hook then pulled in every tracked change in
 * the tree and blocked the commit on an unrelated unstaged error. `-ma msg`
 * likewise means a message of "a", not `-a`.
 *
 * `commitFlags` must already have had its quoted spans removed.
 */
/**
 * True when the commit's flags disable verification.
 *
 * `-n` is git-commit's short spelling of `--no-verify`, and only the long form
 * was honoured — so the escape hatch the tests call "the only way past" did not
 * work when spelled the way git documents it first.
 */
export function commitSkipsVerify(commitFlags: string): boolean {
  if (/(?:^|\s)--no-verify(?:\s|$)/.test(commitFlags)) return true;
  const VALUE_TAKING = "mFcCtSu";
  for (const m of commitFlags.matchAll(/(?:^|\s)-([A-Za-z]+)/g)) {
    for (const ch of m[1]) {
      if (ch === "n") return true;
      if (VALUE_TAKING.includes(ch)) break;
    }
  }
  return false;
}

export function commitsAllTracked(commitFlags: string): boolean {
  if (/(?:^|\s)--all(?:\s|$)/.test(commitFlags)) return true;
  const VALUE_TAKING = "mFcCtSu";
  for (const m of commitFlags.matchAll(/(?:^|\s)-([A-Za-z]+)/g)) {
    for (const ch of m[1]) {
      if (ch === "a") return true;
      if (VALUE_TAKING.includes(ch)) break;
    }
  }
  return false;
}

export function withoutQuotedSpans(text: string): string {
  // Built on the same mask, not a second copy of the quote grammar: two
  // spellings of "what is quoted" would drift, and this one guards the flag
  // scan while that one guards the directory. NUL becomes a space so the
  // surviving flags stay separated for the `(?:^|\s)` anchors.
  return maskQuotedSpans(text).replaceAll("\0", " ");
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
