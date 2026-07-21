import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  extractMessage,
  findCommitHeaders,
  findCommitMessages,
  messageAt,
  realGit,
  sameCommit,
} from "../lib/view/commitmsg.ts";

const SHOW = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: A B <a@b.example>",
  "Date:   Wed Jul 1 12:00:00 2026 -0700",
  "",
  "    Subject line",
  "    ",
  "    Body paragraph.",
  "",
  "diff --git a/f b/f",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n").split("\n");

Deno.test("findCommitMessages: the indented block after the header, ending at the diff", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].sha, "0123456789abcdef0123456789abcdef01234567");
  assertEquals(msgs[0].start, 4, "starts at the first indented line");
  assertEquals(msgs[0].end, 6, "ends at the last indented line");
});

Deno.test("findCommitMessages: a SHA-256 repository's 64-character object id", () => {
  const sha = "a".repeat(64);
  const lines = [`commit ${sha}`, "Author: A B <a@b>", "", "    Subject", ""];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].sha, sha);
  assertEquals([msgs[0].start, msgs[0].end], [3, 3]);
});

Deno.test("findCommitMessages: a commit line without an object id yields no region", () => {
  const lines = ["commit not-a-sha", "Author: A", "", "    Subject", ""];
  assertEquals(findCommitMessages(lines).length, 0);
});

Deno.test("findCommitMessages: a Merge header line is skipped", () => {
  const lines = [
    "commit abcdef1234567",
    "Merge: 111 222",
    "Author: A B <a@b>",
    "Date:   today",
    "",
    "    Merge branch 'x'",
    "",
  ];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].start, 5);
  assertEquals(msgs[0].end, 5);
});

Deno.test("findCommitMessages: several commits (git log -p) each get a region", () => {
  const lines = [
    "commit aaaaaaa",
    "Author: A",
    "",
    "    first",
    "",
    "commit bbbbbbb",
    "Author: B",
    "",
    "    second",
    "",
  ];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.map((m) => m.sha), ["aaaaaaa", "bbbbbbb"]);
  assertEquals(msgs.map((m) => [m.start, m.end]), [[3, 3], [8, 8]]);
});

Deno.test("findCommitHeaders: compact, reference, and email formats", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assertEquals(findCommitHeaders([`${full} Subject`]), [
    { sha: full, line: 0 },
  ]);
  assertEquals(
    findCommitHeaders(["89abcdef (Reference subject, 2026-07-20)"]),
    [{ sha: "89abcdef", line: 0 }],
  );
  assertEquals(
    findCommitHeaders([
      `From ${full} Mon Sep 17 00:00:00 2001`,
      "From: A B <a@b.example>",
      "Date: Wed, 1 Jul 2026 12:00:00 -0700",
      "Subject: [PATCH] Subject",
      "",
    ]),
    [{ sha: full, line: 0 }],
  );
  assertEquals(
    findCommitHeaders([`${full} Empty HEAD`, "89abcdef Parent with a patch"]),
    [{ sha: full, line: 0 }, { sha: "89abcdef", line: 1 }],
  );
});

