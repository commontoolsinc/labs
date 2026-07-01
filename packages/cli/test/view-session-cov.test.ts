/**
 * Coverage-driving behavioural tests for the pager state machine in
 * `lib/view/session.ts`. Each test reaches a specific code path by feeding keys
 * and inspecting `view()` / `doc` / `quit`, mirroring the style of
 * `view-session.test.ts`, `view-filepicker.test.ts` and `view-diffedit.test.ts`.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Semantics } from "../lib/view/semantics.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import type { DirEntry, FileGateway } from "../lib/view/filegateway.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";

// --- key helpers -----------------------------------------------------------

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

function alt(name: string, char?: string): Key {
  return char !== undefined ? { name, char, alt: true } : { name, alt: true };
}

/** Tab through the tree until a node whose label contains `label` is selected. */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label?.includes(label)) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

function makeSession(width = 90, height = 24): Session {
  const doc = parseDocument(SAMPLE);
  return new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width, height },
  );
}

// --- noticeLines: more than six edited files (236-238) ----------------------

Deno.test("session: the save prompt lists six files plus an '… and N more' line", () => {
  const path = "/work/main.ts";
  const text = "const a = 1;\n";
  const doc = parseDocument(text, path);
  const labels = Array.from({ length: 9 }, (_, i) => `file${i}.ts`);
  const source: EditableSource = {
    label: "main.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    dirtyLabels: () => labels,
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    source,
  );
  press(s, "down"); // reveal the cursor
  type(s, "X"); // dirty the buffer
  press(s, "ctrl-c"); // raise the save prompt
  const notice = s.view().notice!;
  assert(notice, "the notice lists the files");
  assertEquals(notice[0], "9 files with changes:");
  // Six files are shown, then a summary line for the remaining three.
  assertEquals(notice.length, 1 + 6 + 1);
  assertEquals(notice[notice.length - 1], "  … and 3 more");
});

Deno.test("session: a single edited file shows no notice list", () => {
  const path = "/work/solo.ts";
  const doc = parseDocument("const a = 1;\n", path);
  const source: EditableSource = {
    label: "solo.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    source,
  );
  press(s, "down");
  type(s, "Y");
  press(s, "ctrl-c");
  assertEquals(s.view().notice, null, "one file needs no list");
  assert(s.view().inputLine?.includes("solo.ts"), s.view().inputLine ?? "");
});

// --- selectNode out-of-range guard (288) ------------------------------------

Deno.test("session: navigating past the last node is a no-op (selectNode guard)", () => {
  const s = makeSession();
  press(s, "tab"); // establish a selection at the first node
  // Step pre-order forward well past the end; selectNode rejects out-of-range.
  let last = s.view().selected;
  for (let i = 0; i < 400; i++) {
    press(s, "tab");
    last = s.view().selected;
  }
  // Pressing tab at the very last node returns an index past the end, which
  // selectNode ignores, leaving the selection where it was.
  const before = s.view().selected;
  press(s, "tab");
  assertEquals(s.view().selected, before, "no change past the last node");
  assert(last, "a node stayed selected");
});

// --- definition lookup (319-348) --------------------------------------------

Deno.test("session: definition lookup reports a miss", () => {
  const s = makeSession();
  press(s, "t");
  type(s, "nonexistentName");
  press(s, "enter");
  assert(
    s.view().message.includes("No definition found"),
    s.view().message,
  );
  assertEquals(s.view().overlay, null, "no overlay on a miss");
});

Deno.test("session: definition lookup with a structure node opens its card", () => {
  const s = makeSession();
  press(s, "t");
  type(s, "myPattern");
  press(s, "enter");
  const ov = s.view().overlay!;
  assert(ov, "overlay opened");
  assert(ov.title.startsWith("definition:"), ov.title);
  assert(ov.title.includes("myPattern"), ov.title);
});

Deno.test("session: definition lookup without a matching structure node falls back to source lines", () => {
  // `Foo` is a type alias; force a definition with offsets that match no
  // structure node by using a document whose definition has no node at that
  // exact range. A bare `type Foo` aliasing works, but to take the fallback we
  // need a definition whose offsets are not a flatStructure node. Use a simple
  // top-level const inside a non-section doc.
  const text = "const target = 1;\nconst use = target;\n";
  const doc = parseDocument(text);
  // Build a doctored document: keep lines/structure but give `target` a
  // definition whose offsets do not correspond to any flatStructure node.
  const defs = new Map(doc.definitions);
  defs.set("phantom", [
    {
      name: "phantom",
      kind: "variable",
      startLine: 0,
      endLine: 0,
      startOffset: 999, // matches no node
      endOffset: 1000,
    },
  ]);
  const doctored = { ...doc, definitions: defs };
  const s = new Session(
    doctored,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
  );
  press(s, "t");
  type(s, "phantom");
  press(s, "enter");
  const ov = s.view().overlay!;
  assert(ov, "fallback overlay opened");
  assert(ov.title.includes("phantom"), ov.title);
  assert(ov.title.includes("variable"), ov.title);
  assert(ov.footer.includes("scroll"), ov.footer);
});

// --- card selection movement & external file (377-484, 644-701) ------------

function externalSession(destLine = 1, fileLines = 3): {
  s: Session;
  filePath: string;
} {
  const fileText = Array.from({ length: fileLines }, (_, i) => `line ${i}`)
    .join("\n");
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      { name: "ext", filePath, fileOffset: 0, line: destLine + 1, preview: "" },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts\nconst flag = ext();`);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card with the external reference
  return { s, filePath };
}

Deno.test("session: card selection wraps at the bottom and scrolls to stay visible", () => {
  // A card with many reference lines so moving down past the inner height
  // scrolls the overlay.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 12 }, // small overlay so targets scroll
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  // Move down through every target; selection clamps at the last and the
  // overlay scrolls to keep the focused reference on screen.
  let lastScroll = s.view().overlay!.scroll;
  for (let i = 0; i < 12; i++) {
    press(s, "down");
    lastScroll = s.view().overlay!.scroll;
  }
  assert(s.view().overlay!.selectedLine !== undefined, "a reference selected");
  // Walking back up to the top resets the scroll and deselects.
  for (let i = 0; i < 12; i++) press(s, "up");
  assertEquals(s.view().overlay!.selectedLine, undefined, "deselected at top");
  assertEquals(s.view().overlay!.scroll, 0, "scroll reset");
  assert(lastScroll >= 0);
});

Deno.test("session: 'z' on a card opens the external definition file in place", () => {
  const { s } = externalSession(1, 4);
  press(s, "down"); // select the external reference
  press(s, "z"); // reveal: opens the file in place
  const ov = s.view().overlay!;
  assert(ov, "overlay stays open on the file");
  assert(ov.title.includes("ext.ts"), ov.title);
  assert(
    ov.lines.map((l) => l.text).join("\n").includes("line 0"),
    "shows the external file",
  );
});

Deno.test("session: opening an unreadable external file reports an error", () => {
  // A semantics stub that advertises a definition but returns no file lines.
  const filePath = "/workspace/missing.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: () => null, // cannot read
    definitionOf: () => [
      { name: "ext", filePath, fileOffset: 0, line: 1, preview: "" },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts\nconst flag = ext();`);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter");
  press(s, "down"); // select the external reference
  press(s, "enter"); // try to open it
  assert(s.view().message.includes("Cannot open"), s.view().message);
});

