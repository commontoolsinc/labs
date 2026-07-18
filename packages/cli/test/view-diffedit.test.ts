/**
 * Editing a diff: the new side of a verified hunk is editable in place, the
 * diff marker and removed/structural lines are protected, line count is locked,
 * and saving splices the edited lines back into the underlying files. A diff
 * matching no file on disk is read-only.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";
import type { GitRunner } from "../lib/view/commitmsg.ts";
import { Session } from "../lib/view/session.ts";
import { promptText } from "./view-helpers.ts";

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

/** Enter edit mode if needed and move the cursor down to the given diff line. */
function toLine(s: Session, line: number): void {
  if (!s.view().cursor) press(s, "e"); // enter edit mode at the top
  let guard = 0;
  while ((s.view().cursor?.line ?? -1) < line && guard++ < 1000) {
    press(s, "down");
  }
}

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
const extra = answer + 1;
`;

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
+const extra = answer + 1;
`;
// Diff line indices: 5,6,7 = context (new lines 0,1,2); 8 = removed;
// 9,10 = additions (new lines 3,4).

function tempWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  return { root, ws, done: () => Deno.removeSync(root, { recursive: true }) };
}

function diffSession(ws: DiffWorkspace, height = 20): Session {
  return diffSessionFrom(ws, DIFF, height);
}

function diffSessionFrom(
  ws: DiffWorkspace,
  diffText: string,
  height = 20,
  git?: GitRunner,
): Session {
  const model = parseDiff(diffText)!;
  const { doc, edit } = buildDiffDocument(diffText, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit, undefined, git),
  );
}

const SHOW_SHA = "0123456789abcdef0123456789abcdef01234567";

// `git show` output: a commit header and message precede the diff. The message
// lines are indented four spaces (git indents blank message lines to four
// spaces too), so they read like context lines, but they belong to no hunk.
const GIT_SHOW = [
  `commit ${SHOW_SHA}`,
  "Author: A B <a@b.example>",
  "Date:   Wed Jul 1 12:00:00 2026 -0700",
  "",
  "    Subject line of the commit",
  "    ",
  "    A body paragraph of the message.",
  "",
  "diff --git a/m.ts b/m.ts",
  "index 0000000..1111111 100644",
  "--- a/m.ts",
  "+++ b/m.ts",
  "@@ -1,4 +1,5 @@ export function double",
  " export function double(n: number): number {",
  "     return n * 2;",
  " }",
  "-export const answer = 42;",
  "+export const answer = double(21);",
  "+const extra = answer + 1;",
  "",
].join("\n");
// Line indices: 4 = subject, 5 = blank message line, 6 = body; 13 = a hunk
// context line (editable); 16 = removed; 17,18 = additions.

/** A fake git runner recording the message an amend would write. */
function fakeGit(head: string | null): {
  git: GitRunner;
  amended: () => string | null;
} {
  let amended: string | null = null;
  return {
    git: {
      headSha: () => head,
      amendMessage: (m) => {
        amended = m;
        return "Amended the commit message";
      },
    },
    amended: () => amended,
  };
}

/** A fake git whose HEAD "moves": the first `headSha()` (the source caches it
 * for editability) returns `first`; the fresh re-check at amend returns
 * `later`. */
function movingGit(first: string, later: string): {
  git: GitRunner;
  amended: () => string | null;
} {
  let calls = 0;
  let amended: string | null = null;
  return {
    git: {
      headSha: () => (++calls === 1 ? first : later),
      amendMessage: (m) => {
        amended = m;
        return "Amended the commit message";
      },
    },
    amended: () => amended,
  };
}

Deno.test("diffedit: edits an added line in place and saves it to the file", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // the "+export const answer = double(21);" line
    press(s, "end");
    type(s, " // ok");
    // Live re-highlight: the document reflects the edit immediately.
    assert(
      s.doc.lines[9].text.endsWith("double(21); // ok"),
      `live text: ${s.doc.lines[9].text}`,
    );
    press(s, "f3");
    assert(s.view().message.startsWith("Saved"), s.view().message);
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[3], "export const answer = double(21); // ok");
    // Untouched lines are preserved, including the trailing newline.
    assertEquals(onDisk[0], "export function double(n: number): number {");
    assertEquals(onDisk[4], "const extra = answer + 1;");
    assertEquals(onDisk[5], "");
  } finally {
    done();
  }
});

Deno.test("diffedit: a context line is editable and writes its file line", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // the "     return n * 2;" context line (new line 1)
    press(s, "end");
    type(s, " // c");
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[1], "    return n * 2; // c");
  } finally {
    done();
  }
});

Deno.test("diffedit: the incremental highlighter recolours only edited lines", () => {
  const { ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    const hl = createDiffHighlighter(DIFF, doc.lines);
    // Edit the first context line's content (diff line 5), past its marker.
    const raw = DIFF.split("\n");
    raw[5] = raw[5].slice(0, 1) + "X" + raw[5].slice(1);
    const out = hl.update(raw.join("\n"));
    assertEquals(out[5].text, raw[5], "edited line reflects the new text");
    // Every other line — the file/hunk headers especially — is byte-identical
    // to the seed, so nothing reflows or flickers colour between keystrokes.
    for (let i = 0; i < doc.lines.length; i++) {
      if (i === 5) continue;
      assertEquals(
        JSON.stringify(out[i]),
        JSON.stringify(doc.lines[i]),
        `line ${i} should be untouched`,
      );
    }
  } finally {
    done();
  }
});

Deno.test("diffedit: editing a context line shows it as a removed/added pair", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // the "     return n * 2;" context line
    press(s, "end");
    type(s, "X");
    const lines = s.doc.text.split("\n");
    assertEquals(lines[6], "-    return n * 2;", "original shown as removed");
    assertEquals(lines[7], "+    return n * 2;X", "the edit shown as added");
    assertEquals(s.view().cursor?.line, 7, "cursor on the added line");
    // A context line and a -/+ pair are both one old + one new line, so the
    // hunk header's counts are unchanged and the diff stays well-formed.
    assertEquals(lines[4], "@@ -1,4 +1,5 @@ export function double");
    press(s, "f3"); // and saving writes the edited new side
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[1], "    return n * 2;X");
  } finally {
    done();
  }
});