Deno.test("findCommitHeaders: email message text is not a compact header", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const lines = [
    `From ${full} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Subject",
    "",
    "ffff ordinary body line",
    "commit deadbeef",
    `From ${"f".repeat(40)} Mon Sep 17 00:00:00 2001`,
    "From: Fake Author <fake@example.test>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Embedded envelope",
    "",
    "diff --git a/f b/f",
  ];

  assertEquals(findCommitHeaders(lines), [{ sha: full, line: 0 }]);
});

Deno.test("findCommitMessages: a commit with no message body yields no region", () => {
  const lines = ["commit deadbeef", "Author: A", "", "diff --git a/f b/f"];
  assertEquals(findCommitMessages(lines).length, 0);
  assertEquals(findCommitHeaders(lines), [{ sha: "deadbeef", line: 0 }]);
});

Deno.test("messageAt: maps a row to its region or null", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(messageAt(msgs, 4)?.start, 4, "inside");
  assertEquals(messageAt(msgs, 6)?.end, 6, "inside at the end");
  assertEquals(messageAt(msgs, 3), null, "the blank separator is outside");
  assertEquals(messageAt(msgs, 9), null, "the diff is outside");
});

Deno.test("extractMessage: strips the four-space indent and joins", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(
    extractMessage(SHOW, msgs[0]),
    "Subject line\n\nBody paragraph.",
  );
});

Deno.test("commit messages ignore CRLF transport carriage returns", () => {
  const lines = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
    "",
    "    Subject line",
    "    ",
    "    Body paragraph.",
    "",
  ].join("\r\n").split("\n");
  const messages = findCommitMessages(lines);

  assertEquals(messages.length, 1);
  assertEquals(
    extractMessage(lines, messages[0]),
    "Subject line\n\nBody paragraph.",
  );
});

Deno.test("sameCommit: matches Git's four-character minimum abbreviation", () => {
  assert(sameCommit("0123456", "0123456789abcdef"), "7-char abbrev matches");
  assert(sameCommit("0123", "0123456789abcdef"), "4-char abbrev matches");
  assert(sameCommit("0123456789abcdef", "0123456"), "either side may be short");
  assert(!sameCommit("0123456", "0123999"), "different prefix");
  assert(!sameCommit("012", "0123456"), "under four chars never matches");
});

// --- realGit against a throwaway repository -----------------------------------

async function git(
  root: string,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: root,
    env,
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const p = cmd.spawn();
  if (stdin !== undefined) {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await p.output();
  return new TextDecoder().decode(o.stdout);
}

async function installHook(root: string, name: string, script: string) {
  const path = `${root}/.git/hooks/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function initReftable(root: string): Promise<boolean> {
  const initialized = await new Deno.Command("git", {
    args: ["init", "-q", "--ref-format=reftable"],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  return initialized.success;
}

async function withGitShim<T>(
  body: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const lookup = await new Deno.Command("which", {
    args: ["git"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(lookup.success, "the real Git executable is available");
  const realGitPath = new TextDecoder().decode(lookup.stdout).trim();
  const shimDir = await Deno.makeTempDir();
  const shim = `${shimDir}/git`;
  await Deno.writeTextFile(
    shim,
    `#!/bin/sh
${body}
exec ${shellQuote(realGitPath)} "$@"
`,
  );
  await Deno.chmod(shim, 0o755);
  const originalPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${shimDir}:${originalPath ?? ""}`);
  try {
    return await callback();
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(shimDir, { recursive: true });
  }
}

Deno.test("realGit: reads HEAD and amends the message, keeping the tree", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "a\nb\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    const g = realGit(root);
    const head = g.headSha();
    assert(head && head.length === 40, `HEAD is a full hash: ${head}`);

    // Stage an unrelated change to prove the amend does not fold it in.
    await Deno.writeTextFile(`${root}/f.txt`, "a\nb\nc\n");
    await git(root, ["add", "f.txt"]);

    const status = g.amendCommit(
      "new subject\n\nnew body",
      new Map(),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      (await git(root, ["log", "-1", "--format=%B"])).trim(),
      "new subject\n\nnew body",
    );
    assert(g.headSha() !== head, "amending produced a new commit");
    // The committed tree still has two lines; the staged `c` was not included.
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "a\nb\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: preserves a configured reference-transaction hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const journal = `${root}/hook-journal`;
      await installHook(
        root,
        "reference-transaction",
        `printf '%s\\n' "$1" >> ${shellQuote(journal)}
cat >> ${shellQuote(journal)}`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      const hookOutput = await Deno.readTextFile(journal);
      assert(hookOutput.includes("prepared\n"), hookOutput);
      assert(hookOutput.includes("committed\n"), hookOutput);
      assert(hookOutput.includes(" refs/heads/"), hookOutput);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: preserves hook paths and hooks installed during the amend",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const helperMarker = `${root}/helper-ran`;
      const helper = `${root}/.git/check`;
      await Deno.writeTextFile(
        helper,
        `#!/bin/sh\nprintf ran > ${shellQuote(helperMarker)}\n`,
      );
      await Deno.chmod(helper, 0o755);
      const commitMessageHook = `${root}/.git/hooks/commit-msg`;
      await installHook(
        root,
        "pre-commit",
        `"$(dirname "$0")/../check"
printf '#!/bin/sh\\nexit 1\\n' > ${shellQuote(commitMessageHook)}
chmod +x ${shellQuote(commitMessageHook)}`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
      );

      assertEquals(await Deno.readTextFile(helperMarker), "ran");
      assertEquals(runner.headSha(), original);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: preserves whitespace in a relative core.hooksPath",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const hooksName = " custom-hooks ";
      await git(root, ["config", "core.hooksPath", hooksName]);
      const hooks = `${root}/${hooksName}`;
      await Deno.mkdir(hooks);
      const marker = `${root}/post-commit-ran`;
      const hook = `${hooks}/post-commit`;
      await Deno.writeTextFile(
        hook,
        `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\n`,
      );
      await Deno.chmod(hook, 0o755);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(marker), "ran");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: source hooks observe their configured hooks path",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const hooksName = "custom hooks";
      await git(root, ["config", "core.hooksPath", hooksName]);
      const hooks = `${root}/${hooksName}`;
      await Deno.mkdir(hooks);
      const marker = `${root}/pre-commit-ran`;
      const hook = `${hooks}/pre-commit`;
      await Deno.writeTextFile(
        hook,
        `#!/bin/sh
test "$(git config --get core.hooksPath)" = ${shellQuote(hooksName)} || exit 41
printf ran > ${shellQuote(marker)}
`,
      );
      await Deno.chmod(hook, 0o755);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(marker), "ran");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: preserves an explicitly empty core.hooksPath",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const marker = `${root}/post-commit-ran`;
      await installHook(
        root,
        "post-commit",
        `printf ran > ${shellQuote(marker)}`,
      );
      await git(root, ["config", "core.hooksPath", ""]);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      let hookRan = true;
      try {
        await Deno.stat(marker);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) hookRan = false;
        else throw error;
      }
      assert(!hookRan, "the disabled hook did not run");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: hook-spawned Git uses the other repository's hooks",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    const other = await Deno.makeTempDir();
    try {
      for (const repository of [root, other]) {
        await git(repository, ["init", "-q"]);
        await git(repository, ["config", "user.email", "t@t.test"]);
        await git(repository, ["config", "user.name", "Test"]);
        await git(repository, [
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "original",
        ]);
      }
      await installHook(other, "pre-commit", "exit 1");
      await installHook(
        root,
        "post-commit",
        `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${shellQuote(other)} commit --allow-empty -q -m nested`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      const otherOriginal = (await git(other, ["rev-parse", "HEAD"])).trim();
      assert(original && otherOriginal, "both repositories have HEAD commits");

      const result = runner.amendCommit("amended", new Map(), original);

      assert(result.head !== original, "the source commit was amended");
      assertEquals(
        (await git(other, ["rev-parse", "HEAD"])).trim(),
        otherOriginal,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: preserves nested Git configuration for another repository",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    const other = await Deno.makeTempDir();
    try {
      for (const repository of [root, other]) {
        await git(repository, ["init", "-q"]);
        await git(repository, ["config", "user.email", "t@t.test"]);
        await git(repository, ["config", "user.name", "Test"]);
        await git(repository, [
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "original",
        ]);
      }
      const marker = `${other}/pre-commit-ran`;
      await installHook(
        other,
        "pre-commit",
        `test "$(git config --get nested.flag)" = yes || exit 43
printf ran > ${shellQuote(marker)}`,
      );
      await installHook(
        root,
        "post-commit",
        `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${
          shellQuote(other)
        } -c nested.flag=yes commit --allow-empty -q -m nested`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "source repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(marker), "ran");
      assertEquals(
        (await git(other, ["rev-list", "--count", "HEAD"])).trim(),
        "2",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: hook-spawned Git uses a linked worktree's hooks",
  ignore: Deno.build.os === "windows",
  async fn() {
    const parent = await Deno.makeTempDir();
    const root = `${parent}/root`;
    const linked = `${parent}/linked`;
    try {
      await Deno.mkdir(root);
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      await git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
      await git(root, ["config", "extensions.worktreeConfig", "true"]);
      await git(root, [
        "config",
        "--worktree",
        "core.hooksPath",
        ".root-hooks",
      ]);
      await git(linked, [
        "config",
        "--worktree",
        "core.hooksPath",
        ".linked-hooks",
      ]);
      await Deno.mkdir(`${root}/.root-hooks`);
      await Deno.mkdir(`${linked}/.linked-hooks`);
      const rootMarker = `${root}/pre-commit-ran`;
      const linkedMarker = `${linked}/pre-commit-ran`;
      await Deno.writeTextFile(
        `${root}/.root-hooks/pre-commit`,
        `#!/bin/sh
test ! -e ${shellQuote(rootMarker)} || exit 44
printf ran > ${shellQuote(rootMarker)}
`,
      );
      await Deno.chmod(`${root}/.root-hooks/pre-commit`, 0o755);
      await Deno.writeTextFile(
        `${linked}/.linked-hooks/pre-commit`,
        `#!/bin/sh
printf ran > ${shellQuote(linkedMarker)}
`,
      );
      await Deno.chmod(`${linked}/.linked-hooks/pre-commit`, 0o755);
      await Deno.writeTextFile(
        `${root}/.root-hooks/post-commit`,
        `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${shellQuote(linked)} commit --allow-empty -q -m nested
`,
      );
      await Deno.chmod(`${root}/.root-hooks/post-commit`, 0o755);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "source repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(rootMarker), "ran");
      assertEquals(await Deno.readTextFile(linkedMarker), "ran");
      assertEquals(
        (await git(linked, ["rev-list", "--count", "HEAD"])).trim(),
        "2",
      );
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  },
});

Deno.test("realGit: accepts an amend that reproduces the same commit object", async () => {
  const root = await Deno.makeTempDir();
  const authorDate = Deno.env.get("GIT_AUTHOR_DATE");
  const committerDate = Deno.env.get("GIT_COMMITTER_DATE");
  try {
    const fixedDate = "2001-01-01T00:00:00+00:00";
    Deno.env.set("GIT_AUTHOR_DATE", fixedDate);
    Deno.env.set("GIT_COMMITTER_DATE", fixedDate);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "same\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "same"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit("same", new Map(), head);

    assertEquals(result.head, head);
    assertEquals(runner.headSha(), head);
    assert(result.status.includes("Amended"), result.status);
  } finally {
    if (authorDate === undefined) Deno.env.delete("GIT_AUTHOR_DATE");
    else Deno.env.set("GIT_AUTHOR_DATE", authorDate);
    if (committerDate === undefined) Deno.env.delete("GIT_COMMITTER_DATE");
    else Deno.env.set("GIT_COMMITTER_DATE", committerDate);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves non-UTF-8 commit message bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
    const file = `${root}/f.txt`;
    await Deno.writeTextFile(file, "before\n");
    await git(root, ["add", "f.txt"]);
    const messagePath = `${root}/message`;
    await Deno.writeFile(messagePath, new Uint8Array([0xff, 0x0a]));
    await git(root, [
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-F",
      messagePath,
    ]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    await git(root, ["config", "--unset", "i18n.commitEncoding"]);
    await Deno.writeTextFile(file, "after\n");

    runner.amendCommit(null, new Map([[file, "after\n"]]), head);

    const output = await new Deno.Command("git", {
      args: ["cat-file", "commit", "HEAD"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, "the amended commit can be read");
    let separator = -1;
    for (let index = 0; index + 1 < output.stdout.length; index++) {
      if (output.stdout[index] === 10 && output.stdout[index + 1] === 10) {
        separator = index;
        break;
      }
    }
    assert(separator >= 0, "the commit has a message separator");
    assertEquals(
      output.stdout.slice(separator + 2),
      new Uint8Array([0xff, 0x0a]),
    );
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "after\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: labels edited commit messages as UTF-8", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit("é edited", new Map(), head);

    const raw = await git(root, ["cat-file", "commit", "HEAD"]);
    assert(!raw.includes("encoding ISO-8859-1\n"), raw);
    assertEquals(
      await git(root, [
        "-c",
        "i18n.logOutputEncoding=UTF-8",
        "log",
        "-1",
        "--format=%B",
      ]),
      "é edited\n\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: amends a valid empty commit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit("amended", new Map(), head);

    assert(result.head !== head, "the empty commit was replaced");
    assertEquals(
      (await git(root, ["log", "-1", "--format=%s"])).trim(),
      "amended",
    );
    assertEquals((await git(root, ["show", "--format=", "--stat"])).trim(), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: amends reftable commits and preserves staged state", async () => {
  const root = await Deno.makeTempDir();
  try {
    if (!await initReftable(root)) return;

    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/selected.txt`, "original selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "original unrelated\n");
    await git(root, ["add", "selected.txt", "unrelated.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const marker = `${root}/hook-ran`;
    await installHook(root, "pre-commit", `touch ${shellQuote(marker)}`);
    await Deno.writeTextFile(`${root}/selected.txt`, "amended selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "staged unrelated\n");
    await git(root, ["add", "unrelated.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit(
      "amended",
      new Map([[`${root}/selected.txt`, "amended selected\n"]]),
      head,
    );

    assert(result.head !== head, "the reftable commit was replaced");
    assertEquals(runner.headSha(), result.head);
    assertEquals(
      (await git(root, ["log", "-1", "--format=%s"])).trim(),
      "amended",
    );
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "amended selected\n",
    );
    assertEquals(
      await git(root, ["show", "HEAD:unrelated.txt"]),
      "original unrelated\n",
    );
    assertEquals(
      await git(root, ["show", ":unrelated.txt"]),
      "staged unrelated\n",
    );
    await Deno.stat(marker);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: amends a detached reftable HEAD", async () => {
  const root = await Deno.makeTempDir();
  try {
    if (!await initReftable(root)) return;
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const branch = (await git(root, ["symbolic-ref", "HEAD"])).trim();
    const original = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["checkout", "-q", "--detach"]);
    const runner = realGit(root);

    const result = runner.amendCommit(
      "detached amend",
      new Map([[`${root}/f.txt`, "amended\n"]]),
      original,
      "HEAD",
    );

    assert(result.head !== original, "the detached commit was replaced");
    assertEquals(runner.headRef!(), "HEAD");
    assertEquals(runner.headSha(), result.head);
    assertEquals((await git(root, ["rev-parse", branch])).trim(), original);
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "amended\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: amends reftable commits in a linked worktree", async () => {
  const parent = await Deno.makeTempDir();
  const root = `${parent}/repository`;
  const linked = `${parent}/linked`;
  try {
    await Deno.mkdir(root);
    if (!await initReftable(root)) return;
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["worktree", "add", "-q", "-b", "topic", linked]);
    const runner = realGit(linked);
    const original = runner.headSha();
    const branch = runner.headRef!();
    assert(original && branch, "the linked worktree has a branch and commit");

    const result = runner.amendCommit(
      "linked amend",
      new Map([[`${linked}/f.txt`, "linked\n"]]),
      original,
      branch,
    );

    assert(result.head !== original, "the linked-worktree commit was replaced");
    assertEquals(runner.headSha(), result.head);
    assertEquals(await git(linked, ["show", "HEAD:f.txt"]), "linked\n");
    assertEquals((await git(root, ["rev-parse", branch])).trim(), result.head);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rolls back a reftable amend rewritten by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      if (!await initReftable(root)) return;
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");
      await installHook(
        root,
        "commit-msg",
        `printf '\\nHook-Trailer: added\\n' >> "$1"`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
        "hook changed",
      );

      assertEquals(runner.headSha(), original);
      assertEquals(
        (await git(root, ["log", "-1", "--format=%s"])).trim(),
        "original",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rolls back nested reftable commits made by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      if (!await initReftable(root)) return;
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");
      const marker = `${root}/.git/nested-reftable-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
fi`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
        "HEAD changed",
      );

      assertEquals(runner.headSha(), original);
      assertEquals(
        (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
        "1",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: accepts an amend after a hook expires its reflog entry",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        await installHook(
          root,
          "post-commit",
          "git reflog expire --expire=now --all",
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        const result = runner.amendCommit("amended", new Map(), original);

        assert(result.head !== original, `${storage} replaced the commit`);
        assertEquals(runner.headSha(), result.head);
        assertEquals(
          (await git(root, ["log", "-1", "--format=%s"])).trim(),
          "amended",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: rolls back without a reflog when hook validation fails",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        const path = `${root}/f.txt`;
        await Deno.writeTextFile(path, "original\n");
        await git(root, ["add", "f.txt"]);
        await git(root, ["commit", "-q", "-m", "original"]);
        await installHook(
          root,
          "post-commit",
          `git reflog expire --expire=now --all\nprintf 'hook change\\n' > ${
            shellQuote(path)
          }`,
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        assertThrows(
          () =>
            runner.amendCommit(
              "amended",
              new Map(),
              original,
              undefined,
              new Map([[path, "original\n"]]),
            ),
          Error,
          "changed while commit hooks ran",
        );

        assertEquals(runner.headSha(), original);
        assertEquals(await Deno.readTextFile(path), "hook change\n");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: rolls back nested commits after hooks expire reflogs",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        const marker = `${root}/.git/nested-expiry-hook-ran`;
        await installHook(
          root,
          "post-commit",
          `if test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
  git reflog expire --expire=now --all
fi`,
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        const error = assertThrows(
          () => runner.amendCommit("amended", new Map(), original),
          Error,
          "HEAD changed",
        );
        assert(!error.message.includes("rollback failed"), error.message);

        assertEquals(runner.headSha(), original, storage);
        assertEquals(
          (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
          "1",
          storage,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: journals nested commits from a reference-transaction hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        const marker = `${root}/.git/reference-hook-ran`;
        await installHook(
          root,
          "reference-transaction",
          `if test "$1" = committed && test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
  git reflog expire --expire=now --all
fi`,
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        const error = assertThrows(
          () => runner.amendCommit("amended", new Map(), original),
          Error,
          "HEAD changed",
        );
        assert(!error.message.includes("rollback failed"), error.message);

        assertEquals(runner.headSha(), original, storage);
        assertEquals(
          (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
          "1",
          storage,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: restores a checked-out ref deleted by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        const runner = realGit(root);
        const original = runner.headSha();
        const branch = runner.headRef!();
        assert(original && branch, "repository has a branch and HEAD commit");
        await installHook(
          root,
          "post-commit",
          `git update-ref -d ${shellQuote(branch)}
git reflog expire --expire=now --all`,
        );

        const error = assertThrows(
          () => runner.amendCommit("amended", new Map(), original),
          Error,
          "HEAD changed",
        );
        assert(!error.message.includes("rollback failed"), error.message);

        assertEquals(runner.headSha(), original, storage);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test("realGit: preserves pager insertion order around a workspace insertion", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);
    assert(runner.applyFileChanges, "the real Git runner applies file changes");
    assertEquals(
      runner.applyFileChanges(
        "A\nB\n",
        "A\nX\nB\n",
        "A\nP\nX\nQ\nB\n",
        `${root}/f.txt`,
      ),
      "A\nP\nQ\nB\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: rejects an insertion at a hidden deletion boundary", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);

    assertThrows(
      () =>
        runner.applyFileChanges(
          "A\nX\nB\n",
          "A\nB\n",
          "A\nP\nB\n",
          `${root}/f.txt`,
        ),
      Error,
      "overlap workspace changes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: amends selected files and preserves unrelated staged changes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/selected.txt`, "old selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "old unrelated\n");
    await git(root, ["add", "selected.txt", "unrelated.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    await Deno.writeTextFile(`${root}/selected.txt`, "new selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "staged unrelated\n");
    await git(root, ["add", "unrelated.txt"]);

    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    const status = runner.amendCommit(
      "amended",
      new Map([[`${root}/selected.txt`, "new selected\n"]]),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "new selected\n",
    );
    assertEquals(
      await git(root, ["show", "HEAD:unrelated.txt"]),
      "old unrelated\n",
    );
    assertEquals(
      await git(root, ["show", ":unrelated.txt"]),
      "staged unrelated\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: commits exact pager contents while preserving staged and unstaged edits in the same file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "one\ntwo\nthree\nfour\nfive\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    // Line one is staged. Line five is only in the working tree. The pager
    // edit to line four belongs in HEAD, the index, and the working tree.
    await Deno.writeTextFile(path, "ONE\ntwo\nthree\nfour\nfive\n");
    await git(root, ["add", "selected.txt"]);
    await Deno.writeTextFile(path, "ONE\ntwo\nthree\nFOUR\nFIVE\n");

    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    const status = runner.amendCommit(
      "amended",
      new Map([[path, "one\ntwo\nthree\nFOUR\nfive\n"]]),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "one\ntwo\nthree\nFOUR\nfive\n",
    );
    assertEquals(
      await git(root, ["show", ":selected.txt"]),
      "ONE\ntwo\nthree\nFOUR\nfive\n",
    );
    assertEquals(
      await Deno.readTextFile(path),
      "ONE\ntwo\nthree\nFOUR\nFIVE\n",
    );
    assertEquals(
      await git(root, ["status", "--porcelain"]),
      "MM selected.txt\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: refuses a pager edit that conflicts with a staged edit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "one\ntwo\nthree\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await Deno.writeTextFile(path, "one\nSTAGED\nthree\n");
    await git(root, ["add", "selected.txt"]);

    let error = "";
    try {
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      runner.amendCommit(
        "amended",
        new Map([[path, "one\nPAGER\nthree\n"]]),
        head,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    assert(error.includes("conflict"), error || "the amend did not fail");
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "one\ntwo\nthree\n",
    );
    assertEquals(
      await git(root, ["show", ":selected.txt"]),
      "one\nSTAGED\nthree\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: refuses to merge content into a staged file type change", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "target");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const linkObject =
      (await git(root, ["hash-object", "-w", "--stdin"], "target"))
        .trim();
    await git(root, [
      "update-index",
      "--cacheinfo",
      `120000,${linkObject},selected.txt`,
    ]);
    const stagedBefore = await git(root, [
      "ls-files",
      "--stage",
      "selected.txt",
    ]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "TARGET"]]),
          head,
        ),
      Error,
      "staged file type change",
    );

    assertEquals(runner.headSha(), head);
    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "target");
    assertEquals(
      await git(root, ["ls-files", "--stage", "selected.txt"]),
      stagedBefore,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: merges content through a staged executable mode change", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["update-index", "--chmod=+x", "selected.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "pager\n"]]),
      head,
    );

    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "pager\n");
    assert(
      (await git(root, ["ls-files", "--stage", "selected.txt"])).startsWith(
        "100755 ",
      ),
    );
    assertEquals(await git(root, ["show", ":selected.txt"]), "pager\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: amends a POSIX path containing a literal backslash",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/back\\slash.txt`;
      await Deno.writeTextFile(path, "old\n");
      await git(root, ["add", "--", "back\\slash.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      assertEquals(
        await git(root, ["show", "HEAD:back\\slash.txt"]),
        "pager\n",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: keeps an in-repository symlink's lexical Git path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const link = `${root}/link.txt`;
      const target = `${root}/target.txt`;
      Deno.writeTextFileSync(link, "link head\n");
      Deno.writeTextFileSync(target, "target head\n");
      await git(root, ["add", "link.txt", "target.txt"]);
      await git(root, ["commit", "-q", "-m", "head"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      Deno.removeSync(link);
      Deno.symlinkSync("target.txt", link);

      realGit(root).amendCommit(
        "head",
        new Map([[link, "pager\n"]]),
        head,
      );

      assertEquals(await git(root, ["show", "HEAD:link.txt"]), "pager\n");
      assertEquals(
        await git(root, ["show", "HEAD:target.txt"]),
        "target head\n",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: keeps a symlinked directory's lexical Git path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.mkdir(`${root}/subalias`);
      await Deno.writeTextFile(`${root}/f.txt`, "root head\n");
      await Deno.writeTextFile(`${root}/subalias/f.txt`, "alias head\n");
      await git(root, ["add", "f.txt", "subalias/f.txt"]);
      await git(root, ["commit", "-q", "-m", "head"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      await Deno.remove(`${root}/subalias`, { recursive: true });
      await Deno.symlink(".", `${root}/subalias`);

      realGit(root).amendCommit(
        "head",
        new Map([[`${root}/subalias/f.txt`, "pager\n"]]),
        head,
      );

      assertEquals(await git(root, ["show", "HEAD:subalias/f.txt"]), "pager\n");
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "root head\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: reads and writes selected files through clean filters", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "filter.caps.clean", "tr a-z A-Z"]);
    await git(root, ["config", "filter.caps.smudge", "tr A-Z a-z"]);
    await Deno.writeTextFile(`${root}/.gitattributes`, "*.dat filter=caps\n");
    const path = `${root}/f.dat`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", ".gitattributes", "f.dat"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertEquals(runner.fileAtCommit(head, path), "original\n");
    runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);

    assertEquals(await git(root, ["show", "HEAD:f.dat"]), "PAGER\n");
    assertEquals(await git(root, ["show", ":f.dat"]), "PAGER\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: handles an index path beginning with a stage prefix", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/1:f.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "--", "1:f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
    assertEquals(await git(root, ["show", "HEAD:1:f.txt"]), "pager\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves assume-unchanged and skip-worktree index flags", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/assume.txt`, "old assume\n");
    await Deno.writeTextFile(`${root}/skip.txt`, "old skip\n");
    await git(root, ["add", "assume.txt", "skip.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["update-index", "--assume-unchanged", "assume.txt"]);
    await git(root, ["update-index", "--skip-worktree", "skip.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([
        [`${root}/assume.txt`, "pager assume\n"],
        [`${root}/skip.txt`, "pager skip\n"],
      ]),
      head,
    );
    assert(
      (await git(root, ["ls-files", "-v", "assume.txt"])).startsWith("h "),
    );
    assert((await git(root, ["ls-files", "-t", "skip.txt"])).startsWith("S "));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rejects a commit tree changed by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await installHook(
        root,
        "pre-commit",
        `printf 'hook\\n' > "$GIT_WORK_TREE/f.txt"\ngit add -- f.txt`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("hook changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
      assertEquals(await git(root, ["show", ":f.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rejects a selected working file changed by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await installHook(root, "pre-commit", "printf 'hook\\n' > f.txt");
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () =>
          runner.amendCommit(
            "amended",
            new Map([[path, "pager\n"]]),
            head,
            undefined,
            new Map([[path, "pager\n"]]),
          ),
        Error,
        "changed while commit hooks ran",
      );

      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
      assertEquals(await git(root, ["show", ":f.txt"]), "original\n");
      assertEquals(await Deno.readTextFile(path), "hook\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: a concurrent branch update wins the compare-and-swap",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const concurrent = (await git(
        root,
        ["commit-tree", tree, "-p", head],
        "concurrent\n",
      )).trim();
      assert(concurrent, "created the concurrent commit");
      const branch = (await git(root, ["symbolic-ref", "HEAD"])).trim();
      await installHook(
        root,
        "pre-commit",
        `git --git-dir=${shellQuote(`${root}/.git`)} update-ref ${
          shellQuote(branch)
        } ${shellQuote(concurrent)} ${shellQuote(head)}`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the raced amend failed");
      assertEquals(runner.headSha(), concurrent);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: refuses to overwrite a selected path staged during hooks",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      await installHook(
        root,
        "pre-commit",
        `printf 'concurrent staged\\n' > f.txt\nGIT_INDEX_FILE=${
          shellQuote(`${root}/.git/index`)
        } git add -- f.txt`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(
        error.includes("index changed"),
        error || "the amend did not fail",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", ":f.txt"]), "concurrent staged\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: branch-aware hooks see the branch being amended",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      await installHook(
        root,
        "pre-commit",
        `test "$(git branch --show-current)" = ${shellQuote(branch.slice(11))}`,
      );

      runner.amendCommit("amended", new Map(), head, branch);
      assert(runner.headSha() !== head, "the branch-aware hook allowed amend");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: refuses a different branch at the same commit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const runner = realGit(root);
    const branch = runner.headRef!();
    const head = runner.headSha();
    assert(branch && head, "repository has a branch and HEAD commit");
    await git(root, ["checkout", "-q", "-b", "topic"]);

    assertThrows(
      () => runner.amendCommit("amended", new Map(), head, branch),
      Error,
      "different branch",
    );
    assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
    assertEquals(
      await git(root, ["rev-parse", "refs/heads/topic"]),
      `${head}\n`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: a branch switch during hooks leaves both branches unamended",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await git(root, ["branch", "topic"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      await installHook(root, "pre-commit", "git checkout -q topic");

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the branch-switching amend failed");
      assertEquals(runner.headRef!(), "refs/heads/topic");
      assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${head}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rolls back a nested commit made by a post-commit hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      const marker = `${root}/.git/nested-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
fi`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("HEAD changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
      assertEquals(
        (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
        "1",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: rollback preserves a concurrent update to the original branch",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await git(root, ["branch", "topic"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const concurrent = (await git(
        root,
        ["commit-tree", tree, "-p", head],
        "concurrent\n",
      )).trim();
      await installHook(
        root,
        "pre-commit",
        `git --git-dir=${shellQuote(`${root}/.git`)} update-ref ${
          shellQuote(branch)
        } ${shellQuote(concurrent)} ${shellQuote(head)}\ngit checkout -q topic`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the raced amend failed");
      assertEquals(await git(root, ["rev-parse", branch]), `${concurrent}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${head}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: reflog ownership distinguishes a hook's replacement commit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "base\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "base"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["commit", "-qam", "original"]);
      await git(root, ["branch", "topic"]);

      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const parent = (await git(root, ["rev-parse", `${head}^`])).trim();
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const authorName = (await git(root, [
        "show",
        "-s",
        "--format=%an",
        head,
      ])).trim();
      const authorEmail = (await git(root, [
        "show",
        "-s",
        "--format=%ae",
        head,
      ])).trim();
      const authorDate = (await git(root, [
        "show",
        "-s",
        "--format=%aI",
        head,
      ])).trim();
      const replacement = (await git(
        root,
        ["commit-tree", tree, "-p", parent],
        "amended\n",
        {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_AUTHOR_DATE: authorDate,
          GIT_COMMITTER_DATE: "2001-01-01T00:00:00+00:00",
        },
      )).trim();
      assert(replacement !== head, "the hook replacement is a new commit");
      await installHook(
        root,
        "post-commit",
        `git update-ref refs/heads/topic ${shellQuote(replacement)} ${
          shellQuote(head)
        }\ngit checkout -q topic`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the branch-switching amend failed");
      assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${replacement}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rejects a commit message rewritten by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      await installHook(
        root,
        "commit-msg",
        `printf '\\nHook-Trailer: added\\n' >> "$1"`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("hook changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: Git refuses amend while resolving a conflicted merge", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "base\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    await git(root, ["checkout", "-q", "-b", "side"]);
    await Deno.writeTextFile(`${root}/f.txt`, "side\n");
    await git(root, ["commit", "-qam", "side"]);
    await git(root, ["checkout", "-q", "-"]);
    await Deno.writeTextFile(`${root}/f.txt`, "main\n");
    await git(root, ["commit", "-qam", "main"]);
    await git(root, ["merge", "side"]);
    await Deno.stat(`${root}/.git/MERGE_HEAD`);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.amendCommit("amended", new Map(), head),
      Error,
      "middle of a merge",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: headSha is null outside a repository", () => {
  const root = Deno.makeTempDirSync();
  try {
    assertEquals(realGit(root).headSha(), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: amendCommit throws when git fails (not a repository)", () => {
  const root = Deno.makeTempDirSync();
  try {
    let threw = false;
    try {
      realGit(root).amendCommit("x", new Map(), "0000000");
    } catch {
      threw = true;
    }
    assert(threw, "amend outside a repo throws");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: headSha is null when git cannot run (bad cwd)", () => {
  // A cwd that does not exist makes the git subprocess fail to launch; the
  // runner catches it and reports no HEAD rather than throwing.
  assertEquals(realGit("/no/such/directory/really").headSha(), null);
});

Deno.test("realGit: validates selected paths before reading commit contents", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/tracked.txt`, "tracked\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await Deno.writeTextFile(`${outside}/outside.txt`, "outside\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.fileAtCommit(head, "tracked.txt"),
      Error,
      "not absolute",
    );
    assertThrows(
      () => runner.fileAtCommit(head, `${outside}/outside.txt`),
      Error,
      "outside the repository",
    );
    assertEquals(runner.fileAtCommit(head, `${root}/missing.txt`), null);

    if (Deno.build.os !== "windows") {
      await Deno.symlink(outside, `${root}/escape`);
      assertThrows(
        () => runner.fileAtCommit(head, `${root}/escape/outside.txt`),
        Error,
        "outside the repository",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("realGit: reports unavailable optional Git queries", () => {
  const root = Deno.makeTempDirSync();
  try {
    const runner = realGit(root);

    assertEquals(runner.headRef!(), null);
    assertEquals(runner.resolveCommit!("not-an-object"), null);
    assertEquals(runner.resolveCommit!("abcd"), null);
    assertEquals(
      runner.commitMatchesDiff!("abcd", "old", "new", "bad", "cafe"),
      false,
    );
    assertEquals(
      runner.commitMatchesDiff!("abcd", "old", "new", "beef", "cafe"),
      false,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: rejects a stale expected HEAD", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.amendCommit("amended", new Map(), "0".repeat(head.length)),
      Error,
      "HEAD moved before",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves a selected path staged for deletion", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["rm", "-q", "--cached", "selected.txt"]);
    await Deno.writeTextFile(path, "workspace\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "committed by pager\n"]]),
      head,
    );

    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "committed by pager\n",
    );
    assertEquals(
      await git(root, ["ls-files", "--stage", "--", "selected.txt"]),
      "",
    );
    assertEquals(await Deno.readTextFile(path), "workspace\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: rejects both multi-stage and lone unmerged index entries", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const object = (await git(root, ["rev-parse", "HEAD:selected.txt"])).trim();
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head && object, "repository has a committed file");

    await git(root, ["update-index", "--force-remove", "selected.txt"]);
    await git(
      root,
      ["update-index", "--index-info"],
      `100644 ${object} 1\tselected.txt\n100644 ${object} 2\tselected.txt\n`,
    );
    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "unmerged entries",
    );

    await git(root, ["update-index", "--force-remove", "selected.txt"]);
    await git(
      root,
      ["update-index", "--index-info"],
      `100644 ${object} 1\tselected.txt\n`,
    );
    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "unmerged entry",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: rejects a selected path that HEAD does not contain", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const path = `${root}/new.txt`;
    await Deno.writeTextFile(path, "workspace\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "does not contain new.txt",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: a no-op pager change keeps the committed contents", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);

    assertEquals(
      runner.applyFileChanges(
        "committed\n",
        "workspace\n",
        "workspace\n",
        `${root}/f.txt`,
      ),
      "committed\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: fallback merge handles insertions around added and empty content", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);
    const path = `${root}/selected.txt`;

    assertEquals(
      runner.applyFileChanges(
        "A\nB\nC\n",
        "A\nX\nB\nC\n",
        "P\nA\nQ\nX\nR\nB\nC\n",
        path,
      ),
      "P\nA\nQ\nR\nB\nC\n",
    );
    assertEquals(
      runner.applyFileChanges("", "X\n", "P\nX\nQ\n", path),
      "P\nQ",
    );
    assertEquals(
      runner.applyFileChanges("\n", "\nX\n", "P\n\nX\nQ\n", path),
      "P\n\nQ\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: fallback merge rejects a deletion inside a pager replacement", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);

    assertThrows(
      () =>
        realGit(root).applyFileChanges(
          "A\nB\nC\nD\n",
          "A\nD\n",
          "P\n",
          `${root}/selected.txt`,
        ),
      Error,
      "overlap workspace changes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves a staged version that already matches the pager", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await Deno.writeTextFile(path, "pager\n");
    await git(root, ["add", "selected.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "pager\n"]]),
      head,
    );

    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "pager\n");
    assertEquals(await git(root, ["show", ":selected.txt"]), "pager\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: recovers amend ownership from file and reftable reflogs",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        const marker = `${root}/fallback-hook-ran`;
        await installHook(
          root,
          "reference-transaction",
          `if test "\${1-}" = committed; then
  journal="$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  rm -f "$journal" || exit 1
  test ! -e "$journal" || exit 1
  printf ran > ${shellQuote(marker)}
fi`,
        );
        const runner = realGit(root);
        const head = runner.headSha();
        assert(head, `${storage} repository has a HEAD commit`);

        const result = runner.amendCommit("amended", new Map(), head);

        assert(result.head !== head, `${storage} HEAD was amended`);
        assertEquals(await Deno.readTextFile(marker), "ran");
        assertEquals(
          (await git(root, ["log", "-1", "--format=%s"])).trim(),
          "amended",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: ignores a journal transition to a missing commit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  read old object ref
  if test "$old" != 0000000000000000000000000000000000000000 && test "$object" != 0000000000000000000000000000000000000000; then
    printf '%s %s %s\n' "$old" ffffffffffffffffffffffffffffffffffffffff "$ref" > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  fi
fi`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      const result = runner.amendCommit("amended", new Map(), head);

      assert(result.head !== head, "the commit summary recovered ownership");
      assertEquals(runner.headSha(), result.head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rejects two journal claims for the amended commit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  read old object ref
  if test "$old" != 0000000000000000000000000000000000000000 && test "$object" != 0000000000000000000000000000000000000000; then
    printf '%s %s %s\n%s %s %s\n' "$old" "$object" refs/heads/claim-a "$old" "$object" refs/heads/claim-b > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  fi
fi`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "more than one possible amended commit",
      );
      assert(
        runner.headSha() !== head,
        "ambiguous ownership leaves the new ref untouched",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: reports when a hook restores the old ref before ownership is established",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  rm -f "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
fi`,
      );
      await installHook(
        root,
        "post-commit",
        `git update-ref ${shellQuote(branch)} ${shellQuote(head)}`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "did not publish the amended commit",
      );
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: follows a marked journal chain when rolling back nested commits",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const marker = `${root}/nested-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  : > ${shellQuote(marker)}
  amended=$(git rev-parse HEAD)
  git commit --allow-empty -q -m nested
  printf '%s %s %s\n' ${shellQuote(head)} "$amended" ${
          shellQuote(branch)
        } > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
fi`,
      );

      const error = assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "HEAD changed during the amend",
      );
      assert(!error.message.includes("rollback failed"), error.message);
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: uses the commit summary when hook journals and reflogs are gone",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const journalMarker = `${root}/journal-removed`;
      const reflogMarker = `${root}/reflogs-removed`;
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  journal="$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  rm -f "$journal" || exit 1
  test ! -e "$journal" || exit 1
  printf ran > ${shellQuote(journalMarker)}
fi`,
      );
      await installHook(
        root,
        "post-commit",
        `git reflog expire --expire=now --all || exit 1
test -z "$(git reflog show --all)" || exit 1
printf ran > ${shellQuote(reflogMarker)}`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      const result = runner.amendCommit("amended", new Map(), head);

      assert(result.head !== head, "the summary identified the amended commit");
      assertEquals(await Deno.readTextFile(journalMarker), "ran");
      assertEquals(await Deno.readTextFile(reflogMarker), "ran");
      assertEquals((await git(root, ["reflog", "show", "--all"])).trim(), "");
      assertEquals(runner.headSha(), result.head);
      assertEquals(
        (await git(root, ["log", "-1", "--format=%s"])).trim(),
        "amended",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: rolls back when a selected workspace file disappears in a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/selected.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "selected.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await Deno.writeTextFile(path, "pager\n");
      await installHook(root, "post-commit", `rm -f ${shellQuote(path)}`);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () =>
          runner.amendCommit(
            "amended",
            new Map([[path, "pager\n"]]),
            head,
            undefined,
            new Map([[path, "pager\n"]]),
          ),
        Error,
        "could not be read after commit hooks ran",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(
        await git(root, ["show", "HEAD:selected.txt"]),
        "original\n",
      );
      assertEquals(await git(root, ["show", ":selected.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: reports a reference lock created after Git publishes the amend",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const refPath = (await git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        branch,
      ])).trim();
      const lock = `${refPath}.lock`;
      await installHook(root, "post-commit", `: > ${shellQuote(lock)}`);

      const error = assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "reference is locked",
      );
      assert(error.message.includes("rollback failed"), error.message);
      assert(runner.headSha() !== head, "the lock also prevented rollback");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rolls back when the real index is locked after hooks",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/selected.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "selected.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const lock = `${root}/.git/index.lock`;
      await installHook(root, "post-commit", `: > ${shellQuote(lock)}`);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () =>
          runner.amendCommit(
            "amended",
            new Map([[path, "pager\n"]]),
            head,
          ),
        Error,
        "index is locked",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(
        await git(root, ["show", "HEAD:selected.txt"]),
        "original\n",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: surfaces malformed repository and tree responses from Git",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/tracked.txt`;
      await Deno.writeTextFile(path, "tracked\n");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();

      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --show-toplevel; then
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "repository root is unavailable",
          ),
      );
      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --show-toplevel; then
  printf '%s\\n' /definitely/missing/cf-view-root
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "outside the repository",
          ),
      );
      assertThrows(
        () => realGit(root).fileAtCommit(head, `${root}/missing/child.txt`),
        Error,
      );
      await withGitShim(
        `if test "$1" = --literal-pathspecs && test "$2" = ls-tree; then
  printf '100644 blob aaaa\\ttracked.txt\\000100644 blob bbbb\\ttracked.txt\\000'
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "more than one entry",
          ),
      );
      await withGitShim(
        `if test "$1" = --literal-pathspecs && test "$2" = ls-tree; then
  printf 'malformed\\000'
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "tree entry is invalid",
          ),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: reports failures and malformed output from merge helpers",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      const path = `${root}/selected.txt`;
      await withGitShim(
        `if test "$1" = merge-file; then
  printf '%s\\n' 'forced merge failure' >&2
  exit 128
fi`,
        () =>
          assertThrows(
            () => realGit(root).applyFileChanges("A\n", "B\n", "C\n", path),
            Error,
            "forced merge failure",
          ),
      );
      await withGitShim(
        `if test "$1" = diff; then
  printf '%s\\n' 'forced diff failure' >&2
  exit 2
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).applyFileChanges(
                "A\nB\nC\nD\n",
                "A\nD\n",
                "P\n",
                path,
              ),
            Error,
            "forced diff failure",
          ),
      );
      await withGitShim(
        `if test "$1" = diff; then
  printf '@@ -1,2 +1,2 @@\\n-old\\n+new\\n'
  exit 1
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).applyFileChanges(
                "A\nB\nC\nD\n",
                "A\nD\n",
                "P\n",
                path,
              ),
            Error,
            "Could not parse pager edits",
          ),
      );
      const calls = `${root}/diff-calls`;
      await withGitShim(
        `if test "$1" = diff; then
  if test ! -e ${shellQuote(calls)}; then
    : > ${shellQuote(calls)}
    exit 0
  fi
  printf '@@ -1 +1 @@\\n-A\\n+P\\n'
  exit 1
fi`,
        () =>
          assertThrows(
            () => realGit(root).applyFileChanges("X\n", "A\n", "P\n", path),
            Error,
            "overlap committed changes",
          ),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: reports injected ref-storage, hook setup, and staged merge failures",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/selected.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "selected.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();

      await withGitShim(
        `if test "$1" = config && test "$2" = --get && test "$3" = extensions.refStorage; then
  printf '%s\\n' future-format
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).amendCommit("amended", new Map(), head),
            Error,
            "cannot be amended safely",
          ),
      );
      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --path-format=absolute && test "$3" = --absolute-git-dir; then
  printf '%s\\n' 'forced hook setup failure' >&2
  exit 1
fi`,
        () =>
          assertThrows(
            () => realGit(root).amendCommit("amended", new Map(), head),
            Error,
            "Could not prepare Git hooks",
          ),
      );

      await Deno.writeTextFile(path, "staged\n");
      await git(root, ["add", "selected.txt"]);
      await withGitShim(
        `if test "$1" = merge-file; then
  printf '%s\\n' 'forced staged merge failure' >&2
  exit 128
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).amendCommit(
                "amended",
                new Map([[path, "pager\n"]]),
                head,
              ),
            Error,
            "forced staged merge failure",
          ),
      );
      assertEquals((await git(root, ["rev-parse", "HEAD"])).trim(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