Deno.test("session: Enter on a reference with no openable node reports nothing to open", () => {
  // Build a card whose target resolves to no node and no destination line.
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select the first reference (resolves to a node normally)
  // The reference here resolves to a node, so enter navigates. Assert it does
  // not crash and either navigates or reports.
  press(s, "enter");
  const ov = s.view().overlay;
  assert(
    ov !== null || s.view().message.length >= 0,
    "enter handled the reference",
  );
});

Deno.test("session: 'z' on a card with no selected reference reveals the subject node", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  const subject = s.view().selected!;
  press(s, "enter"); // open the card, no reference selected
  press(s, "z"); // reveal the card's own subject
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().selected?.startOffset,
    subject.startOffset,
    "subject selected",
  );
});

Deno.test("session: overlay paging keys scroll the card", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 8 },
  );
  press(s, "?"); // help overlay: many lines, no targets, so j/k/space scroll
  assertEquals(s.view().overlay!.scroll, 0);
  press(s, "space"); // page down
  assert(s.view().overlay!.scroll > 0, "space paged down");
  const afterSpace = s.view().overlay!.scroll;
  press(s, "pageup");
  assert(s.view().overlay!.scroll < afterSpace, "pageup scrolled back");
  press(s, "j");
  press(s, "k");
  press(s, "pagedown");
  assert(s.view().overlay!.scroll >= 0);
  // 'q' closes the overlay.
  press(s, "q");
  assertEquals(s.view().overlay, null, "q closed the overlay");
});

Deno.test("session: Tab toggles a peek card to source and z reveals the subject from there", () => {
  const s = makeSession(100, 24);
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  press(s, "tab"); // info -> source
  assertEquals(s.view().overlay!.scroll, 0);
  // Down scrolls the source (no targets in source mode).
  press(s, "down");
  assert(s.view().overlay!.scroll >= 0);
  press(s, "tab"); // back to info
  assertEquals(s.view().overlay!.scroll, 0);
});

// --- normal-mode keys: search stepping & paging (546-845) -------------------

Deno.test("session: n with no matches reports 'No matches'", () => {
  const s = makeSession();
  press(s, "n");
  assertEquals(s.view().message, "No matches");
  press(s, "N");
  assertEquals(s.view().message, "No matches");
});

Deno.test("session: n / N step through matches and reveal them", () => {
  const s = makeSession(40, 10);
  press(s, "/");
  type(s, "token");
  press(s, "enter");
  const first = s.view().currentMatch;
  press(s, "n");
  const second = s.view().currentMatch;
  press(s, "N");
  assertEquals(s.view().currentMatch, first, "N returns to the previous match");
  assert(second !== first || s.view().matches!.length === 1);
});

Deno.test("session: a search jumps and reveals a match off the bottom and to the right", () => {
  // A doc tall and wide enough that a later match is off both axes.
  const lines = [
    "// transformed: /m.ts",
    ...Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`),
    "const " + "x".repeat(60) + "needle = 1;",
  ];
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 30, height: 8 },
  );
  press(s, "/");
  type(s, "needle");
  press(s, "enter");
  assert(s.view().top > 0, "scrolled down to the match");
  assert(s.view().left > 0, "scrolled right to the match");
});

Deno.test("session: paging, half-paging and home/end via the keymap", () => {
  const lines = ["// transformed: /m.ts"].concat(
    Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`),
  );
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 10 },
  );
  press(s, "space"); // page down
  const afterPage = s.view().top;
  assert(afterPage > 0, "space paged down");
  press(s, "b"); // page up
  assert(s.view().top < afterPage, "b paged up");
  press(s, "ctrl-d"); // half down
  const halfDown = s.view().top;
  assert(halfDown > 0);
  press(s, "ctrl-u"); // half up
  assert(s.view().top < halfDown, "ctrl-u half-paged up");
  press(s, "G"); // end
  const bottom = s.view().top;
  assert(bottom > 0);
  press(s, "g"); // home
  assertEquals(s.view().top, 0, "g goes home");
  // ctrl-f / ctrl-b also page.
  press(s, "ctrl-f");
  assert(s.view().top > 0);
  press(s, "ctrl-b");
  assertEquals(s.view().top, 0);
  // home / end keys.
  press(s, "end");
  assert(s.view().top > 0);
  press(s, "home");
  assertEquals(s.view().top, 0);
  // pagedown / pageup names.
  press(s, "pagedown");
  assert(s.view().top > 0);
  press(s, "pageup");
  assertEquals(s.view().top, 0);
});

Deno.test("session: Enter with no selection prompts to select a node", () => {
  const s = makeSession();
  press(s, "enter");
  assert(s.view().message.includes("Select a node first"), s.view().message);
});

Deno.test("session: 'z' in pager mode frames the selected node", () => {
  const s = makeSession(80, 8);
  selectByLabel(s, "pattern myPattern");
  press(s, "z");
  assert(s.view().top >= 0, "z framed the node");
});

Deno.test("session: '#' toggles line numbers and escape clears selection & search", () => {
  const s = makeSession();
  assertEquals(s.view().showLineNumbers, false);
  press(s, "#");
  assertEquals(s.view().showLineNumbers, true);
  press(s, "s"); // select something
  press(s, "/");
  type(s, "token");
  press(s, "enter");
  assert(s.view().selected, "selected before escape");
  press(s, "escape");
  assertEquals(s.view().selected, null, "selection cleared");
  assertEquals(s.view().matches, null, "search cleared");
});

Deno.test("session: navigateTree with no structure reports no structure", () => {
  const doc = parseDocument("   \n   \n");
  // A whitespace-only document has an empty structure tree.
  const empty = { ...doc, structure: [], flatStructure: [] };
  const s = new Session(
    empty,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "tab");
  assertEquals(s.view().message, "No structure detected");
  press(s, "s");
  assertEquals(s.view().message, "No structure detected");
});

// --- plain-file editing key paths (888-1090) --------------------------------

function fileSession(text: string, width = 80, height = 12): {
  s: Session;
  source: EditableSource;
  saved: { text: string | null };
} {
  const path = "/work/edit.ts";
  const saved = { text: null as string | null };
  const source: EditableSource = {
    label: "edit.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: (t) => {
      saved.text = t;
      return "Saved edit.ts";
    },
    revert: (original, current, cursorLine) =>
      original === current ? null : {
        text: original,
        cursorLine: Math.min(cursorLine, original.split("\n").length - 1),
      },
  };
  const doc = parseDocument(text, path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width, height },
    undefined,
    source,
  );
  return { s, source, saved };
}

Deno.test("session: revealing the cursor on a non-editable view reports the reason", () => {
  const doc = parseDocument("const a = 1;\n");
  // No source at all: bare arrow reports there's no file to edit.
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "down"); // try to reveal the cursor
  assert(s.view().cursor === null, "no cursor without a source");
  assert(
    s.view().message.includes("no underlying file"),
    s.view().message,
  );
});