Deno.test("diffedit: undoing a context-line edit collapses the pair back", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 6);
    press(s, "end");
    type(s, "X");
    assertEquals(
      s.doc.text.split("\n").length,
      before.split("\n").length + 1,
      "the edit added the removed line",
    );
    press(s, "backspace"); // remove X: the added line matches the removed one
    assertEquals(s.doc.text, before, "the diff is back to its original form");
  } finally {
    done();
  }
});

Deno.test("diffedit: Enter at the start of a context line splits a blank line above it", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // the "     return n * 2;" context line — cursor at line start
    const contextLine = s.doc.text.split("\n")[6];
    s.handleKey({ name: "enter" });
    const lines = s.doc.text.split("\n");
    // Splitting at the start leaves an empty head, so a blank added line goes
    // above and the original stays an unchanged context line below it — the
    // line's text is never dragged onto the new added line.
    assertEquals(lines[6], "+", "a blank added line is inserted above");
    assertEquals(lines[7], contextLine, "the context line is unchanged, below");
    // The cursor keeps its relative position — still at the start of the
    // original line, which the inserted newline pushed down by one.
    assertEquals(
      s.view().cursor,
      { line: 7, col: 1 },
      "cursor follows the content onto the line below",
    );
    // The hunk header's new-side count grew by the one inserted line.
    assertEquals(lines[4], "@@ -1,4 +1,6 @@ export function double");
    // Saving writes the blank inserted line before the original.
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[0], "export function double(n: number): number {");
    assertEquals(onDisk[1], "", "a blank line is inserted");
    assertEquals(
      onDisk[2],
      "    return n * 2;",
      "the original line follows it",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: Enter in the middle of a context line splits it into a removed/added pair", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // the "     return n * 2;" context line
    const orig = s.doc.text.split("\n")[6].slice(1); // content, past the marker
    // Put the cursor in the middle of the content (a few chars before the end).
    press(s, "end", "left", "left", "left");
    s.handleKey({ name: "enter" });
    const lines = s.doc.text.split("\n");
    // The pre-existing line changes, so it becomes a removed line plus the two
    // halves as added lines — not a context line silently emptied.
    assertEquals(lines[6], `-${orig}`, "the original becomes a removed line");
    const head = lines[7].slice(1);
    const tail = lines[8].slice(1);
    assertEquals(lines[7][0], "+", "the head is an added line");
    assertEquals(lines[8][0], "+", "the tail is an added line");
    assert(head.length > 0 && tail.length > 0, "both halves are non-empty");
    assertEquals(
      head + tail,
      orig,
      "the halves rejoin to the original content",
    );
    assertEquals(s.view().cursor?.line, 8, "cursor on the tail line");
    // The new side gained one line; the old side is unchanged.
    assertEquals(lines[4], "@@ -1,4 +1,6 @@ export function double");
    // Saving writes the two halves in place of the original file line.
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[1], head, "the head replaces the original line");
    assertEquals(onDisk[2], tail, "the tail follows on its own line");
    assertEquals(onDisk[3], "}", "the rest of the file is preserved");
  } finally {
    done();
  }
});

Deno.test("diffedit: the diff marker column is protected", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "right"); // step onto the marker boundary (col 1)
    const before = s.doc.text;
    press(s, "backspace");
    assert(s.view().message.toLowerCase().includes("marker"), s.view().message);
    assertEquals(s.doc.text, before, "the marker was not deleted");
  } finally {
    done();
  }
});

Deno.test("diffedit: a removed line is not editable", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8); // the "-export const answer = 42;" line
    const before = s.doc.text;
    type(s, "X");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffedit: a header line is not editable", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 4); // the @@ hunk header
    const before = s.doc.text;
    type(s, "X");
    assert(s.view().message.includes("isn't editable"));
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffedit: Enter adds a line and saving writes it into the file", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // "+export const answer = double(21);" (new line 3)
    press(s, "end");
    press(s, "enter"); // a new added line, marked "+"
    type(s, "const inserted = 7;");
    // The new diff line carries the added marker.
    assert(s.doc.lines[10].text.startsWith("+const inserted = 7;"));
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[3], "export const answer = double(21);");
    assertEquals(onDisk[4], "const inserted = 7;");
    assertEquals(onDisk[5], "const extra = answer + 1;");
    assertEquals(onDisk[6], ""); // trailing newline preserved, not doubled
    assertEquals(onDisk.length, 7);
  } finally {
    done();
  }
});

Deno.test("diffedit: Backspace at a line's start removes it, and save drops it", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 10); // "+const extra = answer + 1;" (new line 4)
    press(s, "end");
    // Clear the content (19 chars), then one more Backspace removes the line.
    for (let i = 0; i < "const extra = answer + 1;".length + 1; i++) {
      press(s, "backspace");
    }
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[3], "export const answer = double(21);");
    assertEquals(onDisk[4], ""); // the last content line was removed
    assertEquals(onDisk.length, 5);
  } finally {
    done();
  }
});

Deno.test("diffedit: a forward delete that would join lines is refused", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end"); // end of the line
    const before = s.doc.text;
    press(s, "delete");
    assert(s.view().message.includes("Backspace"), s.view().message);
    assertEquals(s.doc.text, before, "no join happened");
  } finally {
    done();
  }
});

Deno.test("diffedit: a diff matching no file on disk is read-only", () => {
  const noWs: DiffWorkspace = { resolve: () => null, read: () => null };
  const s = diffSession(noWs);
  press(s, "e");
  assertEquals(s.view().cursor, null, "no cursor on an unmatched diff");
  assert(s.view().message.includes("match"), s.view().message);
});

Deno.test("diffedit: a dirty diff prompts on quit and s saves the file", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, "!");
    press(s, "escape", "q"); // hide cursor, quit from pager mode
    assert(promptText(s.view()).includes("Save changes"), "prompts");
    press(s, "s");
    assert(s.quit);
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[3], "export const answer = double(21);!");
  } finally {
    done();
  }
});

const TWO_FILE_DIFF = `diff --git a/x.ts b/x.ts
index 0000000..1111111 100644
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
diff --git a/z.ts b/z.ts
index 0000000..1111111 100644
--- a/z.ts
+++ b/z.ts
@@ -1,2 +1,2 @@
 const z = 1;
-const w = 2;
+const w = 3;
`;

