/**
 * The commit-message block of `git show` / `git log -p` output, and rewriting it
 * back to the commit. Git prints a commit's message indented four spaces, after
 * the `commit`/`Author`/`Date` header and before the diff. `cf view` lets the
 * message of the HEAD commit be edited in place; saving amends that commit.
 */

/** The indent git puts before every commit-message line. */
export const MESSAGE_INDENT = "    ";

// An object id is 40 hex characters in a SHA-1 repository and 64 in a SHA-256
// one; git also prints abbreviated ids, of at least seven characters.
const COMMIT_RE = /^commit ([0-9a-f]{7,64})\b/;

export interface CommitMessage {
  /** The commit hash, as printed after `commit `. */
  readonly sha: string;
  /** First and last (inclusive) 0-based line indices of the indented message. */
  readonly start: number;
  readonly end: number;
}

/**
 * Locate each commit's indented message region. Every message line begins with
 * the four-space indent (a blank message line is four spaces); the run ends at
 * the first line without it — the blank line before the diff, the next commit,
 * or the end of the input.
 */
export function findCommitMessages(lines: readonly string[]): CommitMessage[] {
  const out: CommitMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = COMMIT_RE.exec(lines[i]);
    if (!m) continue;
    // Skip the header lines (Author, Date, Merge, …) to the blank separator.
    let j = i + 1;
    while (
      j < lines.length && lines[j] !== "" &&
      !lines[j].startsWith(MESSAGE_INDENT)
    ) {
      j++;
    }
    if (lines[j] === "") j++; // the blank line before the message
    const start = j;
    while (j < lines.length && lines[j].startsWith(MESSAGE_INDENT)) j++;
    if (j > start) out.push({ sha: m[1], start, end: j - 1 });
  }
  return out;
}

/** The region containing `row`, or null when `row` is in no message. */
export function messageAt(
  messages: readonly CommitMessage[],
  row: number,
): CommitMessage | null {
  for (const m of messages) {
    if (row >= m.start && row <= m.end) return m;
  }
  return null;
}

/** The message text of a region: each line stripped of its four-space indent
 * and joined with newlines. */
export function extractMessage(
  lines: readonly string[],
  msg: CommitMessage,
): string {
  const body: string[] = [];
  for (let i = msg.start; i <= msg.end; i++) {
    const line = lines[i] ?? "";
    body.push(
      line.startsWith(MESSAGE_INDENT) ? line.slice(4) : line.trimStart(),
    );
  }
  return body.join("\n");
}

/** Whether `sha` names the same commit as `head` (either may be abbreviated). */
export function sameCommit(sha: string, head: string): boolean {
  const n = Math.min(sha.length, head.length);
  return n >= 7 && sha.slice(0, n) === head.slice(0, n);
}

/**
 * Runs the git operations the message editor needs. Injected so tests can drive
 * the editor without a real repository; {@link realGit} is the production one.
 */
export interface GitRunner {
  /** The current commit's full hash, or null (not a repo, or git failed). */
  headSha(): string | null;
  /** Replace the HEAD commit's message with `message`, keeping its tree and the
   * index untouched. Returns a status line; throws on failure. */
  amendMessage(message: string): string;
}

export function realGit(cwd: string): GitRunner {
  return {
    headSha() {
      try {
        const r = new Deno.Command("git", {
          args: ["rev-parse", "HEAD"],
          cwd,
          stdout: "piped",
          stderr: "null",
        }).outputSync();
        if (!r.success) return null;
        return new TextDecoder().decode(r.stdout).trim() || null;
      } catch {
        return null;
      }
    },
    amendMessage(message) {
      // `--only` with no pathspec rewords the message and does not fold in
      // staged changes. The message (its newlines intact) is passed as a single
      // `-m` argument, keeping the call synchronous — no stdin pipe or temp
      // file — to match the synchronous save path.
      const r = new Deno.Command("git", {
        args: ["commit", "--amend", "--only", "-m", message],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      if (!r.success) {
        const err = new TextDecoder().decode(r.stderr).trim();
        throw new Error(err || "git commit --amend failed");
      }
      return "Amended the commit message";
    },
  };
}