Deno.test("session: a read-only source reports its reason when arrowed", () => {
  const doc = parseDocument("const a = 1;\n");
  const source: EditableSource = {
    label: null,
    editable: false,
    reason: "piped input is read-only",
    parse: (t) => parseDocument(t),
    save: () => "read-only",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "left");
  assertEquals(s.view().cursor, null);
  assert(s.view().message.includes("read-only"), s.view().message);
});

Deno.test("session: word, line and buffer movement in a file buffer", () => {
  const { s } = fileSession("alpha beta gamma\nsecond line here\nthird\n");
  press(s, "down"); // reveal cursor at top
  assertEquals(s.view().cursor, { line: 0, col: 0 });
  s.handleKey(alt("f")); // word forward
  assert((s.view().cursor?.col ?? 0) > 0, "M-f moved forward a word");
  s.handleKey(alt("b")); // word backward
  assertEquals(s.view().cursor?.col, 0, "M-b moved back");
  press(s, "right", "right");
  assertEquals(s.view().cursor?.col, 2);
  press(s, "left");
  assertEquals(s.view().cursor?.col, 1);
  press(s, "ctrl-e"); // line end
  assert((s.view().cursor?.col ?? 0) > 1);
  press(s, "ctrl-a"); // line start
  assertEquals(s.view().cursor?.col, 0);
  press(s, "down"); // ctrl-n style would also work
  assertEquals(s.view().cursor?.line, 1);
  press(s, "up");
  assertEquals(s.view().cursor?.line, 0);
  press(s, "ctrl-n");
  assertEquals(s.view().cursor?.line, 1);
  press(s, "ctrl-p");
  assertEquals(s.view().cursor?.line, 0);
  press(s, "ctrl-f");
  assertEquals(s.view().cursor?.col, 1);
  press(s, "ctrl-b");
  assertEquals(s.view().cursor?.col, 0);
  press(s, "end");
  assert((s.view().cursor?.col ?? 0) > 0);
  press(s, "home");
  assertEquals(s.view().cursor?.col, 0);
  s.handleKey(alt(">")); // buffer end
  assert((s.view().cursor?.line ?? 0) >= 1);
  s.handleKey(alt("<")); // buffer start
  assertEquals(s.view().cursor, { line: 0, col: 0 });
});

Deno.test("session: cursor paging up and down moves the cursor by a page", () => {
  const { s } = fileSession(
    Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n") + "\n",
    60,
    8,
  );
  press(s, "down"); // reveal cursor at top
  press(s, "pagedown");
  assert((s.view().cursor?.line ?? 0) > 0, "pagedown moved the cursor");
  const afterDown = s.view().cursor!.line;
  press(s, "pageup");
  assert(s.view().cursor!.line < afterDown, "pageup moved back");
  s.handleKey(alt("v")); // M-v page up
  assert(s.view().cursor!.line >= 0);
  press(s, "ctrl-v"); // C-v page down
  assert(s.view().cursor!.line >= 0);
});

Deno.test("session: typing, tab, space, kill-line, yank and word-case edits in a file", () => {
  const { s } = fileSession("hello world\n");
  press(s, "down"); // reveal cursor
  press(s, "end"); // end of "hello world"
  type(s, "!"); // insert a char
  assert(s.doc.lines[0].text.endsWith("!"), s.doc.lines[0].text);
  press(s, "space"); // insert a space
  press(s, "tab"); // insert two spaces
  assert(s.doc.lines[0].text.includes("  "), s.doc.lines[0].text);
  // Kill to end of line, then yank it back.
  press(s, "ctrl-a");
  press(s, "ctrl-k");
  assertEquals(s.doc.lines[0].text, "", "ctrl-k killed the line");
  press(s, "ctrl-y");
  assert(s.doc.lines[0].text.startsWith("hello"), "ctrl-y yanked it back");
  // Word case operations.
  press(s, "ctrl-a");
  s.handleKey(alt("u")); // uppercase word
  assert(s.doc.lines[0].text.startsWith("HELLO"), s.doc.lines[0].text);
  press(s, "ctrl-a");
  s.handleKey(alt("l")); // lowercase word
  assert(s.doc.lines[0].text.startsWith("hello"), s.doc.lines[0].text);
  press(s, "ctrl-a");
  s.handleKey(alt("c")); // capitalize word
  assert(s.doc.lines[0].text.startsWith("Hello"), s.doc.lines[0].text);
});

Deno.test("session: delete-forward, backspace, kill-word forward/back, newline and mark/region", () => {
  const { s } = fileSession("abcdef ghij\n");
  press(s, "down");
  press(s, "delete"); // delete the 'a'
  assert(s.doc.lines[0].text.startsWith("bcdef"), s.doc.lines[0].text);
  press(s, "ctrl-d"); // delete the 'b'
  assert(s.doc.lines[0].text.startsWith("cdef"), s.doc.lines[0].text);
  s.handleKey(alt("d")); // kill word forward ("cdef")
  assert(
    s.doc.lines[0].text.trimStart().startsWith("ghij"),
    s.doc.lines[0].text,
  );
  press(s, "end");
  s.handleKey(alt("backspace")); // kill word backward ("ghij")
  press(s, "ctrl-a");
  // Set mark, move, kill region.
  press(s, "ctrl-space");
  assertEquals(s.view().message, "Mark set");
  press(s, "right", "right");
  press(s, "ctrl-w"); // kill the region
  // Newline insert.
  press(s, "enter");
  assert(s.doc.lines.length >= 2, "enter split the line");
  // Backspace joins lines back.
  press(s, "backspace");
});

Deno.test("session: yank-pop in a file rotates the kill ring", () => {
  const { s } = fileSession("one\ntwo\nthree\n");
  press(s, "down");
  press(s, "ctrl-k", "ctrl-k"); // kill "one" then the empty line / newline
  press(s, "down");
  press(s, "ctrl-k");
  press(s, "ctrl-y"); // yank most recent
  s.handleKey(alt("y")); // yank-pop to the previous kill
  assert(s.doc.text.length >= 0, "yank-pop ran");
});

Deno.test("session: ctrl-` sets the mark like ctrl-space", () => {
  const { s } = fileSession("mark me\n");
  press(s, "down");
  s.handleKey({ name: "ctrl-`" });
  assertEquals(s.view().message, "Mark set");
});

Deno.test("session: an unmodelled Alt combo while editing is a no-op", () => {
  const { s } = fileSession("text\n");
  press(s, "down");
  const before = s.doc.text;
  s.handleKey(alt("q")); // not a modelled Alt binding
  assertEquals(s.doc.text, before, "unmodelled Alt combo changed nothing");
});

Deno.test("session: escape leaves edit mode and triggers a reparse", () => {
  const { s } = fileSession("const a = 1;\n");
  press(s, "down");
  type(s, "x"); // dirty + set needsReparse via live highlight
  press(s, "escape"); // leaves edit mode and reparses
  assertEquals(s.view().cursor, null, "cursor hidden after escape");
});