Deno.test("diffedit: a save reports only the files an edit actually touched", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
    Deno.writeTextFileSync(join(root, "z.ts"), "const z = 1;\nconst w = 3;\n");
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(TWO_FILE_DIFF)!;
    const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
    const src = diffSource(ws, edit);
    // Edit only x.ts's added line.
    const edited = TWO_FILE_DIFF.replace("+const y = 3;", "+const y = 30;");
    assertEquals(src.dirtyLabels!(TWO_FILE_DIFF, edited), ["x.ts"]);
    assertEquals(src.dirtyLabels!(TWO_FILE_DIFF, TWO_FILE_DIFF), []);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: quitting a multi-file diff lists the edited files above the prompt", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
    Deno.writeTextFileSync(join(root, "z.ts"), "const z = 1;\nconst w = 3;\n");
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(TWO_FILE_DIFF)!;
    const { doc, edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 20 },
      undefined,
      diffSource(ws, edit),
    );
    toLine(s, 7); // x.ts added line
    press(s, "end");
    type(s, "0");
    toLine(s, 13); // z.ts context line
    press(s, "end");
    type(s, "0");
    press(s, "escape", "q");
    const prompt = promptText(s.view());
    assert(prompt.includes("2 files"), `prompt: ${prompt}`);
    // The dialog body lists the files a save would write.
    assert(prompt.includes("x.ts"), prompt);
    assert(prompt.includes("z.ts"), prompt);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

function twoFileWs(): { ws: DiffWorkspace; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
  Deno.writeTextFileSync(join(root, "z.ts"), "const z = 1;\nconst w = 3;\n");
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  return { ws, done: () => Deno.removeSync(root, { recursive: true }) };
}

Deno.test("diffedit: revert restores a single hunk, or everything", () => {
  const { ws, done } = twoFileWs();
  try {
    const model = parseDiff(TWO_FILE_DIFF)!;
    const { edit } = buildDiffDocument(TWO_FILE_DIFF, model, ws);
    const src = diffSource(ws, edit);
    const edited = TWO_FILE_DIFF
      .replace("+const y = 3;", "+const y = 3;A")
      .replace("+const w = 3;", "+const w = 3;B");
    // Cursor on line 7 sits in x.ts's hunk; reverting the chunk leaves z.ts.
    const chunk = src.revert!(TWO_FILE_DIFF, edited, 7, "chunk")!;
    assert(!chunk.text.includes("const y = 3;A"), "x.ts hunk reverted");
    assert(chunk.text.includes("const w = 3;B"), "z.ts edit preserved");
    // Reverting all restores the original diff exactly.
    const all = src.revert!(TWO_FILE_DIFF, edited, 7, "all")!;
    assertEquals(all.text, TWO_FILE_DIFF);
    // Nothing to revert when unchanged.
    assertEquals(src.revert!(TWO_FILE_DIFF, TWO_FILE_DIFF, 7, "all"), null);
  } finally {
    done();
  }
});

Deno.test("diffedit: Ctrl-R then 'a' reverts all edits through the session", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 6);
    press(s, "end");
    type(s, "X");
    assert(s.doc.text !== before, "edited");
    s.handleKey({ name: "ctrl-r" });
    assert(promptText(s.view()).includes("Revert"), "the revert prompt shows");
    press(s, "a");
    assertEquals(s.doc.text, before, "all edits reverted");
    assert(s.view().message.includes("Reverted"), s.view().message);
  } finally {
    done();
  }
});

const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
const EXPAND_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

function expandSession(): { root: string; s: Session; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "m.ts"), EXPAND_FILE);
  const ws: DiffWorkspace = {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
  const model = parseDiff(EXPAND_DIFF)!;
  const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 30 },
    undefined,
    diffSource(ws, edit),
  );
  return { root, s, done: () => Deno.removeSync(root, { recursive: true }) };
}

Deno.test("diffedit: Ctrl-L reveals more of the file below the hunk", () => {
  const { s, done } = expandSession();
  try {
    toLine(s, 8); // epsilon, the bottom of the hunk
    s.handleKey({ name: "ctrl-l" });
    const lines = s.doc.text.split("\n");
    assertEquals(lines[4], "@@ -3,6 +3,6 @@", "the header counts grew");
    assert(s.doc.text.includes("\n zeta\n eta\n theta"), s.doc.text);
    // Revealing context is not an edit: a clean quit needs no save prompt.
    press(s, "escape", "q");
    assert(s.quit, "quit without a save prompt");
  } finally {
    done();
  }
});

Deno.test("diffedit: Ctrl-L reveals more of the file above the hunk", () => {
  const { s, done } = expandSession();
  try {
    toLine(s, 5); // gamma, the top of the hunk
    s.handleKey({ name: "ctrl-l" });
    const lines = s.doc.text.split("\n");
    assertEquals(lines[4], "@@ -1,5 +1,5 @@", "header start and counts grew");
    assertEquals(lines[5], " alpha");
    assertEquals(lines[6], " beta");
  } finally {
    done();
  }
});

Deno.test("diffedit: Ctrl-L expands context in pager mode (no text cursor)", () => {
  const { s, done } = expandSession();
  try {
    // No arrow press, so the text cursor is never revealed: we are in the pager.
    assertEquals(s.view().cursor, null, "no text cursor");
    assert(s.view().canExpand, "the status line advertises expand");
    s.handleKey({ name: "ctrl-l" });
    const lines = s.doc.text.split("\n");
    // The hunk on screen expanded; with nothing selected it grows upward first.
    assertEquals(lines[4], "@@ -1,5 +1,5 @@");
    assertEquals(lines[5], " alpha");
    assertEquals(lines[6], " beta");
    assertEquals(s.view().cursor, null, "still no text cursor after expanding");
    // Revealing context is not an edit: a clean quit needs no save prompt.
    press(s, "q");
    assert(s.quit, "quit without a save prompt");
  } finally {
    done();
  }
});

