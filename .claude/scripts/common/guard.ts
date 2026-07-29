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
 * Returns true if the command is a git commit (with message content
 * that should not be inspected for command patterns).
 *
 * Re-exported rather than defined here so there is one answer to "is this a
 * commit?" across all the hooks. The version this replaced missed
 * `git -C <dir> commit`, which for these callers meant a commit message
 * mentioning `node` or a legacy CLI was inspected as if it were a command.
 */
export { isGitCommit } from "./worktree.ts";