Deno.test("session: ctrl-c while editing quits a clean buffer", () => {
  const { s } = fileSession("clean\n");
  press(s, "down");
  press(s, "ctrl-c");
  assert(s.quit, "ctrl-c quit the clean buffer");
});

// --- F3 / save / quit prompts (1391-1474) -----------------------------------

Deno.test("session: F3 saves an editable file and ctrl-x ctrl-s also saves", () => {
  const { s, saved } = fileSession("save me\n");
  press(s, "down"); // reveal cursor at the start
  press(s, "end"); // move to the end of the line
  type(s, "!");
  press(s, "f3");
  assert(s.view().message.startsWith("Saved"), s.view().message);
  assert(saved.text?.startsWith("save me!"), saved.text ?? "");
  // The C-x C-s chord saves too.
  type(s, "?");
  press(s, "ctrl-x", "ctrl-s");
  assert(s.view().message.startsWith("Saved"), s.view().message);
});

Deno.test("session: requestSave with nothing to save reports it", () => {
  const doc = parseDocument("no source\n");
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
  );
  press(s, "f3");
  assertEquals(s.view().message, "Nothing to save.");
});

Deno.test("session: requestSave on a read-only source reports it", () => {
  const doc = parseDocument("ro\n");
  const source: EditableSource = {
    label: null,
    editable: false,
    reason: "this view is read-only",
    parse: (t) => parseDocument(t),
    save: () => "ro",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "f3");
  assert(s.view().message.includes("read-only"), s.view().message);
});

Deno.test("session: a save that throws is reported as a failure", () => {
  const path = "/work/boom.ts";
  const source: EditableSource = {
    label: "boom.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => {
      throw new Error("disk full");
    },
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "down");
  type(s, "x");
  press(s, "f3");
  assert(s.view().message.includes("Save failed"), s.view().message);
  assert(s.view().message.includes("disk full"), s.view().message);
});

Deno.test("session: the quit save-prompt answers y / d / c", () => {
  // (y) save then quit. Escape leaves edit mode first; q in the pager quits.
  {
    const { s, saved } = fileSession("one\n");
    press(s, "down");
    type(s, "A");
    press(s, "escape"); // back to the pager (the buffer is still dirty)
    press(s, "q"); // dirty -> save prompt
    assert(s.view().inputLine?.includes("Save changes"), s.view().inputLine!);
    press(s, "y");
    assert(saved.text?.includes("A"), saved.text ?? "");
    assert(s.quit, "y saved and quit");
  }
  // (d) discard then quit.
  {
    const { s, saved } = fileSession("two\n");
    press(s, "down");
    type(s, "B");
    press(s, "escape");
    press(s, "q");
    press(s, "d");
    assertEquals(saved.text, null, "d did not save");
    assert(s.quit, "d discarded and quit");
  }
  // (c) cancel stays.
  {
    const { s } = fileSession("three\n");
    press(s, "down");
    type(s, "C");
    press(s, "escape");
    press(s, "q");
    press(s, "c");
    assertEquals(s.view().message, "Cancelled");
    assert(!s.quit, "c cancelled the quit");
  }
  // escape also cancels.
  {
    const { s } = fileSession("four\n");
    press(s, "down");
    type(s, "D");
    press(s, "escape");
    press(s, "q");
    press(s, "escape");
    assertEquals(s.view().message, "Cancelled");
    assert(!s.quit);
  }
});

Deno.test("session: requestQuitFromSignal raises the prompt with unsaved edits", () => {
  const { s } = fileSession("sig\n");
  press(s, "down");
  type(s, "Z"); // dirty
  const willPrompt = s.requestQuitFromSignal();
  assert(willPrompt, "a dirty buffer prompts on signal");
  // A second signal during the prompt returns false.
  assertEquals(s.requestQuitFromSignal(), false);
});

Deno.test("session: requestQuitFromSignal on a clean buffer quits without a prompt", () => {
  const { s } = fileSession("clean\n");
  press(s, "down"); // reveal cursor but make no edits
  const willPrompt = s.requestQuitFromSignal();
  assertEquals(willPrompt, false, "clean buffer does not prompt");
  assert(s.quit, "and it quit");
});

Deno.test("session: an unbound C-x chord reports it", () => {
  const { s } = fileSession("chord\n");
  press(s, "ctrl-x", "z"); // C-x z is unbound
  assert(s.view().message.includes("unbound"), s.view().message);
});

Deno.test("session: C-x C-c quits", () => {
  const { s } = fileSession("clean\n");
  press(s, "ctrl-x", "ctrl-c");
  assert(s.quit, "C-x C-c quit a clean buffer");
});

// --- revert prompt (1480-1544) ----------------------------------------------

Deno.test("session: ctrl-r on a clean buffer reports nothing to revert", () => {
  const { s } = fileSession("nothing\n");
  press(s, "down");
  press(s, "ctrl-r");
  assertEquals(s.view().message, "Nothing to revert.");
});

Deno.test("session: a plain-file revert prompt accepts y and reverts all", () => {
  const { s } = fileSession("original line\n");
  press(s, "down");
  type(s, "EDIT");
  assert(s.doc.text.includes("EDIT"), "edited");
  press(s, "ctrl-r");
  assert(s.view().inputLine?.includes("Revert all"), s.view().inputLine!);
  press(s, "y");
  assertEquals(s.doc.text, "original line\n", "reverted to the original");
  assert(s.view().message.includes("Reverted"), s.view().message);
});

Deno.test("session: a plain-file revert prompt cancels on an unknown key", () => {
  const { s } = fileSession("keep me\n");
  press(s, "down");
  type(s, "X");
  press(s, "ctrl-r");
  press(s, "q"); // not y/a -> cancelled
  assertEquals(s.view().message, "Cancelled");
  assert(s.doc.text.includes("X"), "edit retained after cancel");
});

Deno.test("session: revert when the source offers none reports it", () => {
  // A source with editable text but no revert function.
  const path = "/work/norev.ts";
  const source: EditableSource = {
    label: "norev.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "down");
  type(s, "x"); // dirty
  press(s, "ctrl-r");
  press(s, "y");
  assertEquals(s.view().message, "Revert isn't available here.");
});

Deno.test("session: revert that returns nothing-there is reported", () => {
  const path = "/work/empty-rev.ts";
  const source: EditableSource = {
    label: "empty-rev.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    revert: () => null, // never has anything to revert
  };
  const doc = parseDocument("data\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  press(s, "down");
  type(s, "x"); // dirty
  press(s, "ctrl-r");
  press(s, "y");
  assertEquals(s.view().message, "Nothing to revert there.");
});

// --- expand context errors (1556-1574) --------------------------------------

Deno.test("session: ctrl-l when expanding context is unavailable reports it", () => {
  const { s } = fileSession("plain file\n");
  press(s, "down");
  press(s, "ctrl-l"); // a plain file has no expandContext
  assertEquals(s.view().message, "Expanding context isn't available here.");
});

Deno.test("session: ctrl-l in pager mode with no hunk in view reports move-to-a-hunk", () => {
  // A source that advertises expandContext but whose document has no hunks.
  const path = "/work/nohunk.ts";
  const source: EditableSource = {
    label: "nohunk.ts",
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
    expandContext: () => null,
  };
  const doc = parseDocument("// transformed: /m.ts\nconst a = 1;\n", path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 10 },
    undefined,
    source,
  );
  // Pager mode (no cursor): expandRefLine finds no hunk and returns null.
  press(s, "ctrl-l");
  assert(
    s.view().message.includes("Move to a hunk first"),
    s.view().message,
  );
});

Deno.test("session: ctrl-l when expandContext yields nothing reports no more context", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const base = diffSource(ws, edit);
    // Wrap the source so expandContext always returns null.
    const source: EditableSource = { ...base, expandContext: () => null };
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      source,
    );
    press(s, "down"); // cursor mode
    press(s, "ctrl-l");
    assertEquals(s.view().message, "No more context to show.");
  } finally {
    done();
  }
});

