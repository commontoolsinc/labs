/**
 * Shared guards for Claude Code hook scripts.
 */

/**
 * Exits early if the working directory is outside the project directory,
 * preventing hooks from interfering with work in sibling repos.
 */
export function guardProjectDir(): void {
  const projectDir = Deno.env.get("CLAUDE_PROJECT_DIR") || "";
  if (projectDir) {
    const cwd = Deno.cwd();
    // Enforce path boundary: cwd must be the project dir itself or a subdirectory.
    // Without the separator check, "/repo2" would wrongly match "/repo".
    const isInProject = cwd === projectDir ||
      cwd.startsWith(projectDir + "/");
    if (!isInProject) {
      Deno.exit(0);
    }
  }
}

/**
 * Parses hook input from stdin and returns the command string.
 * Returns empty string if JSON is malformed.
 */
export async function parseCommand(): Promise<string> {
  const rawInput = await new Response(Deno.stdin.readable).text();
  try {
    const payload = JSON.parse(rawInput);
    return payload?.tool_input?.command ?? "";
  } catch {
    return "";
  }
}

/**
 * Parses hook input from stdin and returns the edited file's path.
 * Returns empty string if JSON is malformed.
 */
export async function parseFilePath(): Promise<string> {
  const rawInput = await new Response(Deno.stdin.readable).text();
  try {
    const payload = JSON.parse(rawInput);
    return payload?.tool_input?.file_path ?? "";
  } catch {
    return "";
  }
}

/**
 * A heredoc, from its `<<` to the line holding its delimiter. The delimiter
 * may be quoted and may hold the punctuation a shell word holds. Its closing
 * line carries the delimiter and nothing else, so a body line that merely
 * starts with those characters does not end the heredoc.
 */
const HEREDOC = /<<-?\s*(['"]?)([\w.-]+)\1[\s\S]*?\n[ \t]*\2[ \t]*$/gm;

/** The command substitutions inside `quoted`, which a shell still runs. */
function substitutionsIn(quoted: string): string {
  return (quoted.match(/\$\([^)]*\)|`[^`]*`/g) ?? []).join("\n");
}

/**
 * `cmd` with its heredoc bodies and quoted strings removed, leaving the parts
 * that name a program to run. A quoted string or a heredoc body is data the
 * command passes along. A commit message, a file being written, and an
 * argument to `grep` can all contain a program's name without running it.
 *
 * A double-quoted string keeps its command substitutions, which a shell runs
 * from inside one. A single-quoted string keeps nothing, since a shell runs
 * nothing from inside one.
 *
 * Text between backticks outside a quoted string is not removed either. A
 * shell runs that text as a command substitution.
 *
 * A command whose program name is itself quoted, as in `"npm" install`, reads
 * here as a command with no program name. Recognizing one means tracking which
 * quotes delimit a command word, which is parsing the shell.
 */
export function stripLiterals(cmd: string): string {
  return cmd
    .replace(HEREDOC, "")
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, substitutionsIn);
}

/**
 * Matches `command` where a shell takes the next word as the name of a program
 * to run. Those positions are the start of any line, and the position after
 * `;`, `&`, `|`, `(` or a backtick. The `(` case covers both a subshell and a
 * `$(...)` substitution, and the backtick covers the older substitution form.
 * A line start counts because one tool call often carries a whole script
 * rather than a single line.
 *
 * `command` is wrapped in its own group before being spliced in, so an
 * alternation inside it cannot match outside the anchor. It supplies its own
 * trailing boundary.
 *
 * The position after a shell keyword such as `then`, `do` or `else` is not
 * matched. These hooks cover the forms a command is ordinarily written in
 * rather than the whole of the shell's grammar.
 */
export function atCommandPosition(command: string): RegExp {
  return new RegExp(`(?:^[ \\t]*|[;&|(\`]\\s*)(?:${command})`, "m");
}
