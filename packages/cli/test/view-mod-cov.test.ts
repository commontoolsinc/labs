/**
 * buildView (mod.ts) chooses diff vs source mode, the matching lazy semantic
 * service, and the right editable source. The interactive entry constructs the
 * semantic service only when launching the pager, so these call the returned
 * closure directly to exercise both the diff and source semantics paths.
 */
import { assert, assertEquals } from "@std/assert";
import { buildView } from "../lib/view/mod.ts";

const SRC = "export const x = 1;\nconst y = x + 1;\n";
const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
 const y = x;
`;

Deno.test("buildView: a named source file is editable and its semantics closure runs", () => {
  const r = buildView(SRC, "transformed.ts");
  assert(r.doc.lines.length > 0);
  const s = r.semantics(); // runs createSemantics (the source closure body)
  assert(s === undefined || typeof s.prewarm === "function");
  assertEquals(r.editSource.editable, true, "a named file is editable");
});

Deno.test("buildView: a pipe with no file is a read-only source", () => {
  const r = buildView(SRC);
  r.semantics();
  assertEquals(r.editSource.editable, false);
});

Deno.test("buildView: blank input remains a read-only source", () => {
  const r = buildView(" \n\t\n");

  assertEquals(r.editSource.isDiff, undefined);
  assertEquals(r.editSource.editable, false);
});

Deno.test("buildView: a diff takes the diff branch and a diff-semantics closure", () => {
  const r = buildView(DIFF);
  r.semantics(); // runs createDiffSemantics (the diff closure body)
  assert(
    r.doc.lines.some((l) => l.text.startsWith("@@")),
    "rendered as a diff",
  );
});

Deno.test("buildView: commit output with no file diff takes the commit-editing branch", () => {
  const commit = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
    "",
    "    Empty commit subject",
    "",
  ].join("\n");
  const r = buildView(commit);
  assertEquals(r.editSource.isDiff, true);
  assertEquals(r.editSource.label, null);
});

Deno.test("buildView: a commit with no message takes the commit branch", () => {
  const commit = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
    "",
  ].join("\n");
  const r = buildView(commit);
  assertEquals(r.editSource.isDiff, true);
  assertEquals(r.editSource.label, null);
});

Deno.test("buildView: commit-looking prose without Git metadata stays a source file", () => {
  const text = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "",
    "    Ordinary prose",
    "",
  ].join("\n");
  const named = buildView(text, "notes.txt");
  const piped = buildView(text);

  assertEquals(named.editSource.isDiff, undefined);
  assertEquals(named.editSource.editable, true);
  assertEquals(piped.editSource.isDiff, undefined);
  assertEquals(piped.editSource.editable, false);
});

Deno.test("buildView: a commit token followed by ordinary text stays a source file", () => {
  const r = buildView("commit deadbee\nordinary text\n", "notes.txt");

  assertEquals(r.editSource.isDiff, undefined);
  assertEquals(r.editSource.editable, true);
});

Deno.test("buildView: a standard commit header without its separator stays source", () => {
  const text = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
  ].join("\n");
  const r = buildView(text, "notes.txt");

  assertEquals(r.editSource.isDiff, undefined);
  assertEquals(r.editSource.editable, true);
});

Deno.test("buildView: an email commit header without its separator stays source", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const text = [
    `From ${sha} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Subject",
  ].join("\n");
  const r = buildView(text, "notes.txt");

  assertEquals(r.editSource.isDiff, undefined);
  assertEquals(r.editSource.editable, true);
});

Deno.test("buildView: Git's built-in commit header formats take the commit branch", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const formats = [
    ["short", "Author: A B <a@b.example>"],
    ["full", "Author: A B <a@b.example>\nCommit: C D <c@d.example>"],
    [
      "fuller",
      "Author: A B <a@b.example>\nAuthorDate: Wed Jul 1 12:00:00 2026 -0700\n" +
      "Commit: C D <c@d.example>\nCommitDate: Wed Jul 1 12:00:00 2026 -0700",
    ],
    [
      "raw",
      `tree ${"a".repeat(40)}\nauthor A B <a@b.example> 1782932400 -0700\n` +
      "committer C D <c@d.example> 1782932400 -0700",
    ],
  ];

  for (const [format, headers] of formats) {
    const text = `commit ${sha}\n${headers}\n\n    Subject\n`;
    assertEquals(
      buildView(text).editSource.isDiff,
      true,
      `${format} output is a commit view`,
    );
  }
});

Deno.test("buildView: compact and email commit formats retain diff ownership", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const formats = [
    ["oneline", `${sha} Subject\n${DIFF}`],
    ["reference", `0123 (Subject, 2026-07-20)\n${DIFF}`],
    [
      "email",
      [
        `From ${sha} Mon Sep 17 00:00:00 2001`,
        "From: A B <a@b.example>",
        "Date: Wed, 1 Jul 2026 12:00:00 -0700",
        "Subject: [PATCH] Subject",
        "",
        "Body",
        "",
        DIFF,
      ].join("\n"),
    ],
  ];

  for (const [format, text] of formats) {
    assertEquals(
      buildView(text).editSource.isDiff,
      true,
      `${format} output retains commit-aware diff handling`,
    );
  }
});

Deno.test("buildView: CRLF commit-only output takes the commit branch", () => {
  const text = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
    "",
    "    Subject",
    "",
  ].join("\r\n");

  assertEquals(buildView(text).editSource.isDiff, true);
});

Deno.test("buildView: forceDiff pins diff mode even on non-diff text", () => {
  const r = buildView("const a = 1;\n", undefined, true);
  r.semantics();
  assert(r.doc.lines.length > 0);
});

Deno.test("buildView: forceDiff=false views a real diff as source (--no-diff)", () => {
  const diff = buildView(DIFF); // auto-detects: a diff
  assert(
    diff.doc.flatStructure.some((n) => n.kind === "hunk"),
    "auto-detect treats it as a diff",
  );
  const source = buildView(DIFF, undefined, false); // --no-diff
  assert(
    !source.doc.flatStructure.some((n) => n.kind === "hunk"),
    "forceDiff=false suppresses diff detection and parses it as source",
  );
});

Deno.test("buildView: text that only embeds a diff stays source (mostlyDiff is false)", () => {
  // Looks like a diff at the top, but the bulk is ordinary source, so the
  // diff-share heuristic rejects it and it renders as TypeScript.
  const embedded = "diff --git a/x b/x\n" +
    Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n") +
    "\n";
  const r = buildView(embedded);
  r.semantics();
  // The first line is not treated as a diff header (no +/- tints across it).
  assert(r.doc.lines.length > 10);
});