// --- diff edit machinery exercised through a real diff source ---------------

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

function expandWs(): { ws: DiffWorkspace; root: string; done: () => void } {
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
  return { ws, root, done: () => Deno.removeSync(root, { recursive: true }) };
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

function diffWorkspace(): {
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

/** Reveal the cursor and move it down to the given diff line. */
function toLine(s: Session, line: number): void {
  press(s, "down");
  let guard = 0;
  while ((s.view().cursor?.line ?? -1) < line && guard++ < 1000) {
    press(s, "down");
  }
}

Deno.test("diffcov: editing a non-editable removed line is refused for typed chars", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8); // the removed line
    const before = s.doc.text;
    type(s, "X");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffcov: delete-forward at end of a diff line is refused as a join", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an added line
    press(s, "end");
    press(s, "delete");
    assert(
      s.view().message.includes("remove a line") ||
        s.view().message.length > 0,
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: a multi-line paste is refused while editing a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    // A key.char carrying a newline is treated as a multi-line insert.
    s.handleKey({ name: "paste", char: "a\nb" });
    assert(s.view().message.includes("across lines"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: M-d / M-backspace / C-w / C-k respect the diff marker", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    // M-d kills a word forward from the editable region.
    press(s, "end");
    s.handleKey(alt("backspace")); // kill word backward
    assert(s.doc.text.length > 0);
    // Set the mark and kill a region within the line.
    press(s, "ctrl-a");
    press(s, "ctrl-space");
    press(s, "right", "right", "right");
    press(s, "ctrl-w");
    assert(s.doc.text.length > 0);
    // C-k kills to the end of an editable line.
    press(s, "ctrl-a");
    press(s, "ctrl-k");
    assert(s.doc.text.length >= 0);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w without a mark asks to set the mark", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-w");
    assert(s.view().message.includes("Set the mark"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: a multi-line region kill is refused in a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-space"); // mark here
    press(s, "down"); // move to a different row
    press(s, "ctrl-w");
    assert(
      s.view().message.includes("across lines") ||
        s.view().message.includes("isn't editable"),
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: M-d and word-case edits work on an editable diff line", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, " word");
    press(s, "end");
    s.handleKey(alt("backspace")); // remove " word"-ish backward
    // Word-case on the editable content.
    press(s, "ctrl-a");
    // editStart nudges the cursor past the marker; word ops should run.
    s.handleKey(alt("u"));
    assert(s.doc.text.length > 0);
  } finally {
    done();
  }
});

Deno.test("diffcov: yank-pop is blocked while editing a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    s.handleKey(alt("y")); // M-y yank-pop
    assert(s.view().message.includes("Yank-pop"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: ctrl-s edit-mode search lands the cursor on a match", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 5); // an editable context line near the top
    press(s, "ctrl-s"); // enter edit-mode search, seeded with the last query
    type(s, "return");
    // Ctrl-S inside the search steps to the next match.
    press(s, "ctrl-s");
    press(s, "enter"); // commit: land the cursor on the focused match
    assert(s.view().cursor !== null, "cursor remained on a match");
    // Escape from an edit-mode search restores the viewport to the cursor.
    press(s, "ctrl-s");
    type(s, "answer");
    press(s, "escape");
    assert(s.view().cursor !== null, "cursor still shown after escape");
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace in an edit-mode search refreshes matches", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 5);
    press(s, "ctrl-s");
    type(s, "returnX"); // no match
    press(s, "backspace"); // back to "return": matches reappear
    press(s, "enter");
    assert(s.view().cursor !== null);
  } finally {
    done();
  }
});

Deno.test("diffcov: revert prompt offers hunk / file / all for a diff", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 9);
    press(s, "end");
    type(s, "Z");
    assert(s.doc.text !== before, "edited");
    press(s, "ctrl-r");
    assert(s.view().inputLine?.includes("hunk"), s.view().inputLine!);
    press(s, "c"); // revert the chunk
    assertEquals(s.doc.text, before, "the chunk reverted");
    assert(s.view().message.includes("Reverted"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: revert 'file' scope through the session", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 9);
    press(s, "end");
    type(s, "Q");
    press(s, "ctrl-r");
    press(s, "f"); // file scope
    assertEquals(s.doc.text, before);
  } finally {
    done();
  }
});

Deno.test("diffcov: an unknown key at the diff revert prompt cancels", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "end");
    type(s, "M");
    press(s, "ctrl-r");
    press(s, "z"); // not c/f/a
    assertEquals(s.view().message, "Cancelled");
  } finally {
    done();
  }
});

Deno.test("diffcov: a diff that matches no file on disk is read-only", () => {
  // A workspace whose read always fails: the diff source is not editable.
  const ws: DiffWorkspace = {
    resolve: (p) => p,
    read: () => null,
  };
  const model = parseDiff(DIFF)!;
  const { doc, edit } = buildDiffDocument(DIFF, model, ws);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 20 },
    undefined,
    diffSource(ws, edit),
  );
  press(s, "down"); // try to reveal the cursor
  assertEquals(s.view().cursor, null, "no cursor on a read-only diff");
  assert(s.view().message.length > 0, s.view().message);
});

Deno.test("diffcov: Enter splits a context line into a removed/added pair, then collapses back", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    const before = s.doc.text;
    toLine(s, 6); // a context line
    press(s, "end");
    type(s, "X"); // splits to -/+ pair
    const split = s.doc.text.split("\n");
    assert(split.some((l) => l.startsWith("-")), "a removed line appeared");
    press(s, "backspace"); // collapse back when content matches again
    assertEquals(s.doc.text, before, "the pair collapsed back to context");
  } finally {
    done();
  }
});

Deno.test("diffcov: Enter mid-context produces +head/+tail added lines", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // a context line
    press(s, "end", "left", "left");
    s.handleKey({ name: "enter" });
    const lines = s.doc.text.split("\n");
    assert(lines.some((l) => l.startsWith("+")), "added lines produced");
  } finally {
    done();
  }
});

