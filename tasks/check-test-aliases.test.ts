import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { gitShowFailureMeansAbsent } from "./check-test-aliases.ts";

describe("check-test-aliases", () => {
  describe("gitShowFailureMeansAbsent()", () => {
    it("returns true for the two absent-path messages", () => {
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: path 'tasks/test-identity-aliases.jsonl' " +
          "does not exist in 'abc123'",
      )).toBe(true);
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: path 'tasks/test-identity-aliases.jsonl' " +
          "exists on disk, but not in 'abc123'",
      )).toBe(true);
    });

    it("returns false for any other git failure", () => {
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: unable to read tree",
      )).toBe(false);
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: bad object abc123",
      )).toBe(false);
    });
  });
});

// The gate run whole, against scratch repositories: an append passes, a
// rewrite fails, a bad line fails, and a missing merge base is a setup
// error. Spawned through the frozen-lock helper with the repository's own
// config, since the scratch checkout has neither.
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const ALIAS_LINE = JSON.stringify({
  date: "2026-08-17",
  from: { k: "unit", s: "bakery", n: "old" },
  to: { k: "unit", s: "bakery", n: "new" },
});

async function scratchRepo(committedAliases: string | undefined): Promise<
  { dir: string; base: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "check-aliases-repo-" });
  const git = async (...args: string[]) => {
    const { code, stderr } = await new Deno.Command("git", {
      args,
      cwd: dir,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  };
  await git("init", "--initial-branch=main");
  await Deno.mkdir(join(dir, "tasks"), { recursive: true });
  if (committedAliases !== undefined) {
    await Deno.writeTextFile(
      join(dir, "tasks", "test-identity-aliases.jsonl"),
      committedAliases,
    );
  } else {
    await Deno.writeTextFile(join(dir, "README.md"), "scratch\n");
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  const revParse = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: dir,
    stdout: "piped",
  }).output();
  return { dir, base: new TextDecoder().decode(revParse.stdout).trim() };
}

async function runGate(
  dir: string,
  base: string,
): Promise<{ code: number; output: string }> {
  const result = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    cwd: dir,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-read",
      "--allow-run=git",
      join(REPO_ROOT, "tasks", "check-test-aliases.ts"),
      base,
    ],
  });
  return {
    code: result.code,
    output: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  };
}

describe("check-test-aliases gate", () => {
  it("passes an appended line and a file created after the base", async () => {
    const appended = await scratchRepo(ALIAS_LINE + "\n");
    const created = await scratchRepo(undefined);
    try {
      await Deno.writeTextFile(
        join(appended.dir, "tasks", "test-identity-aliases.jsonl"),
        ALIAS_LINE + "\n" + ALIAS_LINE.replace("old", "older") + "\n",
      );
      const grown = await runGate(appended.dir, appended.base);
      expect(grown.output).toContain("append-only and acyclic");
      expect(grown.code).toBe(0);

      await Deno.writeTextFile(
        join(created.dir, "tasks", "test-identity-aliases.jsonl"),
        ALIAS_LINE + "\n",
      );
      const fresh = await runGate(created.dir, created.base);
      expect(fresh.code).toBe(0);
    } finally {
      await Deno.remove(appended.dir, { recursive: true }).catch(() => {});
      await Deno.remove(created.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a rewrite of committed history", async () => {
    const repo = await scratchRepo(ALIAS_LINE + "\n");
    try {
      await Deno.writeTextFile(
        join(repo.dir, "tasks", "test-identity-aliases.jsonl"),
        ALIAS_LINE.replace("2026-08-17", "2026-08-16") + "\n",
      );
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("rewrites history");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails a malformed appended line, naming it", async () => {
    const repo = await scratchRepo(ALIAS_LINE + "\n");
    try {
      await Deno.writeTextFile(
        join(repo.dir, "tasks", "test-identity-aliases.jsonl"),
        ALIAS_LINE + "\n" + JSON.stringify({
          date: "2026-02-31",
          from: { k: "unit", s: "bakery", n: "x" },
          to: { k: "unit", s: "bakery", n: "y" },
        }) + "\n",
      );
      const result = await runGate(repo.dir, repo.base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("impossible calendar date");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });

  it("treats a missing merge base as a setup error", async () => {
    const repo = await scratchRepo(ALIAS_LINE + "\n");
    try {
      const result = await runGate(repo.dir, "no-such-ref");
      expect(result.code).toBe(2);
      expect(result.output).toContain("Cannot find the merge base");
    } finally {
      await Deno.remove(repo.dir, { recursive: true }).catch(() => {});
    }
  });
});
