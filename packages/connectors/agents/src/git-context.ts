import type { NativeSessionSnapshot } from "./types.ts";

export interface GitContext {
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
}

export interface GitCommandResult {
  code: number;
  stdout: string;
}

export type GitCommandRunner = (
  args: string[],
) => Promise<GitCommandResult>;

const EMPTY_GIT_CONTEXT: GitContext = {
  gitRepo: null,
  gitBranch: null,
  gitWorktreeRoot: null,
};

const runGitCommand: GitCommandRunner = async (args) => {
  const output = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "null",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
  };
};

function valueOf(result: GitCommandResult): string | null {
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export interface GitContextObservation {
  resolve(cwd: string | null): Promise<GitContext>;
  enrich(snapshot: NativeSessionSnapshot): Promise<NativeSessionSnapshot>;
}

class CachedGitContextObservation implements GitContextObservation {
  readonly #runner: GitCommandRunner;
  readonly #directories = new Map<string, Promise<GitContext>>();
  readonly #roots = new Map<
    string,
    Promise<Omit<GitContext, "gitWorktreeRoot">>
  >();

  constructor(runner: GitCommandRunner) {
    this.#runner = runner;
  }

  resolve(cwd: string | null): Promise<GitContext> {
    const directory = cwd?.trim();
    if (!directory) return Promise.resolve({ ...EMPTY_GIT_CONTEXT });
    let context = this.#directories.get(directory);
    if (!context) {
      context = this.#resolveDirectory(directory);
      this.#directories.set(directory, context);
    }
    return context;
  }

  async enrich(
    snapshot: NativeSessionSnapshot,
  ): Promise<NativeSessionSnapshot> {
    const context = await this.resolve(snapshot.summary.cwd);
    return {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        ...context,
      },
    };
  }

  async #resolveDirectory(directory: string): Promise<GitContext> {
    const root = valueOf(
      await this.#run(["-C", directory, "rev-parse", "--show-toplevel"]),
    );
    if (!root) return { ...EMPTY_GIT_CONTEXT };

    let context = this.#roots.get(root);
    if (!context) {
      context = this.#resolveRoot(root);
      this.#roots.set(root, context);
    }
    return { ...await context, gitWorktreeRoot: root };
  }

  async #resolveRoot(
    root: string,
  ): Promise<Omit<GitContext, "gitWorktreeRoot">> {
    const branch = valueOf(
      await this.#run(["-C", root, "branch", "--show-current"]),
    );
    let repo = valueOf(
      await this.#run(["-C", root, "remote", "get-url", "upstream"]),
    );
    if (!repo) {
      repo = valueOf(
        await this.#run(["-C", root, "remote", "get-url", "origin"]),
      );
    }
    return { gitRepo: repo, gitBranch: branch };
  }

  async #run(args: string[]): Promise<GitCommandResult> {
    try {
      return await this.#runner(args);
    } catch {
      return { code: -1, stdout: "" };
    }
  }
}

export class GitContextResolver {
  readonly #runner: GitCommandRunner;

  constructor(runner: GitCommandRunner = runGitCommand) {
    this.#runner = runner;
  }

  beginObservation(): GitContextObservation {
    return new CachedGitContextObservation(this.#runner);
  }

  resolve(cwd: string | null): Promise<GitContext> {
    return this.beginObservation().resolve(cwd);
  }

  enrich(
    snapshot: NativeSessionSnapshot,
  ): Promise<NativeSessionSnapshot> {
    return this.beginObservation().enrich(snapshot);
  }
}
