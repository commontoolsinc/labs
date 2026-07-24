/**
 * The jump list (`i`): a dialog over a diff view listing the files it touches
 * and any commit messages it carries, with Enter jumping the viewport to the
 * chosen one. A read-only diff (its files do not resolve on disk) is enough —
 * the list is derived from the diff text itself.
 */
import { assert, assertEquals } from "@std/assert";
import { Session } from "../lib/view/session.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { parseDocument } from "../lib/view/parse.ts";

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

function type(s: Session, text: string): void {
  for (const ch of text) s.handleKey({ name: ch, char: ch });
}

/** A diff session over `diffText` whose files do not resolve on disk (read-only,
 * but still a diff, so the jump list is offered). */
function diffSession(diffText: string, height = 20): Session {
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
}

function entryText(s: Session): string[] {
  return s.view().overlay?.lines.map((l) => l.text) ?? [];
}

const TWO_FILES = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "index 3333333..4444444 100644",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+added",
  "",
].join("\n");

// A `git show` of a single commit: the header, its indented message, then the
// diff. app.ts's header is line 6, its test file's line 14.
const SHOW = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: Someone <someone@example.com>",
  "Date:   Mon Jul 21 12:00:00 2026 +0000",
  "",
  "    Fix the widget alignment",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "index 3333333..4444444 100644",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1 +1,2 @@",
  " x",
  "+added",
  "",
].join("\n");

Deno.test("jumplist: i lists the diff's files, dirs summarised", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i");
  assertEquals(entryText(s), [
    "▸ src/app.ts  +1 −1",
    "▸ src/app.test.ts  +1 −0",
  ]);
  assertEquals(s.view().inputLine, "jump to: ");
  assertEquals(s.view().overlay?.title, "Jump to file or commit");
  assertEquals(s.view().overlay?.selectedLine, 0);
});

Deno.test("jumplist: a git show lists the commit message before its files", () => {
  const s = diffSession(SHOW);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit 012345678  Fix the widget alignment",
    "▸ src/app.ts  +1 −1",
    "▸ src/app.test.ts  +1 −0",
  ]);
});

Deno.test("jumplist: enter on a file jumps the viewport to its header line", () => {
  // A short viewport, so the last file's header can reach the very top.
  const s = diffSession(SHOW, 6);
  press(s, "i");
  press(s, "down", "down"); // commit -> app.ts -> app.test.ts
  assertEquals(s.view().overlay?.selectedLine, 2);
  press(s, "enter");
  assertEquals(s.view().overlay, null, "list closed");
  assertEquals(s.view().top, 14, "app.test.ts header is line 14");
  assert(s.view().message.includes("src/app.test.ts"));
});

Deno.test("jumplist: enter on the commit entry jumps to the commit header", () => {
  const s = diffSession(SHOW, 8);
  press(s, "G"); // scroll to the bottom, away from the commit
  assert(s.view().top > 0);
  press(s, "i");
  press(s, "up", "up", "up", "up"); // climb back to the commit entry (index 0)
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "enter");
  assertEquals(s.view().top, 0, "the commit header is line 0");
  assert(s.view().message.includes("commit 012345678"));
});

Deno.test("jumplist: pagedown and pageup jump the selection to the ends", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(s.view().overlay?.selectedLine, 0);
  press(s, "pagedown");
  assertEquals(s.view().overlay?.selectedLine, 3, "clamped to the last entry");
  press(s, "pageup");
  assertEquals(s.view().overlay?.selectedLine, 0, "clamped to the first entry");
});

Deno.test("jumplist: tab jumps the same as enter", () => {
  const s = diffSession(SHOW, 6);
  press(s, "i", "down"); // preselected commit -> src/app.ts
  press(s, "tab");
  assertEquals(s.view().overlay, null, "list closed");
  assertEquals(s.view().message, "Jumped to src/app.ts");
});

Deno.test("jumplist: typing filters the list", () => {
  const s = diffSession(SHOW);
  press(s, "i");
  type(s, "test");
  assertEquals(entryText(s), ["▸ src/app.test.ts  +1 −0"]);
  assertEquals(s.view().inputLine, "jump to: test");
  // Backspacing widens it again.
  press(s, "backspace", "backspace", "backspace", "backspace");
  assertEquals(entryText(s).length, 3);
});

