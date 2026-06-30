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
import { Session } from "../lib/view/session.ts";

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

/** Reveal the cursor and move it down to the given diff line. */
function toLine(s: Session, line: number): void {
  press(s, "down"); // reveal at the top
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
  const model = parseDiff(DIFF)!;
  const { doc, edit } = buildDiffDocument(DIFF, model, ws);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height },
    undefined,
    diffSource(ws, edit),
  );
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
  press(s, "down");
  assertEquals(s.view().cursor, null, "no cursor on an unmatched diff");
  assert(s.view().message.includes("match"), s.view().message);
});

Deno.test("diffedit: a dirty diff prompts on quit and y saves the file", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, "!");
    press(s, "escape", "q"); // hide cursor, quit from pager mode
    assert(s.view().inputLine?.includes("Save changes"), "prompts");
    press(s, "y");
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
    const prompt = s.view().inputLine ?? "";
    assert(prompt.includes("2 files"), `prompt: ${prompt}`);
    const notice = (s.view().notice ?? []).join(" | ");
    assert(notice.includes("x.ts"), notice);
    assert(notice.includes("z.ts"), notice);
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
    assert(s.view().inputLine?.includes("Revert"), "the revert prompt shows");
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
    // Select the second hunk via the structure tree (no text cursor), then
    // expand: the choice of hunk must follow the selection, not a stale buffer.
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
      s.doc.text.includes("@@ -7,7 +7,7 @@"),
      "the selected (second) hunk expanded up",
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
      s.view().selected?.label.startsWith("@@ -7,7 +7,7"),
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

Deno.test("diffedit: pager Ctrl-L anchors the visible content when scrolled into the hunk body", () => {
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
    const topLine = s.doc.text.split("\n")[s.view().top];
    s.handleKey({ name: "ctrl-l" }); // expand up: lines inserted above the body
    // Now the top of the viewport IS below the insertion point, so it shifts to
    // keep the same line on screen rather than letting it scroll away.
    assertEquals(
      s.doc.text.split("\n")[s.view().top],
      topLine,
      "the same line stays at the top of the screen",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit: in pager mode Ctrl-L with the whole-file node selected still expands a hunk", () => {
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
    s.handleKey({ name: "tab" }); // selects the whole-file node, whose start line
    // is the "diff --git" header — in no hunk.
    assertEquals(s.view().selected?.label, "▸ m.ts");
    s.handleKey({ name: "ctrl-l" });
    // It must resolve to the file's first on-screen hunk, not report nothing.
    assertEquals(s.view().message, "Expanded context.");
    assert(s.doc.text.includes("@@ -1,"), "the first hunk expanded up");
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

Deno.test("diffedit: expanding context stops at the adjacent hunk and save stays correct", () => {
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
    s.handleKey({ name: "ctrl-l" }); // expand down — must stop before hunk 2
    assertEquals(
      s.doc.text.split("\n")[4],
      "@@ -4,7 +4,7 @@",
      "expansion abuts the next hunk (k=4) instead of overlapping it",
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
    press(s, "c"); // revert the chunk
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
    press(s, "down"); // reveal the edit cursor
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
    press(s, "down"); // reveal at line 0
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
