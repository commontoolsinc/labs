/**
 * Shared guards for Claude Code hook scripts.
 */

/**
 * Exits early if the working directory is outside the project directory,
 * preventing hooks from interfering with work in sibling repos.
 */
export function guardProjectDir(): void {
  const projectDir = Deno.env.get("CLAUDE_PROJECT_DIR") || "";
  if (projectDir && !Deno.cwd().startsWith(projectDir)) {
    Deno.exit(0);
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
 */
export function isGitCommit(cmd: string): boolean {
  return /\bgit\s+commit\b/.test(cmd);
}
