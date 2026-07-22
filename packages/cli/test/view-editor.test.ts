/**
 * Editor behaviour at the session level: revealing/moving/hiding the text
 * cursor, live re-highlighting on edit, the Emacs kill/yank bindings reached
 * through the session, saving to disk, and the dirty-quit save prompt. The
 * cursor-free pager behaviour lives in view-session.test.ts; the pure edit
 * engine is covered in view-editbuffer.test.ts.
 */
import { assert, assertEquals } from "@std/assert";
import { parseDocument, promptText } from "./view-helpers.ts";
import { highlightDocument } from "../lib/view/parse.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import {
  type EditableSource,
  fileSource,
  readonlySource,
} from "../lib/view/editsource.ts";

function key(name: string, opts: Partial<Key> = {}): Key {
  return { name, ...opts };
}

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

/** An in-memory editable source: records what was saved, no disk I/O. */
function memSource(): { src: EditableSource; saved: () => string | null } {
  let saved: string | null = null;
  const src: EditableSource = {
    label: "mem.ts",
    editable: true,
    parse: (text) => parseDocument(text, "mem.ts"),
    highlight: (text) => highlightDocument(text, "mem.ts"),
    save: (text) => {
      saved = text;
      return "Saved mem.ts";
    },
  };
  return { src, saved: () => saved };
}

function editSession(text: string, src: EditableSource, height = 10): Session {
  const doc = src.parse(text);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height },
    undefined,
    src,
  );
}

Deno.test("editor: e reveals the cursor, a bare arrow scrolls, ESC hides it", () => {
  const { src } = memSource();
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") +
    "\n";
  const s = editSession(long, src, 6);
  assertEquals(s.view().cursor, null, "no cursor before a key");
  // A bare arrow scrolls the view rather than entering edit mode.
  press(s, "down");
  assertEquals(s.view().cursor, null, "the arrow did not enter edit mode");
  assertEquals(s.view().top, 1, "the arrow scrolled the view");
  // 'e' enters edit mode, revealing the cursor at the top of the view; then the
  // arrows move it.
  press(s, "e");
  assertEquals(s.view().cursor, { line: 1, col: 0 }, "e revealed the cursor");
  press(s, "down", "right");
  assertEquals(s.view().cursor, { line: 2, col: 1 }, "then arrows move it");
  press(s, "escape");
  assertEquals(s.view().cursor, null, "ESC hides it again");
});

Deno.test("editor: revealing the cursor forces the first display mode", () => {
  const { src } = memSource();
  const s = editSession("hello\nworld\n", src);
  // Switch to a mode that hides/collapses non-printables, breaking the 1:1
  // column mapping the editor relies on.
  press(s, "c");
  assertEquals(s.view().displayMode, "ansi");
  press(s, "e"); // reveal the text cursor
  assert(s.view().cursor !== null, "cursor revealed");
  assertEquals(
    s.view().displayMode,
    "pictures",
    "edit mode resets to pictures",
  );
});

Deno.test("editor: revealing the cursor turns line wrapping off", () => {
  const { src } = memSource();
  const s = editSession("x".repeat(90), src, 3);
  press(s, "\\", "j", "e");
  assert(!s.view().wrapLines, "editing uses one screen row per source line");
  assertEquals(s.view().cursor, { line: 0, col: 39 });
  assertEquals(s.view().left, 39, "the visible continuation stays at the left");
  assertEquals(s.view().message, "Line wrapping turned off for editing.");
});

Deno.test("editor: a pipe rejects the cursor with a reason", () => {
  const reason =
    "This view is of a pipe — there is no underlying file to edit.";
  const s = editSession("piped text\n", readonlySource(reason));
  press(s, "e");
  assertEquals(s.view().cursor, null, "no cursor on a pipe");
  assert(s.view().message.includes("pipe"), "explains it is a pipe");
});

Deno.test("editor: a sourceless view has nothing to edit", () => {
  const doc = parseDocument("x\n");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "e");
  assertEquals(s.view().cursor, null);
  assert(s.view().message.toLowerCase().includes("no underlying file"));
});