Deno.test("diffedit: in pager mode Ctrl-L expands the selected hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    // Long enough to back FAR_DIFF's second hunk, which sits at line 30.
    const file = Array.from({ length: 40 }, (_, i) =>
      `line${i + 1}`).join("\n") +
      "\n";
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(FAR_DIFF)!;
    const { doc, edit } = buildDiffDocument(FAR_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      diffSource(ws, edit),
    );
    // Select the second hunk via the structure tree (no text cursor), then
    // expand: the choice of hunk must follow the selection, not a stale buffer.
    // Left alone the middle of the screen would reach down from the first.
    let guard = 0;
    while ((s.view().selected?.startLine ?? -1) !== 9 && guard++ < 200) {
      s.handleKey({ name: "tab" });
    }
    assertEquals(
      s.view().selected?.startLine,
      9,
      "the second hunk is selected",
    );
    assertEquals(s.view().cursor, null, "no text cursor");
    s.handleKey({ name: "ctrl-l" });
    assert(
      s.doc.text.includes("@@ -20,13 +20,13 @@"),
      `the selected (second) hunk expanded up: ${s.doc.text}`,
    );
    assert(
      s.doc.text.includes("@@ -4,3 +4,3 @@"),
      "the first hunk is untouched",
    );
    // The hunk stays selected across the reparse even though its @@-count label
    // grew, so a second Ctrl-L keeps expanding the same hunk.
    assertEquals(s.view().selected?.kind, "hunk", "still a hunk selected");
    assertEquals(s.view().selected?.startLine, 9, "still the second hunk");
    assert(
      s.view().selected?.label.startsWith("@@ -20,13 +20,13"),
      `selected hunk label: ${s.view().selected?.label}`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: pager Ctrl-L keeps the hunk header in view when expanding up from the top", () => {
  const { s, done } = expandSession();
  try {
    assertEquals(s.view().top, 0, "starts at the top, pager mode");
    s.handleKey({ name: "ctrl-l" }); // expands up (reveals alpha/beta)
    // The header and preamble sit above the insertion point, so they do not
    // move and the viewport must stay anchored on them.
    assertEquals(s.view().top, 0, "the hunk header stays in view");
    const lines = s.doc.text.split("\n");
    assertEquals(lines[4], "@@ -1,5 +1,5 @@");
    assertEquals(lines[5], " alpha", "revealed context sits below the header");
  } finally {
    done();
  }
});

Deno.test("diffedit: pager Ctrl-L fills a short screen from the held edge", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = Array.from({ length: 40 }, (_, i) =>
      `line${i + 1}`).join("\n") +
      "\n";
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -20,3 +20,3 @@
 line20
-OLD21
+line21
 line22
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 6 },
      undefined,
      diffSource(ws, edit),
    );
    // Scroll down so the hunk body is at the top and the header is off screen.
    for (let i = 0; i < 6; i++) s.handleKey({ name: "j" });
    s.handleKey({ name: "ctrl-l" });
    // The middle of the screen sits in the hunk's lower half, so the lines come
    // from below it and what follows the hunk is held still. Ten lines land on
    // a five-row screen, so they fill it from that held edge: the last of them
    // is on screen and the hunk has been pushed off the top.
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    const rows = s.doc.text.split("\n").slice(s.view().top, s.view().top + 5);
    assert(rows.includes(" line32"), rows.join("|"));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: in pager mode Ctrl-L with the whole-file node selected still expands a hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    // Long enough to back FAR_DIFF's second hunk, which sits at line 30.
    const file = Array.from({ length: 40 }, (_, i) =>
      `line${i + 1}`).join("\n") +
      "\n";
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(FAR_DIFF)!;
    const { doc, edit } = buildDiffDocument(FAR_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      diffSource(ws, edit),
    );
    s.handleKey({ name: "tab" }); // selects the whole-file node, whose start line
    // is the "diff --git" header — in no hunk.
    assertEquals(s.view().selected?.label, "▸ m.ts");
    s.handleKey({ name: "ctrl-l" });
    // It must resolve to a hunk, not report nothing. The whole diff is on
    // screen, so the middle of the content is nearest the first hunk's bottom
    // edge and that is the one that grows.
    assert(s.view().message.startsWith("Showing line"), s.view().message);
    assert(s.doc.text.includes("@@ -4,13 +4,13 @@"), s.doc.text);
    assert(
      s.doc.text.includes("@@ -30,3 +30,3 @@"),
      "the other hunk is untouched",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: a pager expand keeps the selected node selected across the reparse", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "README.md"),
      "# Title\n\nintro\n\n## Section A\n\nbody a\n\n## Section B\n\nbody b NEW\n",
    );
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -9,3 +9,3 @@
 ## Section B

-body b OLD
+body b NEW
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      diffSource(ws, edit),
    );
    let guard = 0;
    while (s.view().selected?.label !== "## Section B" && guard++ < 50) {
      s.handleKey({ name: "tab" });
    }
    assertEquals(s.view().selected?.label, "## Section B");
    s.handleKey({ name: "ctrl-l" }); // expands up — reveals # Title and ## Section A
    assert(s.doc.text.includes(" # Title"), "context revealed above the hunk");
    // The revealed headings become new nodes ahead of the selection in the tree;
    // the selection must follow its node, not the now-stale flat index.
    assertEquals(
      s.view().selected?.label,
      "## Section B",
      "the selection stayed on the same heading",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: an edit after expanding context saves without duplicating lines", () => {
  const { root, s, done } = expandSession();
  try {
    toLine(s, 8);
    s.handleKey({ name: "ctrl-l" }); // expand downward (reveals zeta/eta/theta)
    press(s, "escape");
    toLine(s, 7); // the "+delta" line
    press(s, "end");
    type(s, "!");
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(
      onDisk,
      [
        "alpha",
        "beta",
        "gamma",
        "delta!",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "",
      ],
      "the edit is written and the revealed context is not duplicated",
    );
  } finally {
    done();
  }
});

// --- regression: review findings (expand overlap, repeated-path revert, etc.) -

const MULTI_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -11,3 +11,3 @@
 line11
-OLD12
+line12
 line13
`;

const FAR_DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -4,3 +4,3 @@
 line4
-OLD5
+line5
 line6
@@ -30,3 +30,3 @@
 line30
-OLD31
+line31
 line32
`;