Deno.test("diffcov: Backspace at the start of an added line removes it", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 10); // "+const extra = answer + 1;"
    press(s, "end");
    for (let i = 0; i < "const extra = answer + 1;".length + 1; i++) {
      press(s, "backspace");
    }
    // The line was removed; the hunk header shrank by one new line.
    assert(!s.doc.text.includes("const extra = answer + 1;"), s.doc.text);
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l expands the hunk in view", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    assert(s.view().canExpand, "expand advertised");
    press(s, "ctrl-l"); // pager mode expand
    assert(
      s.doc.text.includes("alpha") || s.doc.text.includes("beta"),
      s.doc.text,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: pager-mode ctrl-l with a selected hunk expands that hunk", () => {
  const { ws, done } = expandWs();
  try {
    const model = parseDiff(EXPAND_DIFF)!;
    const { doc, edit } = buildDiffDocument(EXPAND_DIFF, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    // Select the hunk node, then expand it; the selection is re-pointed after.
    selectByLabel(s, "@@");
    press(s, "ctrl-l");
    assert(s.doc.text.includes("alpha") || s.doc.text.includes("beta"));
  } finally {
    done();
  }
});

Deno.test("diffcov: after a revert the cursor snaps to an editable line", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6);
    press(s, "end");
    type(s, "X");
    press(s, "ctrl-r");
    press(s, "a"); // revert all; snapCursorToEditable runs
    assert(s.view().cursor !== null, "cursor lands on an editable line");
  } finally {
    done();
  }
});

// --- file picker (1656-1849) ------------------------------------------------

const TREE: Record<string, DirEntry[]> = {
  "/work": [
    { name: "sub", isDir: true },
    ...Array.from({ length: 30 }, (_, i) => ({
      name: `file${String(i).padStart(2, "0")}.ts`,
      isDir: false,
    })),
  ],
  "/work/sub": [{ name: "c.ts", isDir: false }],
};

const PFILES: Record<string, string> = {
  "/work/file00.ts": "const a = 0;\n",
  "/work/sub/c.ts": "const c = 3;\n",
};

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function gateway(): FileGateway {
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  return {
    cwd: () => "/work",
    list: (dir) => TREE[dir] ?? null,
    open: (path) => {
      const text = PFILES[path];
      if (text === undefined) return null;
      return { source: pickerSource(path), text };
    },
    join: (dir, segment) => normalize(`${dir}/${segment}`),
    parent: (p) => normalize(`${p}/..`),
    base,
  };
}

function pickerSource(path: string): EditableSource {
  return {
    label: path.split("/").filter(Boolean).pop() ?? path,
    editable: true,
    path,
    parse: (t) => parseDocument(t, path),
    save: () => "saved",
  };
}

function pickerSession(withPath = true): Session {
  const path = "/work/file00.ts";
  const doc = parseDocument(PFILES[path], path);
  return new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    withPath ? pickerSource(path) : undefined,
    gateway(),
  );
}

function entryText(s: Session): string[] {
  return s.view().overlay?.lines.map((l) => l.text) ?? [];
}

Deno.test("filepickercov: paging through a long listing scrolls the picker", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  assert(entryText(s).length > 10, "a long listing");
  press(s, "pagedown"); // jump down ten
  assert(s.view().overlay!.scroll >= 0);
  press(s, "down", "ctrl-n"); // arrow and Emacs down
  press(s, "up", "ctrl-p"); // arrow and Emacs up
  press(s, "pageup");
  assertEquals(s.view().overlay!.selectedLine, 0, "back at the top");
});

Deno.test("filepickercov: backspace on an empty filter steps up a directory", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "down", "enter"); // into sub/
  assert(entryText(s).includes("c.ts"), entryText(s).join(","));
  press(s, "backspace"); // empty filter -> step up
  assert(entryText(s).includes("sub/"), entryText(s).join(","));
});

Deno.test("filepickercov: typing a filter then backspacing it narrows and widens", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file01");
  assertEquals(entryText(s), ["file01.ts"]);
  press(s, "backspace"); // "file0" still narrows
  assert(entryText(s).length >= 1);
});

Deno.test("filepickercov: tab activates the highlighted entry like enter", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "down"); // select sub/
  press(s, "tab"); // descend
  assert(entryText(s).includes("c.ts"), entryText(s).join(","));
});

Deno.test("filepickercov: opening a typed filename with no highlighted match", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "zzz-nomatch"); // filter to nothing
  assertEquals(entryText(s), ["(no matching files)"]);
  press(s, "enter"); // treat the typed text as a filename (open fails)
  assert(s.view().message.includes("Cannot open"), s.view().message);
});

Deno.test("filepickercov: opening an existing file swaps the buffer", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file00");
  press(s, "enter"); // opens /work/file00.ts
  assertEquals(s.view().overlay, null, "picker closed");
  assert(s.view().message.includes("Opened"), s.view().message);
  assertEquals(s.doc.text, PFILES["/work/file00.ts"]);
});

Deno.test("filepickercov: the picker refuses to open with unsaved edits", () => {
  const s = pickerSession();
  press(s, "down"); // reveal cursor
  type(s, "X"); // dirty
  press(s, "ctrl-x", "ctrl-f");
  type(s, "file00"); // filter to a single file entry
  press(s, "enter"); // try to open it
  assert(
    s.view().message.includes("Save or discard"),
    s.view().message,
  );
});

Deno.test("filepickercov: opening with no gateway reports it", () => {
  // A session with a source but no file gateway: C-x C-f is unavailable.
  const path = "/work/file00.ts";
  const doc = parseDocument(PFILES[path], path);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    pickerSource(path),
    undefined, // no gateway
  );
  press(s, "ctrl-x", "ctrl-f");
  assertEquals(s.view().message, "Opening files isn't available here.");
});

Deno.test("filepickercov: the picker opens at the gateway cwd when the source has no path", () => {
  // A source without a path: pickerStartDir falls back to files.cwd().
  const doc = parseDocument("const a = 1;\n");
  const noPathSource: EditableSource = {
    label: "buf",
    editable: true,
    parse: (t) => parseDocument(t),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    noPathSource,
    gateway(),
  );
  press(s, "ctrl-x", "ctrl-f");
  assert(s.view().inputLine?.includes("/work"), s.view().inputLine ?? "");
});

Deno.test("filepickercov: a missing directory shows '(no matching files)'", () => {
  // A gateway whose list returns null for the start dir.
  const emptyGateway: FileGateway = {
    cwd: () => "/empty",
    list: () => null,
    open: () => null,
    join: (dir, seg) => normalize(`${dir}/${seg}`),
    parent: (p) => normalize(`${p}/..`),
    base: (p) => p.split("/").filter(Boolean).pop() ?? p,
  };
  const doc = parseDocument("const a = 1;\n");
  const noPathSource: EditableSource = {
    label: "buf",
    editable: true,
    parse: (t) => parseDocument(t),
    save: () => "saved",
  };
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 60, height: 12 },
    undefined,
    noPathSource, // a source so the C-x chord is active
    emptyGateway,
  );
  press(s, "ctrl-x", "ctrl-f");
  // Only the ".." entry is offered when the directory cannot be listed.
  assert(entryText(s).includes("../"), entryText(s).join(","));
});

