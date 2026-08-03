import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { gitShaForCliLibDir, resolveCliGitSha } from "../lib/build-info.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

/** A repository shaped like a labs checkout: its own git directory and a
 * committed packages/cli/lib tree. Returns its HEAD. */
async function makeLabsLikeRepo(root: string): Promise<string> {
  await Deno.mkdir(join(root, "packages", "cli", "lib"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "packages", "cli", "lib", "build-info.ts"),
    "// fixture\n",
  );
  await git(root, "init");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return await git(root, "rev-parse", "HEAD");
}

Deno.test("gitShaForCliLibDir", async (t) => {
  const tempDir = await Deno.makeTempDir({ prefix: "build-info-git-" });
  try {
    await t.step("reports HEAD for a real labs checkout", async () => {
      const root = join(tempDir, "labs");
      const head = await makeLabsLikeRepo(root);
      assertEquals(
        await gitShaForCliLibDir(join(root, "packages", "cli", "lib")),
        head,
      );
    });

    await t.step("reports HEAD for a linked worktree", async () => {
      const root = join(tempDir, "labs"); // created above
      const worktree = join(tempDir, "labs-worktree");
      await git(root, "worktree", "add", worktree);
      assertEquals(
        await gitShaForCliLibDir(join(worktree, "packages", "cli", "lib")),
        await git(worktree, "rev-parse", "HEAD"),
      );
    });

    await t.step(
      "vendored labs without its own git directory reports unknown, not the host repo's HEAD",
      async () => {
        // <host>/vendor/labs has no .git, so rev-parse resolves the HOST
        // repository — whose HEAD must not be reported. The host even has a
        // packages/cli/lib of its own to make sure the guard compares
        // locations, not mere existence.
        const host = join(tempDir, "host");
        await makeLabsLikeRepo(host);
        const vendoredLib = join(
          host,
          "vendor",
          "labs",
          "packages",
          "cli",
          "lib",
        );
        await Deno.mkdir(vendoredLib, { recursive: true });
        assertEquals(await gitShaForCliLibDir(vendoredLib), null);
      },
    );

    await t.step(
      "a directory outside any repository reports unknown",
      async () => {
        const bare = join(tempDir, "bare");
        await Deno.mkdir(bare, { recursive: true });
        assertEquals(await gitShaForCliLibDir(bare), null);
      },
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveCliGitSha reports this checkout's HEAD for a source run", async () => {
  // Under `deno test` this is a source run (`Deno.build.standalone` false),
  // so resolution must come from git against the checkout containing
  // lib/build-info.ts — this repository (itself a worktree in worktree-based
  // setups, which this covers by construction).
  const sha = await resolveCliGitSha();
  assert(sha !== null, "source run in a checkout should resolve a commit");
  assertMatch(sha, /^[0-9a-f]{40}$/);
  const moduleDir = new URL("../lib", import.meta.url).pathname;
  assertEquals(sha, await git(moduleDir, "rev-parse", "HEAD"));
});
