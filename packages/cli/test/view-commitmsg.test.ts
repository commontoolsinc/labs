import { assert, assertEquals } from "@std/assert";
import {
  extractMessage,
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

Deno.test("findCommitMessages: a commit with no message body yields no region", () => {
  const lines = ["commit deadbeef", "Author: A", "", "diff --git a/f b/f"];
  assertEquals(findCommitMessages(lines).length, 0);
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

Deno.test("sameCommit: matches on the shorter (abbreviated) prefix, refuses too-short", () => {
  assert(sameCommit("0123456", "0123456789abcdef"), "7-char abbrev matches");
  assert(sameCommit("0123456789abcdef", "0123456"), "either side may be short");
  assert(!sameCommit("0123456", "0123999"), "different prefix");
  assert(!sameCommit("012", "0123456"), "under seven chars never matches");
});

// --- realGit against a throwaway repository -----------------------------------

async function git(
  root: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: root,
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

    const status = g.amendMessage("new subject\n\nnew body");
    assert(status.includes("Amended"), status);
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

Deno.test("realGit: headSha is null outside a repository", () => {
  const root = Deno.makeTempDirSync();
  try {
    assertEquals(realGit(root).headSha(), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: amendMessage throws when git fails (not a repository)", () => {
  const root = Deno.makeTempDirSync();
  try {
    let threw = false;
    try {
      realGit(root).amendMessage("x");
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
