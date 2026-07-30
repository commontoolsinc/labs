import { assertEquals } from "@std/assert";

/**
 * End-to-end tests for the pre-commit hook.
 *
 * The parser has its own table in common/worktree.test.ts, and for eight review
 * rounds that was the only coverage — which is why the defects kept landing
 * here instead. They were not parsing mistakes; they were mistakes in how this
 * file *composes* the parser: which file list reaches `checkFiles`, and in what
 * order the gates run. Neither is observable from a unit test of a helper.
 *
 * So these drive the real hook, against a real repository, and assert the two
 * things it promises: the right exit code, and nothing written to disk.
 *
 * Each test builds its own repository under `Deno.makeTempDir()` and removes it,
 * so nothing here touches the checkout it runs in — the same property the hook
 * itself exists to restore.
 */

const HOOK = new URL("./pre-commit.ts", import.meta.url).pathname;

/** A file `deno check` rejects, whatever the surrounding lint config. */
const TYPE_ERROR = 'export function broken(): number {\n  return "text";\n}\n';
const CLEAN = "export const fine = 1;\n";

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await new Deno.Command("git", {
    args: ["--no-optional-locks", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stdout).trim();
}

interface Repo {
  dir: string;
  indexHash(): Promise<string>;
}

async function makeRepo(): Promise<Repo> {
  const dir = await Deno.makeTempDir({ prefix: "pre-commit-hook-" });
  await run(dir, ["init", "-q", "."]);
  await run(dir, ["config", "user.email", "test@example.invalid"]);
  await run(dir, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${dir}/tracked.ts`, CLEAN);
  await run(dir, ["add", "tracked.ts"]);
  await run(dir, ["commit", "-q", "-m", "init"]);
  return {
    dir,
    async indexHash() {
      const path = await run(dir, ["rev-parse", "--git-path", "index"]);
      const bytes = await Deno.readFile(`${dir}/${path}`);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    },
  };
}

/** Invoke the hook exactly as Claude Code does, and report its exit code. */
async function hook(repo: Repo, command: string): Promise<number> {
  const payload = JSON.stringify({
    cwd: repo.dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-run", "--allow-env", HOOK],
    cwd: repo.dir,
    env: { CLAUDE_PROJECT_DIR: repo.dir },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const { code } = await child.output();
  return code;
}

Deno.test("blocks a staged file that fails a check, and writes nothing", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    await run(repo.dir, ["add", "bad.ts"]);

    const before = await repo.indexHash();
    assertEquals(await hook(repo, "git commit -m x"), 2);
    // The contract that broke five times in this hook's history. It is asserted
    // here rather than reasoned about.
    assertEquals(await repo.indexHash(), before, "hook wrote to the index");
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("judges the commit, not the index", async () => {
  const repo = await makeRepo();
  try {
    // Given pathspecs, git commits those and ignores the index. Judging the
    // index anyway skipped the file being committed and, with something else
    // staged, reported a pass about a file the commit did not contain.
    await Deno.writeTextFile(`${repo.dir}/tracked.ts`, TYPE_ERROR);
    await Deno.writeTextFile(`${repo.dir}/staged.ts`, CLEAN);
    await run(repo.dir, ["add", "staged.ts"]);

    assertEquals(await hook(repo, "git commit -m x tracked.ts"), 2);
    assertEquals(await hook(repo, "git commit -m x -- tracked.ts"), 2);
    // ...and the reverse: a pathspec that excludes the bad staged file.
    await Deno.writeTextFile(`${repo.dir}/other.ts`, TYPE_ERROR);
    await run(repo.dir, ["add", "other.ts"]);
    await Deno.writeTextFile(`${repo.dir}/tracked.ts`, CLEAN);
    assertEquals(await hook(repo, "git commit -m x tracked.ts"), 0);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("an option's value is not a flag", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    await run(repo.dir, ["add", "bad.ts"]);

    // `git commit -m --no-verify` has a message of "--no-verify" and
    // verification fully on. Read as a flag, it turned the hook off in silence.
    assertEquals(await hook(repo, "git commit -m --no-verify"), 2);
    assertEquals(await hook(repo, "git commit -m -n"), 2);
    assertEquals(await hook(repo, "git commit --message -n"), 2);
    // The real flag, and the abbreviation git also accepts, must both skip.
    assertEquals(await hook(repo, "git commit -m x --no-verify"), 0);
    assertEquals(await hook(repo, "git commit -m x --no-veri"), 0);
    assertEquals(await hook(repo, "git commit -nm x"), 0);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("never blocks a command that creates no commit", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    await run(repo.dir, ["add", "bad.ts"]);

    for (
      const command of [
        "git commit --help",
        "git commit -h",
        "git commit --dry-run",
        "git commit-graph write",
        "git status # remember to git commit -m x",
        "rg 'git commit' docs/",
      ]
    ) {
      assertEquals(await hook(repo, command), 0, command);
    }
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("resolves what a `git add` in the same command will stage", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    const before = await repo.indexHash();

    // The hook runs before the command, so nothing is staged yet: every one of
    // these is reachable only by reading the add.
    for (
      const command of [
        "git add bad.ts && git commit -m x",
        "git add -- bad.ts && git commit -m x",
        "git stage bad.ts && git commit -m x",
        "git add ok.ts && git add bad.ts && git commit -m x",
        "git add bad.ts >/dev/null && git commit -m x",
        'git add "bad.ts" && git commit -m x',
      ]
    ) {
      assertEquals(await hook(repo, command), 2, command);
    }
    // And resolving them stages nothing itself.
    assertEquals(await repo.indexHash(), before, "hook wrote to the index");
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("an editing flag is never dry-run", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/tracked.ts`, TYPE_ERROR);
    // Stat-stale but content-identical is the state in which several
    // read-shaped git commands rewrite the index.
    await Deno.utime(`${repo.dir}/tracked.ts`, new Date(0), new Date(0));

    const before = await repo.indexHash();
    // `git add -e` applies its patch to the index even under --dry-run, and
    // GIT_EDITOR=true accepts it silently.
    assertEquals(await hook(repo, "git add -e && git commit -m x"), 0);
    assertEquals(
      await repo.indexHash(),
      before,
      "hook staged the working tree",
    );
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});