Deno.test("diffedit: expanding context into the next hunk joins them and save stays correct", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = Array.from({ length: 20 }, (_, i) =>
      `line${i + 1}`).join("\n") +
      "\n";
    Deno.writeTextFileSync(join(root, "m.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const model = parseDiff(MULTI_DIFF)!;
    const { doc, edit } = buildDiffDocument(MULTI_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      diffSource(ws, edit),
    );
    toLine(s, 8); // " line6", the bottom of the first hunk
    s.handleKey({ name: "ctrl-l" }); // expand down — the four lines to hunk 2
    // The reveal closes the gap, so the two hunks meet and become one: the
    // header that sat between line10 and line11 described nothing.
    assertEquals(
      s.doc.text.split("\n")[4],
      "@@ -4,10 +4,10 @@",
      "the two hunks joined into one covering both ranges",
    );
    assertEquals(
      parseDiff(s.doc.text)!.files.flatMap((f) => f.hunks).length,
      1,
      "one hunk where there were two",
    );
    // Now edit the SECOND hunk and save: the edit must survive and no line may
    // be dropped or duplicated.
    press(s, "escape");
    const target = s.doc.text.split("\n").indexOf("+line12");
    toLine(s, target);
    press(s, "end");
    type(s, "_EDIT");
    press(s, "f3");
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[11], "line12_EDIT", "the second-hunk edit was saved");
    assertEquals(
      onDisk.length,
      21,
      "20 lines + trailing — nothing dropped/dup'd",
    );
    assertEquals(onDisk[4], "line5");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: revert picks the right commit's section when a path repeats", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "f.ts"), "a\nb\nold3\n");
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const logp = `commit AAAAAAA
diff --git a/f.ts b/f.ts
index 0000000..1111111 100644
--- a/f.ts
+++ b/f.ts
@@ -3,1 +3,1 @@
-NOPE3
+NEW3
commit BBBBBBB
diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -3,1 +3,1 @@
-older3
+old3
`;
    const model = parseDiff(logp)!;
    const { edit } = buildDiffDocument(logp, model, ws);
    const src = diffSource(ws, edit);
    // Edit the SECOND commit's "+old3" line.
    const edited = logp.replace("+old3", "+old3Z");
    const bbbLine = edited.split("\n").indexOf("+old3Z");
    const r = src.revert!(logp, edited, bbbLine, "chunk")!;
    assertEquals(
      r.text,
      logp,
      "the second commit's hunk is restored, not overwritten by the first",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: editing an author's +line to match its -line keeps the pair", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "foo\nbarX\n");
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 foo
-bar
+barX
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 20 },
      undefined,
      diffSource(ws, edit),
    );
    toLine(s, 7); // the "+barX" added line (author-written, not a split)
    press(s, "end");
    press(s, "backspace"); // -> "+bar", which now matches "-bar" above
    const lines = s.doc.text.split("\n");
    assertEquals(lines[6], "-bar", "the author's removed line is preserved");
    assertEquals(lines[7], "+bar", "the pair is NOT collapsed to context");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: Enter on a context line adds a line without forging a -/+ pair", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 5); // " export function double..." context line
    press(s, "end");
    press(s, "enter");
    type(s, "added");
    const lines = s.doc.text.split("\n");
    assertEquals(
      lines[5],
      " export function double(n: number): number {",
      "the context line is unchanged, not split into a -/+ pair",
    );
    assertEquals(lines[6], "+added", "the new line is added below it");
  } finally {
    done();
  }
});