Deno.test("editor: typing inserts and re-highlights live", () => {
  const { src } = memSource();
  const s = editSession("hello\nworld\n", src);
  press(s, "e"); // reveal at (0,0)
  type(s, "X");
  assertEquals(s.doc.text, "Xhello\nworld\n", "insert lands in the document");
  assertEquals(s.view().cursor, { line: 0, col: 1 });
  // The document is a fresh parse of the edited text — its first line's spans
  // cover the new content.
  assertEquals(s.doc.lines[0].text, "Xhello");
});

Deno.test("editor: backspace deletes and Enter splits the line", () => {
  const { src } = memSource();
  const s = editSession("ab\n", src);
  press(s, "e"); // reveal at (0,0)
  press(s, "right", "right"); // (0,2), end of "ab"
  press(s, "backspace");
  assertEquals(s.doc.text, "a\n");
  press(s, "enter");
  assertEquals(s.doc.text, "a\n\n", "Enter inserts a newline");
  assertEquals(s.view().cursor, { line: 1, col: 0 });
});

Deno.test("editor: Ctrl-K kills to end of line, Ctrl-Y yanks it back", () => {
  const { src } = memSource();
  const s = editSession("hello world\n", src);
  press(s, "e"); // reveal at (0,0)
  press(s, "right", "right", "right", "right", "right"); // after "hello"
  press(s, "ctrl-k"); // kill " world"
  assertEquals(s.doc.text, "hello\n");
  press(s, "ctrl-y"); // yank it back
  assertEquals(s.doc.text, "hello world\n");
});

Deno.test("editor: M-c capitalises the word at the cursor", () => {
  const { src } = memSource();
  const s = editSession("hello world\n", src);
  press(s, "e"); // reveal at (0,0)
  s.handleKey(key("c", { alt: true }));
  assertEquals(s.doc.text, "Hello world\n");
});

Deno.test("editor: Alt+arrows still scroll while the cursor is shown", () => {
  const { src } = memSource();
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") +
    "\n";
  const s = editSession(long, src, 6);
  press(s, "e"); // reveal cursor at (0,0)
  assertEquals(s.view().top, 0);
  s.handleKey(key("down", { alt: true }));
  s.handleKey(key("down", { alt: true }));
  assertEquals(s.view().top, 2, "alt+down scrolls the viewport");
  assertEquals(s.view().cursor, { line: 0, col: 0 }, "cursor unchanged");
});

Deno.test("editor: F3 saves the edited text to disk", async () => {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, "hello\nworld\n");
    const s = editSession("hello\nworld\n", fileSource(path));
    press(s, "e");
    type(s, "X");
    press(s, "f3");
    assertEquals(await Deno.readTextFile(path), "Xhello\nworld\n");
    assert(s.view().message.startsWith("Saved"));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("editor: F3 on an unchanged file reports zero and does not write", async () => {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, "hello\n");
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await Deno.utime(path, oldTime, oldTime);
    const mtime = (await Deno.stat(path)).mtime?.getTime();
    const s = editSession("hello\n", fileSource(path));
    press(s, "f3");
    assertEquals(s.view().message, "Saved 0 files");
    assertEquals(
      (await Deno.stat(path)).mtime?.getTime(),
      mtime,
      "the unchanged file was not opened for writing",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("editor: C-x C-s saves to disk", async () => {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, "abc\n");
    const s = editSession("abc\n", fileSource(path));
    press(s, "e");
    type(s, "Z");
    s.handleKey(key("ctrl-x"));
    s.handleKey(key("ctrl-s"));
    assertEquals(await Deno.readTextFile(path), "Zabc\n");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("editor: quitting dirty prompts, s saves and quits", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q"); // hide the cursor, then quit from pager mode
  assert(!s.quit, "does not quit yet");
  assert(promptText(s.view()).includes("Save changes"), "shows the prompt");
  press(s, "s");
  assert(s.quit, "quits after saving");
  assertEquals(saved(), "Zabc\n");
});

Deno.test("editor: dialog shortcut letters accept either case", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "S");
  assert(s.quit, "uppercase S activated Save");
  assertEquals(saved(), "Zabc\n");
});

Deno.test("editor: the save prompt ignores keys that are not its buttons", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "y"); // the button is Save (s), not Yes — y does nothing
  assert(!s.quit, "still up");
  assert(promptText(s.view()).includes("Save changes"), "prompt still shown");
  assertEquals(saved(), null, "nothing saved");
  press(s, "s"); // the Save button
  assert(s.quit);
  assertEquals(saved(), "Zabc\n");
});