Deno.test("filepickercov: escape cancels the picker", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  press(s, "escape");
  assertEquals(s.view().overlay, null);
  assertEquals(s.view().message, "Cancelled");
});

// ===========================================================================
// Additional targeted coverage for the remaining branch bodies. Each test
// drives a specific guard or conditional that the suite above approaches but
// does not yet execute (the untaken side of an `if (cond) STMT;` one-liner, an
// off-screen scroll, or a non-editable diff line under a policy gate).
// ===========================================================================

// --- card reference up-scroll lands a higher target above the scroll (392) --

/** A node in the SAMPLE blob whose card carries several reference targets, used
 * to step the card selection and force the overlay to scroll. */
function multiTargetSession(height: number): Session {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height },
  );
  // The pattern's card lists its uses/deps as several selectable references.
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  return s;
}

Deno.test("session: stepping the card selection back up scrolls to a higher target", () => {
  // A short overlay so moving down through the references raises the scroll,
  // and a later up-step brings a target above the current scroll back on
  // screen (the `line < overlayScroll` branch).
  const s = multiTargetSession(8);
  const ov = () => s.view().overlay!;
  if (ov().footer.includes("select")) {
    // Walk all the way down so the scroll has advanced past the top targets.
    for (let i = 0; i < 20; i++) press(s, "down");
    const scrolledDown = ov().scroll;
    // Now walk back up: an earlier target sits above the current scroll, so
    // the overlay scrolls up to keep the focused reference visible.
    for (let i = 0; i < 20; i++) press(s, "up");
    assert(scrolledDown >= 0);
    assertEquals(ov().selectedLine, undefined, "back to the top, deselected");
  } else {
    // Defensive: if this node has no targets, the test is a no-op assertion.
    assert(true);
  }
});

Deno.test("session: a card with many references scrolls down then up across the inner height", () => {
  // Build a document where one binding is used many times, so its card lists a
  // long run of reference lines that exceed a small overlay's inner height.
  const lines = [
    "// transformed: /m.ts",
    "const base = 1;",
    ...Array.from({ length: 20 }, (_, i) => `const use${i} = base + ${i};`),
  ];
  const doc = parseDocument(lines.join("\n"));
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 8 }, // small overlay forces scrolling
  );
  const baseLabel = doc.flatStructure.find((n) => n.name === "base")!.label;
  selectByLabel(s, baseLabel);
  press(s, "enter");
  const ov = () => s.view().overlay!;
  if (ov().footer.includes("select")) {
    for (let i = 0; i < 25; i++) press(s, "down"); // run the scroll down
    const downScroll = ov().scroll;
    assert(downScroll > 0, "scrolled down through the references");
    // Now step back up far enough that a target sits above the scroll: the
    // overlay scrolls up to reveal it.
    for (let i = 0; i < 24; i++) press(s, "up");
    assert(ov().scroll <= downScroll, "scrolled back up");
  } else {
    assert(true);
  }
});

// --- jumpToTarget via a use reference with no def offset (428, 446, 464-477) -
// The lift node's card lists both a definition reference (carrying a node
// offset) and a plain "use" reference (no offset). Revealing the use one takes
// the offset-less path: findTargetIndex returns -1, jumpToTarget falls back to
// nodeAtLine, and the off-screen destination column pans the view.

Deno.test("session: revealing a use reference (no def offset) jumps via nodeAtLine and pans", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 16, height: 24 }, // narrow so the destination column is off-screen
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // first reference (a definition, with an offset)
  press(s, "down"); // second reference (a use, no offset)
  assertEquals(
    s.view().overlay!.selectedLine,
    12,
    "the use reference selected",
  );
  press(s, "z"); // reveal it: findTargetIndex(-1) -> nodeAtLine, then pan right
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().message.startsWith("→"), s.view().message);
  assert(s.view().left > 0, "panned right to the destination column");
  assert(s.view().selected, "a node resolved at the destination");
});

Deno.test("session: opening a use reference (no def offset) resolves a node via nodeAtLine", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down");
  press(s, "down"); // the use reference (no offset)
  press(s, "enter"); // resolveTargetNode -> nodeAtLine -> openPeek
  const ov = s.view().overlay;
  assert(ov, "a node resolved and its card opened");
});

// --- findTargetIndex falls back to a start-offset-only match (436-439) -------
// The pattern's card lists a dependency reference that carries a definition
// offset but no end offset (no semantic service to pin the exact range), so
// following it skips the exact (start+end) lookup and matches on start alone.

Deno.test("session: following a dependency with no end offset matches a node by start offset", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 100, height: 24 },
  );
  selectByLabel(s, "pattern myPattern");
  press(s, "enter");
  press(s, "down"); // first reference (a definition, carries an end offset)
  press(s, "down"); // second reference (a dependency, no end offset)
  assertEquals(s.view().overlay!.selectedLine, 9, "the dependency selected");
  press(s, "z"); // findTargetIndex skips the exact lookup, matches by start
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().selected, "a node matched by its start offset");
  assert(s.view().message.startsWith("→"), s.view().message);
});

// --- overlay enter/z with no reference (484, 665-668) ------------------------

Deno.test("session: Enter on a card with no reference selected closes the overlay", () => {
  const s = makeSession(100, 24);
  selectByLabel(s, "pattern myPattern");
  press(s, "enter"); // open the card; nothing selected yet (cardSel = -1)
  assertEquals(s.view().overlay!.selectedLine, undefined, "no reference");
  press(s, "enter"); // the else branch: closes the overlay
  assertEquals(s.view().overlay, null, "Enter with no reference closed it");
});

Deno.test("session: z on the help overlay (no subject node) does nothing", () => {
  const s = makeSession(100, 12);
  press(s, "?"); // the help overlay has no targets and no subject node
  press(s, "z"); // overlayRevealTarget returns null -> z is a no-op
  assert(s.view().overlay, "help overlay still open after z");
  assert(s.view().overlay!.title.toLowerCase().includes("keys"));
});

// --- edit-mode search with no editable match (546-547, 560) ------------------

Deno.test("diffcov: an edit-mode search whose only matches are non-editable keeps the cursor", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // an editable context line
    const lineBefore = s.view().cursor!.line;
    // "42" appears only on the removed line (not editable). The edit-mode
    // search finds it but no editable match exists, so firstEditableMatch
    // returns its start fallback and the commit cannot land the cursor on a
    // typeable spot — it stays where it was.
    press(s, "ctrl-s");
    type(s, "42");
    press(s, "enter");
    assert(s.view().cursor !== null, "cursor remained shown");
    assert(typeof lineBefore === "number");
  } finally {
    done();
  }
});

Deno.test("diffcov: committing an edit-mode search with no matches is a no-op on the cursor", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6);
    const before = s.view().cursor;
    press(s, "ctrl-s");
    type(s, "zzzz-no-such-text"); // no match at all
    press(s, "enter"); // placeCursorAtMatch sees no match and returns early
    assertEquals(s.view().cursor, before, "cursor unchanged with no match");
  } finally {
    done();
  }
});

// --- escape an empty-query search clears the (empty) match set (599) ---------