Deno.test("jumplist: a filter matching the commit subject keeps the commit", () => {
  const s = diffSession(SHOW);
  press(s, "i");
  type(s, "widget");
  assertEquals(entryText(s), ["● commit 012345678  Fix the widget alignment"]);
});

Deno.test("jumplist: enter with no match leaves the list open", () => {
  const s = diffSession(SHOW);
  press(s, "down", "down"); // scroll off the top so "unmoved" is meaningful
  const top = s.view().top;
  assert(top > 0);
  press(s, "i");
  type(s, "zzz");
  assertEquals(entryText(s), ["(no matches)"]);
  press(s, "enter");
  assert(s.view().overlay !== null, "still open");
  assertEquals(s.view().top, top, "viewport unmoved");
});

Deno.test("jumplist: escape cancels and leaves the viewport put", () => {
  const s = diffSession(SHOW);
  press(s, "down"); // move the viewport off line 0
  const top = s.view().top;
  press(s, "i", "down", "down"); // open and move the selection
  press(s, "escape");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
  assertEquals(s.view().top, top, "the view did not move");
});

Deno.test("jumplist: opening preselects the file the viewport is on", () => {
  const s = diffSession(SHOW, 6);
  // Put app.test.ts's header (line 14) at the top of the viewport.
  press(s, "i", "down", "down", "enter");
  assertEquals(s.view().top, 14);
  press(s, "i");
  assertEquals(
    s.view().overlay?.selectedLine,
    2,
    "reopening lands on app.test.ts",
  );
});

// A `git log -p` of two commits, newest first, each with its own file.
const LOG = [
  "commit a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "Author: A <a@example.com>",
  "Date:   Mon Jul 21 13:00:00 2026 +0000",
  "",
  "    Second change",
  "",
  "diff --git a/b.ts b/b.ts",
  "index 3333333..4444444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-p",
  "+q",
  "commit b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "Author: B <b@example.com>",
  "Date:   Mon Jul 21 12:00:00 2026 +0000",
  "",
  "    First change",
  "",
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n");

Deno.test("jumplist: git log -p interleaves each commit with its own files", () => {
  const s = diffSession(LOG);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit a1a1a1a1a  Second change",
    "▸ b.ts  +1 −1",
    "● commit b2b2b2b2b  First change",
    "▸ a.ts  +1 −1",
  ]);
});

Deno.test("jumplist: files stay listed and jumpable while collapsed", () => {
  const s = diffSession(SHOW, 6);
  press(s, "F"); // collapse every file to a summary line
  press(s, "i");
  assertEquals(entryText(s).length, 3, "commit and both files still listed");
  press(s, "down", "down", "enter"); // commit -> app.ts -> app.test.ts
  assert(s.view().message.includes("src/app.test.ts"));
  // The jump scrolls the collapsed file's summary row into the viewport.
  const rows = s.displayDoc().lines.map((l) => l.text);
  const summaryRow = rows.findIndex((t) => t.startsWith("▸ src/app.test.ts"));
  const top = s.view().top;
  assert(
    summaryRow >= top && summaryRow < top + 5,
    `summary row ${summaryRow} visible in [${top}, ${top + 5})`,
  );
});

Deno.test("jumplist: i on a non-diff view says it is diff-only", () => {
  const doc = parseDocument("const a = 1;\n", "a.ts");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
  );
  press(s, "i");
  assertEquals(s.view().overlay, null);
  assert(s.view().message.includes("only available in a diff view"));
});

// `git format-patch` output: an email envelope whose subject sits on the
// `Subject:` header rather than an indented body.
const EMAIL = [
  "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
  "From: Someone <someone@example.com>",
  "Date: Mon, 21 Jul 2026 12:00:00 +0000",
  "Subject: [PATCH] Fix the widget alignment",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "",
].join("\n");

Deno.test("jumplist: an email patch shows and filters by its Subject", () => {
  const s = diffSession(EMAIL);
  press(s, "i");
  assertEquals(entryText(s), [
    "● commit 012345678  Fix the widget alignment",
    "▸ src/app.ts  +1 −1",
  ]);
  // The subject (with its [PATCH] prefix stripped) is filterable.
  type(s, "widget");
  assertEquals(entryText(s), ["● commit 012345678  Fix the widget alignment"]);
});

Deno.test("jumplist: a plain diff with no commit lists only files", () => {
  const s = diffSession(TWO_FILES);
  press(s, "i");
  assert(
    entryText(s).every((t) => t.startsWith("▸")),
    "no commit entry without a commit header",
  );
});