Deno.test("editor: the save prompt focuses its default button; Space activates it", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  assertEquals(
    s.view().dialog?.focus,
    0,
    "Save, the default button, is focused",
  );
  press(s, "space"); // Space activates the focused button, like Enter
  assert(s.quit, "quits after saving");
  assertEquals(saved(), "Zabc\n");
});

Deno.test("editor: Tab moves the focus ring; Enter activates the focused button", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "tab"); // Save → Discard
  assertEquals(s.view().dialog?.focus, 1, "Tab advanced the focus to Discard");
  press(s, "enter"); // Enter activates whichever button is focused
  assert(s.quit, "quits after discarding");
  assertEquals(saved(), null, "Discard was activated, not Save");
});

Deno.test("editor: Shift-Tab wraps the focus ring to the last button", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "shift-tab"); // Save → Cancel, wrapping backwards
  assertEquals(s.view().dialog?.focus, 2, "Shift-Tab wrapped to Cancel");
  press(s, "enter");
  assertEquals(s.view().message, "Cancelled");
});

Deno.test("editor: activating a button captures the pushed frame for its press", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "shift-tab"); // focus Cancel (index 2)
  press(s, "enter"); // activate it
  const push = s.pendingPush;
  assert(push, "the press captured a pushed frame");
  assertEquals(
    push!.view.dialog?.pushed,
    2,
    "the pushed frame shows Cancel pressed",
  );
  assertEquals(s.view().message, "Cancelled", "and the button's action ran");
  press(s, "s"); // any following key clears the pending press
  assertEquals(s.pendingPush, null, "the next key drops the pending press");
});

Deno.test("editor: quitting dirty, d discards and quits", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "d");
  assert(s.quit, "quits");
  assertEquals(saved(), null, "nothing written");
});

Deno.test("editor: quitting dirty, c cancels", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  press(s, "escape", "q");
  press(s, "c");
  assert(!s.quit, "stays open");
  assertEquals(s.view().message, "Cancelled");
});

Deno.test("editor: a clean quit needs no prompt", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e"); // reveal, but no edits
  press(s, "escape"); // hide
  press(s, "q");
  assert(s.quit, "quits straight away when there are no changes");
});

Deno.test("editor: Ctrl-C on a dirty buffer also prompts", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  s.handleKey(key("ctrl-c"));
  assert(!s.quit);
  assert(promptText(s.view()).includes("Save changes"));
});

Deno.test("editor: a SIGINT routes a dirty quit through the save prompt", () => {
  const { src, saved } = memSource();
  const s = editSession("abc\n", src);
  press(s, "e");
  type(s, "Z");
  assert(s.requestQuitFromSignal(), "stays running to ask");
  assert(promptText(s.view()).includes("Save changes"));
  assert(!s.quit);
  // A second interrupt while the prompt is up tells the driver to terminate.
  assert(!s.requestQuitFromSignal(), "second interrupt lets it exit");
  // Answer the prompt: save and quit.
  press(s, "s");
  assert(s.quit);
  assertEquals(saved(), "Zabc\n");
});

Deno.test("editor: a SIGINT on a clean buffer just terminates", () => {
  const { src } = memSource();
  const s = editSession("abc\n", src);
  assert(!s.requestQuitFromSignal(), "nothing to save → driver terminates");
});

const spanText = (line: { spans: readonly { text: string }[] }) =>
  line.spans.map((s) => s.text).join("");

Deno.test("editor: typing re-highlights live and defers only the structure reparse", () => {
  const { src } = memSource();
  const s = editSession("const a = 1;\nconst b = 2;\n", src);
  press(s, "e"); // reveal at (0,0)
  type(s, "X");
  const line = s.doc.lines[0];
  assertEquals(line.text, "Xconst a = 1;");
  // Spans reflect the NEW text (a stale copy would reconstruct the old line).
  assertEquals(spanText(line), "Xconst a = 1;");
  assert(s.needsReparse, "a structure reparse is deferred");
  s.reparse();
  assert(!s.needsReparse, "reparse clears the deferred flag");
});

