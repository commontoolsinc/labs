type Environment = (name: string) => string | undefined;
type ReadGitCommit = () => string;

const decoder = new TextDecoder();
const REPOSITORY_ROOT = new URL("../../", import.meta.url);
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function currentGitCommit(): string {
  const result = new Deno.Command("git", {
    args: ["rev-parse", "--verify", "HEAD^{commit}"],
    cwd: REPOSITORY_ROOT,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    const detail = decoder.decode(result.stderr).trim();
    throw new Error(
      `Could not read the dashboard Git commit${detail ? `: ${detail}` : "."}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

function validGitCommit(value: string): string {
  if (!GIT_COMMIT_PATTERN.test(value)) {
    throw new Error(
      "Dashboard Git commit must be a full 40-character lowercase hash.",
    );
  }
  return value;
}

export function dashboardVersion(
  env: Environment = Deno.env.get,
  readGitCommit: ReadGitCommit = currentGitCommit,
): string {
  const deployedCommit = env("DASHBOARD_GIT_COMMIT");
  return validGitCommit(deployedCommit ?? readGitCommit());
}