Deno.test("diffedit: down-expanding a hunk does not swallow a trailing blank separator", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = Array.from({ length: 8 }, (_, i) => `x${i + 1}`).join("\n") +
      "\n";
    Deno.writeTextFileSync(join(root, "x.ts"), file);
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/x.ts b/x.ts
index 0000000..1111111 100644
--- a/x.ts
+++ b/x.ts
@@ -3,3 +3,3 @@
 x3
-OLD4
+x4
 x5

trailing note line
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 40 },
      undefined,
      diffSource(ws, edit),
    );
    toLine(s, 8); // " x5", the bottom of the hunk
    s.handleKey({ name: "ctrl-l" }); // expand down
    const text = s.doc.text;
    assert(
      text.includes(" x5\n x6\n x7\n x8\n\ntrailing note line"),
      `revealed context stays inside the hunk, blank separator kept:\n${text}`,
    );
    assertEquals(text.split("\n")[4], "@@ -3,6 +3,6 @@");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: after revert the cursor lands on an editable line, not a header", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // edit an added line
    press(s, "end");
    type(s, "Z");
    s.handleKey({ name: "ctrl-r" });
    press(s, "h"); // revert the chunk
    const cl = s.view().cursor!.line;
    // The landed line is editable (not the @@ header it was spliced at).
    const text = s.doc.lines[cl].text;
    assert(
      text[0] === " " || text[0] === "+",
      `cursor on an editable line after revert: ${text}`,
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: undoing a context edit collapses even after moving the cursor away and back", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 6); // a context line
    press(s, "end");
    type(s, "X"); // splits into "-ctx" / "+ctxX"
    press(s, "left", "right"); // move off the split line and back
    press(s, "backspace"); // delete X: "+ctx" matches "-ctx" again
    assertEquals(
      s.doc.text,
      before,
      "the pair collapsed back to a context line",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: an edit-mode search leaves the full match set for normal-mode n/N", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    press(s, "e"); // reveal the edit cursor
    s.handleKey({ name: "ctrl-s" });
    type(s, "answer"); // matches the removed line 8 and added line 9
    press(s, "enter");
    press(s, "escape"); // leave edit mode; the query stays active
    const matchLines = (s.view().matches ?? []).map((m) => m.line);
    assert(
      matchLines.includes(8),
      `normal-mode matches still include the removed line: ${matchLines}`,
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: Ctrl-S search skips non-editable (removed) lines", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    press(s, "e"); // reveal at line 0
    s.handleKey({ name: "ctrl-s" });
    type(s, "answer"); // first occurs on the removed line 8, then the added line 9
    press(s, "enter");
    const cl = s.view().cursor!.line;
    assert(
      s.doc.lines[cl].text.startsWith("+"),
      `cursor landed on an editable line, not a removed one: ${
        s.doc.lines[cl].text
      }`,
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: inserting a line grows the hunk count so no body line is dropped", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "a\nb\nc\nd\n");
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const diff = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,4 @@
 a
-OLD
+b
 c
 d
`;
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 20 },
      undefined,
      diffSource(ws, edit),
    );
    toLine(s, 7); // the "+b" added line
    press(s, "end");
    press(s, "enter");
    type(s, "NEW");
    assertEquals(
      s.doc.text.split("\n")[4],
      "@@ -1,4 +1,5 @@",
      "the new-side count grew by one",
    );
    s.reparse(); // the deferred full parse must keep every line in the hunk
    const d = s.doc.lines.find((l) => l.text === " d")!;
    assertEquals(
      d.spans[0].cls,
      "whitespace",
      "the trailing context line is not dropped to plain text",
    );
    // Removing the added line again restores the original count: delete its
    // content, then backspace at the now-empty line's start to drop the line.
    press(s, "backspace", "backspace", "backspace"); // delete W, E, N -> "+"
    press(s, "backspace"); // empty added line: remove it
    assertEquals(s.doc.text.split("\n")[4], "@@ -1,4 +1,4 @@");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: expanding after an insert reveals the right file lines", () => {
  const { s, done } = expandSession();
  try {
    toLine(s, 7); // "+delta"
    press(s, "end");
    press(s, "enter");
    type(s, "INS"); // insert a line inside the hunk
    press(s, "escape");
    const il = s.doc.text.split("\n").indexOf("+INS");
    toLine(s, il);
    s.handleKey({ name: "ctrl-l" }); // expand down
    // The revealed context starts just below the original hunk footprint
    // (zeta), not shifted past it by the inserted line.
    assert(s.doc.text.includes(" zeta\n eta\n theta"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffedit: insert + expand + edit then save writes the file correctly", () => {
  const { root, s, done } = expandSession();
  try {
    toLine(s, 7); // "+delta"
    press(s, "end");
    press(s, "enter");
    type(s, "INS"); // insert a line
    press(s, "escape");
    toLine(s, s.doc.text.split("\n").indexOf("+INS"));
    s.handleKey({ name: "ctrl-l" }); // expand context
    press(s, "escape");
    toLine(s, s.doc.text.split("\n").indexOf("+delta"));
    press(s, "end");
    type(s, "!"); // edit the original change
    press(s, "f3");
    assertEquals(
      Deno.readTextFileSync(join(root, "m.ts")),
      "alpha\nbeta\ngamma\ndelta!\nINS\nepsilon\nzeta\neta\ntheta\n",
      "the edit and insert land; revealed context is not duplicated",
    );
  } finally {
    done();
  }
});

// --- regression: git log -p multi-commit diffs must not corrupt files --------

function stubWs(root: string): DiffWorkspace {
  return {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
}

function sessionFor(diff: string, ws: DiffWorkspace): Session {
  const model = parseDiff(diff)!;
  const { doc, edit } = buildDiffDocument(diff, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 40 },
    undefined,
    diffSource(ws, edit),
  );
}

Deno.test("diffedit: saving a git log -p diff does not absorb commit text or write a stale hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "realLine1\nrest2\nrest3\n");
    // Two commits both touch x.ts at the same range. Only the newest (first)
    // verifies against disk; the older one is stale, and commit metadata sits
    // between the two file sections.
    const log = [
      "commit bbbbbbbbbbbbbbbb",
      "Author: Dev <dev@example.com>",
      "Date:   Mon Jan 1 00:00:00 2024 +0000",
      "",
      "    Second commit subject line",
      "",
      "diff --git a/x.ts b/x.ts",
      "index 2222222..3333333 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-realLine0",
      "+realLine1",
      "commit aaaaaaaaaaaaaaaa",
      "Author: Dev <dev@example.com>",
      "Date:   Sun Jan 1 00:00:00 2023 +0000",
      "",
      "    First commit subject line",
      "",
      "diff --git a/x.ts b/x.ts",
      "index 1111111..2222222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-original",
      "+realLine0",
      "",
    ].join("\n");
    const s = sessionFor(log, stubWs(root));
    press(s, "f3"); // save with no edits at all
    assertEquals(
      Deno.readTextFileSync(join(root, "x.ts")),
      "realLine1\nrest2\nrest3\n",
      "the file is untouched: no absorbed metadata, no stale hunk written",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: a blank (empty) diff line is not editable", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "alpha\n\nbeta\n");
    // The middle context line is emitted empty (a tool that trims the space).
    const diff = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "",
      " beta",
      "",
    ].join("\n");
    const s = sessionFor(diff, stubWs(root));
    toLine(s, 5); // the empty context line
    const before = s.doc.text;
    type(s, "x");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(
      s.doc.text,
      before,
      "the blank line was not forged into '-'/'x'",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: editing a hunk with a blank context line saves without truncating the file", () => {
  const root = Deno.makeTempDirSync();
  try {
    // The new side on disk has a blank line between alpha and BETA. The diff's
    // body therefore carries an empty (unprefixed) context line; the parser
    // counts it toward the hunk while save must carry its file line, not stop.
    Deno.writeTextFileSync(join(root, "m.ts"), "alpha\n\nBETA\ngamma\n");
    const diff = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,4 +1,4 @@",
      " alpha",
      "", // blank context line inside the counted body
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const s = sessionFor(diff, stubWs(root));
    toLine(s, 7); // the "+BETA" added line, below the blank context line
    press(s, "end");
    type(s, "!");
    press(s, "f3");
    assert(s.view().message.startsWith("Saved"), s.view().message);
    // The whole new side round-trips: the blank line, the edit, and every line
    // after it survive — no early stop that splices away the file's tail.
    assertEquals(
      Deno.readTextFileSync(join(root, "m.ts")),
      "alpha\n\nBETA!\ngamma\n",
      "the blank context line did not truncate the saved file",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// --- refusing edits that cannot be saved (a commit-message preamble) ---------

Deno.test("diffedit: refuses editing text before the diff (a commit-message subject)", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSessionFrom(ws, GIT_SHOW);
    toLine(s, 4); // the indented subject line — reads like context, is not
    assertEquals(s.view().cursor?.line, 4, "cursor on the subject line");
    const before = s.doc.text;
    type(s, "X");
    assertEquals(s.doc.text, before, "the edit was refused");
    assert(s.view().message.length > 0, "and it says why");
  } finally {
    done();
  }
});

Deno.test("diffedit: refuses editing a message body line, allows a hunk line", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSessionFrom(ws, GIT_SHOW);
    // A body line of the commit message is not part of any hunk: refused.
    toLine(s, 6);
    const before = s.doc.text;
    type(s, "Z");
    assertEquals(s.doc.text, before, "message body edit refused");
    // An added line inside the verified hunk is still editable.
    toLine(s, 17); // "+export const answer = double(21);"
    press(s, "end");
    type(s, " // note");
    assert(s.doc.text !== before, "the hunk line accepted the edit");
    assert(
      s.doc.lines[17].text.includes("// note"),
      s.doc.lines[17].text,
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: an edit-mode search skips the preamble to a savable line", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSessionFrom(ws, GIT_SHOW);
    press(s, "e"); // reveal the cursor
    // Search for text that appears on an added line inside the hunk. An edit-
    // mode search lands the cursor only on editable matches, so it skips the
    // commit-message preamble entirely.
    s.handleKey({ name: "ctrl-s" });
    for (const ch of "double(21)") s.handleKey({ name: ch, char: ch });
    s.handleKey({ name: "enter" });
    const line = s.view().cursor?.line ?? -1;
    assert(line >= 12, `cursor landed in the hunk body, at ${line}`);
    type(s, "!");
    assert(s.doc.lines[line].text.includes("!"), "the landed line is editable");
  } finally {
    done();
  }
});

// --- editing the HEAD commit's message (git show) ----------------------------

Deno.test("diffedit: the HEAD commit's message is editable; save prompts then amends", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA); // the shown commit IS HEAD
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4); // the subject line — an editable message line
    press(s, "end");
    type(s, " EDIT");
    // A message line is edited as plain indented text (no removed/added pair).
    assertEquals(
      s.doc.lines[4].text,
      "    Subject line of the commit EDIT",
      s.doc.lines[4].text,
    );
    // Saving a changed message asks to confirm the amend first.
    press(s, "f3");
    assert(
      promptText(s.view()).includes("Amend commit 012345678"),
      promptText(s.view()) || "(no prompt)",
    );
    assertEquals(fg.amended(), null, "nothing amended before confirming");
    // Confirm: the amend runs with the edited message (indent stripped).
    press(s, "y");
    assertEquals(
      fg.amended(),
      "Subject line of the commit EDIT\n\nA body paragraph of the message.",
    );
    assert(s.view().message.includes("Amended"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffedit: declining the amend prompt writes nothing", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 6); // the body line
    press(s, "end");
    type(s, " more");
    press(s, "f3");
    press(s, "n"); // decline
    assertEquals(fg.amended(), null, "the commit was not amended");
    assert(s.view().message.toLowerCase().includes("cancel"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffedit: Enter in a message adds another indented line", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4);
    press(s, "end");
    press(s, "enter");
    type(s, "second subject line");
    // The new line carries git's four-space indent and stays a message line.
    assertEquals(s.doc.lines[5].text, "    second subject line");
    press(s, "f3");
    press(s, "y");
    assertEquals(
      fg.amended(),
      "Subject line of the commit\nsecond subject line\n\n" +
        "A body paragraph of the message.",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: a non-HEAD commit's message is not editable", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit("ffffffffffffffffffffffffffffffffffffffff"); // not the shown sha
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4);
    const before = s.doc.text;
    type(s, "X");
    assertEquals(s.doc.text, before, "a non-HEAD message is read-only");
    // Saving does not offer to amend a commit that is not HEAD.
    press(s, "f3");
    assertEquals(fg.amended(), null, "a non-HEAD commit is never amended");
  } finally {
    done();
  }
});

Deno.test("diffedit: editing only a hunk (not the message) saves with no amend prompt", () => {
  const { root, ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 17); // an added hunk line
    press(s, "end");
    type(s, " // x");
    press(s, "f3");
    // The message is unchanged, so no amend prompt and no amend.
    assert(s.view().message.startsWith("Saved"), s.view().message);
    assertEquals(fg.amended(), null, "an unchanged message is not amended");
    assert(
      Deno.readTextFileSync(join(root, "m.ts")).includes("// x"),
      "the hunk edit was written",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: quitting with an edited message confirms the save then the amend, then quits", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4);
    press(s, "end");
    type(s, " Q");
    press(s, "escape"); // hide the cursor, back to pager mode
    press(s, "q"); // quit → the dirty save prompt
    assert(
      promptText(s.view()).includes("Save changes"),
      promptText(s.view()),
    );
    press(s, "s"); // → the amend prompt (the save-prompt handler stands aside)
    assert(
      promptText(s.view()).includes("Amend commit"),
      promptText(s.view()),
    );
    assert(!s.quit, "not quit until the amend is confirmed");
    press(s, "y"); // confirm the amend → save, amend, and quit
    assert(s.quit, "quits after the amend");
    assert(
      fg.amended()?.startsWith("Subject line of the commit Q"),
      fg.amended() ?? "(none)",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: with no git runner the message is not editable", () => {
  const { ws, done } = tempWorkspace();
  try {
    const s = diffSessionFrom(ws, GIT_SHOW); // no git
    toLine(s, 4);
    const before = s.doc.text;
    type(s, "X");
    assertEquals(s.doc.text, before, "no git means no message editing");
  } finally {
    done();
  }
});

// --- amend safety (review follow-ups) ----------------------------------------

Deno.test("diffedit: refuses to save an all-blank commit message", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    // Blank both content lines of the message (leaving the four-space indents).
    for (const row of [4, 6]) {
      toLine(s, row);
      press(s, "ctrl-a"); // line start
      press(s, "ctrl-k"); // kill to end (nudged past the indent)
    }
    press(s, "f3");
    assert(s.view().message.includes("would be empty"), s.view().message);
    assertEquals(fg.amended(), null, "an empty message is never amended");
    // No amend prompt was raised, so no file was written either.
    assert(s.view().dialog == null, "no prompt is left open");
  } finally {
    done();
  }
});

Deno.test("diffedit: refuses to save when every commit-message line is deleted", () => {
  const { root, ws, done } = tempWorkspace();
  const before = Deno.readTextFileSync(join(root, "m.ts"));
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    // Remove the three message lines: blank each one, then Backspace at its
    // start takes the line away. Each removal leaves the cursor on the line
    // above, so the next message line is again at row 4.
    for (let i = 0; i < 3; i++) {
      toLine(s, 4);
      press(s, "ctrl-a");
      press(s, "ctrl-k");
      press(s, "backspace");
    }
    assertEquals(s.doc.lines[4].text, "", "no message lines are left");
    press(s, "f3");
    assert(s.view().message.includes("would be empty"), s.view().message);
    assertEquals(fg.amended(), null, "the commit was not amended");
    assertEquals(s.view().dialog, null, "no prompt is left open");
    assertEquals(
      Deno.readTextFileSync(join(root, "m.ts")),
      before,
      "the refused save wrote no file",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: a SHA-256 repository's commit message is editable and amends", () => {
  const { ws, done } = tempWorkspace();
  const sha256 = "0".repeat(24) + SHOW_SHA; // a 64-character object id
  const fg = fakeGit(sha256);
  try {
    const s = diffSessionFrom(
      ws,
      GIT_SHOW.replace(SHOW_SHA, sha256),
      20,
      fg.git,
    );
    toLine(s, 4);
    press(s, "end");
    type(s, " EDIT");
    assertEquals(s.doc.lines[4].text, "    Subject line of the commit EDIT");
    press(s, "f3");
    assert(promptText(s.view()).includes("Amend commit"), promptText(s.view()));
    press(s, "y");
    assertEquals(
      fg.amended(),
      "Subject line of the commit EDIT\n\nA body paragraph of the message.",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: does not amend (or write files) when HEAD moved since the diff was shown", () => {
  const { root, ws, done } = tempWorkspace();
  const before = Deno.readTextFileSync(join(root, "m.ts"));
  const fg = movingGit(SHOW_SHA, "ffffffffffffffffffffffffffffffffffffffff");
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4);
    press(s, "end");
    type(s, " X");
    press(s, "f3"); // editability used the cached (original) HEAD
    press(s, "y"); // the amend re-reads HEAD, sees it moved, and refuses
    assertEquals(fg.amended(), null, "no amend when HEAD moved");
    assert(s.view().message.includes("HEAD has moved"), s.view().message);
    // The amend runs before the file write, so a refusal leaves files untouched.
    assertEquals(
      Deno.readTextFileSync(join(root, "m.ts")),
      before,
      "no file written",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit: quitting after a message-only edit names the message, not files", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 20, fg.git);
    toLine(s, 4);
    press(s, "end");
    type(s, " Z");
    press(s, "escape"); // back to pager mode
    press(s, "q"); // quit → the dirty save prompt
    const prompt = promptText(s.view());
    assert(prompt.includes("the commit message"), prompt);
    assert(!/\bfiles?\b/.test(prompt), `should not name files: ${prompt}`);
  } finally {
    done();
  }
});

// --- context-aware revert prompt ---------------------------------------------

/** Move the text cursor to `line` (up or down), in edit mode. */
function moveCursorTo(s: Session, line: number): void {
  let guard = 0;
  while ((s.view().cursor?.line ?? line) < line && guard++ < 2000) {
    press(s, "down");
  }
  while ((s.view().cursor?.line ?? line) > line && guard++ < 2000) {
    press(s, "up");
  }
}

Deno.test("revert: in a hunk offers hunk and file, not message", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    toLine(s, 17); // an added hunk line
    press(s, "end");
    type(s, " X");
    press(s, "ctrl-r");
    const p = promptText(s.view());
    assert(p.includes("Hunk"), p);
    assert(p.includes("File"), p);
    assert(!p.includes("Message"), p);
    assert(p.includes("All"), p);
  } finally {
    done();
  }
});

Deno.test("revert: Enter does nothing on a diff revert (no default button)", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    toLine(s, 17);
    press(s, "end");
    type(s, " X");
    const dirty = s.doc.text;
    press(s, "ctrl-r");
    press(s, "enter"); // no default -> a no-op, the dialog stays up
    assert(promptText(s.view()).includes("Hunk"), "dialog still open");
    assertEquals(s.view().message, "", "not cancelled");
    assertEquals(s.doc.text, dirty, "nothing reverted");
    // A scope key still works afterwards.
    press(s, "a");
    assert(!s.doc.text.includes(" X"), "all reverted after Enter no-op");
  } finally {
    done();
  }
});

Deno.test("revert: with no default button, Tab focuses the first scope, Shift-Tab the last", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    toLine(s, 17);
    press(s, "end");
    type(s, " X");

    press(s, "ctrl-r");
    assertEquals(
      s.view().dialog?.focus,
      -1,
      "no button is focused without a default",
    );
    const n = s.view().dialog!.buttons.length;

    // From no focus, Tab lands on the first button (a scope).
    press(s, "tab");
    assertEquals(s.view().dialog?.focus, 0, "Tab focused the first scope");
    press(s, "escape"); // close it via Cancel

    // Reopen and go the other way: Shift-Tab from no focus lands on the last,
    // which is Cancel; Enter then activates it.
    press(s, "ctrl-r");
    press(s, "shift-tab");
    assertEquals(
      s.view().dialog?.focus,
      n - 1,
      "Shift-Tab focused the last button",
    );
    press(s, "enter");
    assertEquals(s.view().message, "Cancelled");
  } finally {
    done();
  }
});

Deno.test("revert: on a file header offers file but not hunk", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    toLine(s, 17);
    press(s, "end");
    type(s, " X"); // make the buffer dirty
    moveCursorTo(s, 8); // the "diff --git" header line — in the file, in no hunk
    press(s, "ctrl-r");
    const p = promptText(s.view());
    assert(p.includes("File"), p);
    assert(!p.includes("Hunk"), p);
    assert(!p.includes("Message"), p);
  } finally {
    done();
  }
});

Deno.test("revert: in the commit preamble offers only all", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    toLine(s, 17);
    press(s, "end");
    type(s, " X");
    moveCursorTo(s, 0); // the "commit …" line — no file, no hunk, no message
    press(s, "ctrl-r");
    const p = promptText(s.view());
    assert(p.includes("All"), p);
    assert(!p.includes("Hunk"), p);
    assert(!p.includes("File"), p);
    assert(!p.includes("Message"), p);
  } finally {
    done();
  }
});

Deno.test("revert: in the commit message offers message, and m restores it", () => {
  const { ws, done } = tempWorkspace();
  const fg = fakeGit(SHOW_SHA);
  try {
    const s = diffSessionFrom(ws, GIT_SHOW, 30, fg.git);
    // Edit both a hunk line and the message subject.
    toLine(s, 17);
    press(s, "end");
    type(s, " HUNK");
    moveCursorTo(s, 4);
    press(s, "end");
    type(s, " EDIT");
    assertEquals(s.doc.lines[4].text, "    Subject line of the commit EDIT");
    press(s, "ctrl-r");
    const p = promptText(s.view());
    assert(p.includes("Message"), p);
    assert(!p.includes("Hunk"), p);
    assert(!p.includes("File"), p);
    press(s, "m"); // revert only the message
    assertEquals(
      s.doc.lines[4].text,
      "    Subject line of the commit",
      "the message is restored",
    );
    assert(
      s.doc.lines[17].text.includes("HUNK"),
      "the hunk edit is kept: " + s.doc.lines[17].text,
    );
    assert(s.view().message.includes("Reverted the message"), s.view().message);
  } finally {
    done();
  }
});