Deno.test("editor: opening a block comment re-colours the following lines live", () => {
  const { src } = memSource();
  const s = editSession("const a = 1;\nconst b = 2;\n", src);
  press(s, "e"); // reveal at (0,0)
  type(s, "/* "); // open an (unterminated) block comment at the top
  // Line 1 is now inside the comment — re-coloured immediately, no reparse. A
  // per-line patch would leave `const` on line 1 still keyword-coloured.
  const line1 = s.doc.lines[1];
  assert(
    !line1.spans.some((sp) => sp.cls === "storageKeyword"),
    "`const` on line 1 is inside the comment, not a keyword",
  );
  assert(
    line1.spans.some((sp) => sp.cls === "comment"),
    `line 1 should be comment-coloured: ${line1.spans.map((x) => x.cls)}`,
  );
});

Deno.test("editor: live re-highlighting stays consistent across newlines and joins", () => {
  const { src } = memSource();
  const s = editSession("alpha\nbeta\ngamma\n", src);
  press(s, "e", "down"); // reveal, move to line 1
  press(s, "end"); // end of "beta"
  type(s, "X"); // betaX
  press(s, "enter"); // split after betaX
  type(s, "mid");
  // Every line's spans reconstruct its text, and the document matches the edits.
  for (const line of s.doc.lines) assertEquals(spanText(line), line.text);
  assertEquals(s.doc.text, "alpha\nbetaX\nmid\ngamma\n");
  assertEquals(s.doc.lines.length, 5); // 4 lines + the split adds one
});

Deno.test("editor: a deferred reparse matches a full parse of the edited text", () => {
  const { src } = memSource();
  const s = editSession("const a = 1;\n", src);
  press(s, "e"); // reveal at (0,0)
  press(s, "end"); // end of line 0
  press(s, "enter"); // structural edit: add a line
  type(s, "function helper() {}");
  s.reparse();
  const fresh = parseDocument(s.doc.text, "mem.ts");
  assertEquals(
    s.doc.flatStructure.map((n) => n.label),
    fresh.flatStructure.map((n) => n.label),
    "reparsed structure matches a full parse of the edited text",
  );
});

Deno.test("editor: the status line shows edit hints while the cursor is active", () => {
  const { src } = memSource();
  const s = editSession("hello\nworld\n", src);
  assertEquals(s.view().editHint, null, "no hint before editing");
  press(s, "e"); // reveal the cursor
  const hints = s.view().editHint ?? [];
  const keys = hints.map((h) => h.key).join(" ");
  const labels = hints.map((h) => h.label.toLowerCase()).join(" ");
  assert(keys.includes("Esc"), `hint should mention Esc: ${keys}`);
  assert(labels.includes("search"), `hint should mention search: ${labels}`);
  press(s, "escape"); // hide the cursor
  assertEquals(s.view().editHint, null, "hint gone once editing stops");
});

Deno.test("editor: Ctrl-S searches and lands the cursor on the match", () => {
  const { src } = memSource();
  const s = editSession("alpha\nbeta target\ngamma\n", src);
  press(s, "e"); // reveal at (0,0)
  s.handleKey({ name: "ctrl-s" });
  type(s, "target");
  assertEquals(s.view().inputLine, "/target", "search input is shown");
  press(s, "enter");
  // The cursor moved onto "target" (line 1, column 5), ready to edit there.
  assertEquals(s.view().cursor, { line: 1, col: 5 });
});

Deno.test("editor: line numbers stay on while editing", () => {
  const { src } = memSource();
  const s = editSession("aaaa\nbbbb\ncccc\n", src);
  s.handleKey({ name: "#", char: "#" }); // pager mode: line numbers → input
  press(s, "e"); // reveal the cursor to edit
  press(s, "right", "right"); // move → ensureCursorVisible → the gutter width
  assert(s.view().showLineNumbers, "line numbers remain on while editing");
  assertEquals(s.view().lineNumbers?.[0], 1, "input line 1");
});
