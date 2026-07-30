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
  /** Index bytes + working-tree status + deno.lock: everything a hook must leave alone. */
  fingerprint(): Promise<string>;
}

async function makeRepo(): Promise<Repo> {
  const dir = await Deno.makeTempDir({ prefix: "pre-commit-hook-" });
  await run(dir, ["init", "-q", "."]);
  await run(dir, ["config", "user.email", "test@example.invalid"]);
  await run(dir, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${dir}/tracked.ts`, CLEAN);
  await run(dir, ["add", "tracked.ts"]);
  await run(dir, ["commit", "-q", "-m", "init"]);
  async function sha(path: string): Promise<string> {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch {
      return "absent";
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
    return [...new Uint8Array(digest)].map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
  }

  async function indexHash(): Promise<string> {
    const relative = await run(dir, ["rev-parse", "--git-path", "index"]);
    return await sha(`${dir}/${relative}`);
  }

  async function fingerprint(): Promise<string> {
    return [
      await indexHash(),
      await run(dir, ["status", "--porcelain"]),
      await sha(`${dir}/deno.lock`),
    ].join("|");
  }

  return { dir, indexHash, fingerprint };
}

/**
 * Invoke the hook exactly as Claude Code does, and report its exit code.
 *
 * The read-only contract is asserted here, on every single call, rather than in
 * a test that remembers to check it. It broke seven times in this hook's
 * history, twice in code written to fix the previous break, and twice more in
 * ways that `git write-tree` and the index mtime could not see — so the check
 * belongs where it cannot be forgotten.
 */
async function hook(repo: Repo, command: string): Promise<number> {
  const before = await repo.fingerprint();
  const code = await invoke(repo, command);
  assertEquals(
    await repo.fingerprint(),
    before,
    `hook modified the worktree while inspecting: ${command}`,
  );
  return code;
}

async function invoke(repo: Repo, command: string): Promise<number> {
  const payload = JSON.stringify({
    cwd: repo.dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-run",
      "--allow-env",
      HOOK,
    ],
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

Deno.test("resolves the abbreviations git resolves", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    await run(repo.dir, ["add", "bad.ts"]);

    // git accepts any unambiguous prefix. Matching exact spellings mishandled
    // each of these in its own way: `--dr` blocked a read-only preview, `--inc`
    // dropped the staged files from the file set, `--mess` left its message
    // looking like a pathspec.
    for (const command of ["git commit --dr", "git commit --dry"]) {
      assertEquals(await hook(repo, command), 0, command);
    }
    assertEquals(await hook(repo, "git commit -m x --no-ver"), 0);
    assertEquals(await hook(repo, "git commit --mess x"), 2);
    assertEquals(await hook(repo, "git commit --inc -m x tracked.ts"), 2);
    // Contents named in a file we never read: say so rather than fall back to
    // the index, which is a verdict about a different change.
    assertEquals(
      await hook(repo, "git commit -m x --pathspec-from-file=list.txt"),
      0,
    );
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("a pathspec containing spaces survives", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/my file.ts`, CLEAN);
    await run(repo.dir, ["add", "my file.ts"]);
    await run(repo.dir, ["commit", "-q", "-m", "add spaced"]);
    await Deno.writeTextFile(`${repo.dir}/my file.ts`, TYPE_ERROR);

    // Reading pathspecs from the quote-blanked flag region lost this one
    // entirely, and the hook fell back to judging the index instead.
    assertEquals(await hook(repo, 'git commit -m x "my file.ts"'), 2);
    assertEquals(await hook(repo, 'git commit -m x -- "my file.ts"'), 2);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("the multi-commit warning survives every earlier gate", async () => {
  const repo = await makeRepo();
  try {
    await Deno.writeTextFile(`${repo.dir}/bad.ts`, TYPE_ERROR);
    // Each early exit returns 0, so whichever ran first swallowed this warning
    // and turned an unmodelled second commit back into a silent pass.
    for (
      const first of [
        "git commit --dry-run",
        "git commit --help",
        "git commit -m one --no-verify",
      ]
    ) {
      const code = await hook(
        repo,
        `${first} && git add bad.ts && git commit -m two`,
      );
      assertEquals(code, 0, first);
    }
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

Deno.test("leaves a racily-clean index alone", async () => {
  const repo = await makeRepo();
  try {
    // Content matching the index with a differing mtime — what editing a file
    // and reverting it leaves behind. In that state `git diff <commit>` calls
    // refresh_index_quietly() and rewrites the index, and `--no-optional-locks`
    // does not cover it. Every commit shape that names a pathspec, or `-a`,
    // reached it. Invisible to `git write-tree` and to the index mtime.
    await Deno.writeTextFile(`${repo.dir}/second.ts`, CLEAN);
    await run(repo.dir, ["add", "second.ts"]);
    await run(repo.dir, ["commit", "-q", "-m", "second"]);

    for (
      const command of [
        "git commit -m wip tracked.ts",
        "git commit -m wip -- tracked.ts",
        "git commit -m wip .",
        "git commit -i -m wip tracked.ts",
        "git commit -am wip",
        "git commit -m wip",
        "git add tracked.ts && git commit -m wip",
      ]
    ) {
      await Deno.utime(`${repo.dir}/tracked.ts`, new Date(0), new Date(0));
      // hook() asserts the fingerprint itself; the exit code is incidental here.
      await hook(repo, command);
    }
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});