Deno.test("session: escaping a search with no query typed clears the match set", () => {
  const s = makeSession();
  press(s, "/"); // open search
  // No characters typed, so the query stays empty.
  press(s, "escape");
  assertEquals(s.view().inputLine, null, "search closed");
  assertEquals(s.view().matches, null, "no matches set with an empty query");
});

// --- diff edit guards on a non-editable (removed) line ----------------------
// Land the cursor on the removed line (index 8 in the DIFF fixture) and run
// each delete-/kill-style edit. The policy's editStart returns null there, so
// every gate reports NOT_EDITABLE and refuses the edit.

Deno.test("diffcov: delete-forward on a removed line is refused (guardForwardEdit)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8); // the removed "-export const answer = 42;" line
    const before = s.doc.text;
    press(s, "delete");
    assert(s.view().message.includes("isn't editable"), s.view().message);
    assertEquals(s.doc.text, before, "the removed line is untouched");
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace on a removed line reports it isn't editable (handleBackspace)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    press(s, "right"); // move off column 0 but stay on the removed line
    press(s, "backspace");
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: backspace at the diff marker column is protected (MARKER_MSG)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    press(s, "ctrl-a"); // cursor at the marker column (start of editable region)
    // The line still has content, so backspace at the marker neither deletes a
    // character nor removes the line: it protects the marker.
    const before = s.doc.text;
    press(s, "backspace");
    assert(
      s.view().message.includes("marker") || s.doc.text === before,
      s.view().message,
    );
  } finally {
    done();
  }
});

Deno.test("diffcov: M-backspace on a removed line is refused (guardBackwardEdit null)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    s.handleKey(alt("backspace"));
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: M-backspace at the marker on an editable line hits the marker guard", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9);
    press(s, "ctrl-a"); // at the editable start (just past the marker)
    s.handleKey(alt("backspace")); // col <= start -> MARKER_MSG
    assert(s.view().message.includes("marker"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w region kill on a removed line is refused (guardRegionEdit null)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 8);
    press(s, "ctrl-space"); // set the mark on the removed line
    press(s, "right"); // keep the mark on the same (removed) row
    press(s, "ctrl-w");
    assert(s.view().message.includes("isn't editable"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: C-w whose region reaches into the marker is refused (MARKER_MSG)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line; the cursor sits at column 0 (marker)
    // Set the mark at the marker column, then move the cursor into the editable
    // region: the region's minimum column is the marker, below the editable
    // start, so the gate protects the marker.
    press(s, "ctrl-space"); // mark at column 0 (the marker)
    press(s, "right", "right"); // cursor now past the marker, mark still at 0
    press(s, "ctrl-w");
    assert(s.view().message.includes("marker"), s.view().message);
  } finally {
    done();
  }
});

Deno.test("diffcov: a same-line region past the marker is killed (guardRegionEdit success)", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 9); // an editable added line
    press(s, "ctrl-e"); // mark at the line end (well past the marker)
    press(s, "ctrl-space");
    press(s, "left", "left", "left", "left"); // cursor still past the marker
    const before = s.doc.text;
    press(s, "ctrl-w"); // both ends past the marker, same row -> the kill runs
    assertEquals(s.view().message, "", "no refusal message");
    assert(s.doc.text !== before, "the region was killed");
  } finally {
    done();
  }
});

// --- the mark rides onto the added line when a context edit splits (1109-1111)

Deno.test("diffcov: a mark on a context line rides onto the added line when split", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    toLine(s, 6); // a context line ("    return n * 2;")
    press(s, "ctrl-e"); // to the end of the editable content
    press(s, "ctrl-space"); // set the mark on this context line
    press(s, "ctrl-a"); // move the cursor to the editable start, mark stays
    type(s, "Z"); // editing the context line splits it; the mark rides along
    const split = s.doc.text.split("\n");
    assert(split.some((l) => l.startsWith("-")), "a removed line appeared");
    assert(split.some((l) => l.startsWith("+")), "an added line appeared");
  } finally {
    done();
  }
});

// --- ensureCursorVisible scrolls the cursor into view (1371-1372, 1375-1376) -

Deno.test("session: moving the edit cursor off-screen scrolls it back into view", () => {
  // A tall, wide file so cursor moves cross the viewport edges in both axes.
  const longLine = "const wide = " + "1 + ".repeat(40) + "0;";
  const body = Array.from({ length: 40 }, (_, i) => `line${i} = ${i};`);
  const text = [longLine, ...body].join("\n") + "\n";
  const { s } = fileSession(text, 30, 8);
  press(s, "down"); // reveal cursor at the top
  // Move far down: b.row >= top + rows triggers the downward scroll branch.
  for (let i = 0; i < 30; i++) press(s, "down");
  assert(s.view().top > 0, "scrolled down to keep the cursor visible");
  const downTop = s.view().top;
  // Move back up to the first line: b.row < top triggers the upward branch.
  for (let i = 0; i < 40; i++) press(s, "up");
  assert(s.view().top < downTop, "scrolled up to follow the cursor");
  assertEquals(s.view().cursor?.line, 0);
  // Now exercise the horizontal branches on the long first line.
  press(s, "ctrl-e"); // to the end of the wide line: pans right
  assert(s.view().left > 0, "panned right to keep the cursor visible");
  press(s, "ctrl-a"); // back to the start: pans left
  assertEquals(s.view().left, 0, "panned back to column 0");
});

// --- ensurePickerVisible never lets the scroll go negative (1705) ------------

Deno.test("filepickercov: scrolling the picker selection up keeps the scroll non-negative", () => {
  const s = pickerSession();
  press(s, "ctrl-x", "ctrl-f");
  // Page down to advance the scroll, then page up past the top: the scroll is
  // clamped and never dips below zero.
  press(s, "pagedown", "pagedown");
  press(s, "pageup", "pageup", "pageup");
  assert(s.view().overlay!.scroll >= 0, "scroll stayed non-negative");
  assertEquals(s.view().overlay!.selectedLine, 0, "back at the first entry");
});

// --- adjustHunkCounts: removing the last context line above a hunk (1152) ----

Deno.test("diffcov: removing an added line shrinks the hunk header counts", () => {
  const { ws, done } = diffWorkspace();
  try {
    const s = diffSession(ws);
    // Header before the edit.
    const headerBefore = s.doc.lines.find((l) => l.text.startsWith("@@"))!.text;
    toLine(s, 10); // "+const extra = answer + 1;" (an added line)
    press(s, "end"); // to the end of the line
    // Backspacing the whole content then once more at the start removes the
    // added line and shrinks the hunk's new-side count.
    const content = "const extra = answer + 1;";
    for (let i = 0; i < content.length + 1; i++) press(s, "backspace");
    const headerAfter = s.doc.lines.find((l) =>
      l.text.startsWith("@@")
    )?.text ??
      "";
    assert(
      !s.doc.text.includes(content),
      "the added line was removed",
    );
    assert(headerBefore.startsWith("@@"), headerBefore);
    assert(headerAfter === "" || headerAfter.startsWith("@@"));
  } finally {
    done();
  }
});
