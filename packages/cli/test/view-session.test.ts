import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { Session } from "../lib/view/session.ts";
import { frameTop } from "../lib/view/actions.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Semantics } from "../lib/view/semantics.ts";

function makeSession() {
  const doc = parseDocument(SAMPLE);
  return new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height: 10 },
  );
}

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    const key: Key = name.length === 1 && name >= " "
      ? { name, char: name }
      : { name };
    session.handleKey(key);
  }
}

Deno.test("session: vertical scrolling and clamping", () => {
  // j/k scroll the pager (bare arrows scroll too; edit mode is entered with e).
  const s = makeSession();
  assertEquals(s.view().top, 0);
  press(s, "j", "j", "j");
  assertEquals(s.view().top, 3);
  press(s, "k");
  assertEquals(s.view().top, 2);
  press(s, "g");
  assertEquals(s.view().top, 0);
  press(s, "G");
  assert(s.view().top > 0, "G goes to the bottom");
  press(s, "k", "k");
  // never below zero
  press(s, "g", "k", "k");
  assertEquals(s.view().top, 0);
});

Deno.test("session: horizontal scrolling", () => {
  const s = makeSession();
  press(s, "l");
  assertEquals(s.view().left, 8);
  press(s, "h");
  assertEquals(s.view().left, 0);
  press(s, "h");
  assertEquals(s.view().left, 0, "left clamps at 0");
});

Deno.test("session: bare arrows scroll and pan the view", () => {
  const s = makeSession();
  press(s, "down", "down");
  assertEquals(s.view().top, 2, "down arrows scroll the view");
  press(s, "up");
  assertEquals(s.view().top, 1);
  press(s, "right");
  assertEquals(s.view().left, 8, "right pans the view");
  press(s, "left");
  assertEquals(s.view().left, 0);
});

Deno.test("session: alt+arrows scroll and pan the view", () => {
  const s = makeSession();
  const alt = (name: string): Key => ({ name, alt: true });
  s.handleKey(alt("down"));
  s.handleKey(alt("down"));
  assertEquals(s.view().top, 2, "alt+down scrolls");
  s.handleKey(alt("right"));
  assertEquals(s.view().left, 8, "alt+right pans");
  s.handleKey(alt("up"));
  assertEquals(s.view().top, 1);
  s.handleKey(alt("left"));
  assertEquals(s.view().left, 0);
});

Deno.test("session: incremental search then commit", () => {
  const s = makeSession();
  press(s, "/");
  assertEquals(s.view().inputLine, "/");
  press(s, "t", "o", "k", "e", "n");
  assertEquals(s.view().inputLine, "/token");
  // incremental matches available while typing
  assert((s.view().matches?.length ?? 0) > 0, "matches found incrementally");
  press(s, "enter");
  assertEquals(s.view().inputLine, null, "input committed");
  const count = s.view().matches!.length;
  assert(count > 0);
  // n advances the current match
  const before = s.view().currentMatch;
  press(s, "n");
  assert(s.view().currentMatch !== before || count === 1);
});

Deno.test("session: search miss reports a message", () => {
  const s = makeSession();
  press(s, "/");
  press(s, "z", "z", "z", "q", "q", "x");
  press(s, "enter");
  assert(
    s.view().message.toLowerCase().includes("not found"),
    `expected not-found message, got "${s.view().message}"`,
  );
});

Deno.test("session: escape cancels search input", () => {
  const s = makeSession();
  press(s, "/", "a", "b");
  assertEquals(s.view().inputLine, "/ab");
  press(s, "escape");
  assertEquals(s.view().inputLine, null);
});

Deno.test("session: WASD does four distinct moves (sibling/sibling/parent/child)", () => {
  const s = makeSession();
  assertEquals(s.view().selected, null);
  press(s, "s"); // first press just establishes a selection
  const start = s.view().selected!;
  assert(start, "a node is selected");

  // s -> next sibling: a different node at the same depth
  press(s, "s");
  const sib = s.view().selected!;
  assert(sib !== start, "s advanced the selection");
  assertEquals(sib.depth, start.depth, "s moves among same-depth siblings");

  // w -> previous sibling: returns to the start
  press(s, "w");
  assertEquals(s.view().selected, start, "w returns to the previous sibling");

  // d -> first child: one level deeper
  press(s, "d");
  const child = s.view().selected!;
  assertEquals(child.depth, start.depth + 1, "d descends to a first child");

  // a -> parent: back to the start
  press(s, "a");
  assertEquals(s.view().selected, start, "a ascends to the parent");
});

Deno.test("session: Enter peeks the selected node, Esc closes", () => {
  const s = makeSession();
  press(s, "s", "s");
  const node = s.view().selected!;
  press(s, "enter");
  const ov = s.view().overlay;
  assert(ov, "overlay opened");
  assert(ov!.title.includes(node.label) || ov!.title.includes(node.kind));
  press(s, "escape");
  assertEquals(s.view().overlay, null, "overlay closed");
});

Deno.test("session: Enter opens an info card; Tab toggles info ⇄ source", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
  );
  press(s, "s", "s"); // select a section (has both an outline and source)
  press(s, "enter");
  const card = s.view().overlay!;
  assert(card, "card opened");
  const infoText = card.lines.map((l) => l.text).join("\n");
  assert(card.footer.includes("tab"), "footer advertises the toggle");

  press(s, "tab");
  const sourceText = s.view().overlay!.lines.map((l) => l.text).join("\n");
  assert(sourceText !== infoText, "tab switched to the source view");

  press(s, "tab");
  const backText = s.view().overlay!.lines.map((l) => l.text).join("\n");
  assertEquals(backText, infoText, "tab toggled back to the info card");
});

Deno.test("session: definition lookup overlay", () => {
  const s = makeSession();
  press(s, "t"); // enter deflookup
  assert(s.view().inputLine?.startsWith("definition:"));
  for (const ch of "myPattern") press(s, ch);
  press(s, "enter");
  const ov = s.view().overlay;
  assert(ov, "definition overlay opened");
  assert(ov!.title.includes("myPattern"));
});

Deno.test("session: line-number toggle cycles off → input → file → off", () => {
  const s = makeSession();
  assertEquals(s.view().showLineNumbers, false, "off to start");
  press(s, "#"); // → input position
  assertEquals(s.view().showLineNumbers, true);
  assert(s.view().message.includes("input"), s.view().message);
  // Input numbers are the document line (1-based) on each row.
  assertEquals(s.view().lineNumbers?.[0], 1);
  assertEquals(s.view().lineNumbers?.[2], 3);
  press(s, "#"); // → file / message line
  assert(s.view().message.includes("file"), s.view().message);
  assertEquals(s.view().showLineNumbers, true);
  press(s, "#"); // → off
  assertEquals(s.view().showLineNumbers, false);
  assertEquals(s.view().lineNumbers, null);
});

Deno.test("session: help overlay opens with ?", () => {
  const s = makeSession();
  press(s, "?");
  const ov = s.view().overlay;
  assert(ov, "help overlay open");
  assert(ov!.title.toLowerCase().includes("keys"));
});

Deno.test("session: c cycles the non-printable display mode and reports it", () => {
  const s = makeSession();
  assertEquals(s.view().displayMode, "pictures", "starts on the first mode");
  press(s, "c");
  assertEquals(s.view().displayMode, "ansi");
  assert(s.view().message.includes("ANSI colour"), "reports the new mode");
  press(s, "c");
  assertEquals(s.view().displayMode, "hidden");
  press(s, "c");
  assertEquals(
    s.view().displayMode,
    "pictures",
    "wraps back to the first mode",
  );
});

Deno.test("session: a search reveal in a compacting mode scrolls to the display column", () => {
  // A wide line whose match sits far to the right of a control-code run, in a
  // narrow viewport so revealing it must scroll horizontally. Hidden mode
  // collapses the run, so the reveal counts display columns, not source columns.
  const tail = "x".repeat(40) + "NEEDLE";
  const doc = parseDocument(`a${"\x01".repeat(10)}${tail}\n`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 20, height: 6 },
  );
  press(s, "c", "c"); // pictures → ansi → hidden
  assertEquals(s.view().displayMode, "hidden");
  press(s, "/");
  for (const ch of "NEEDLE") press(s, ch);
  press(s, "enter");
  // The 10-code run collapses to one ellipsis, so "NEEDLE" starts at display
  // column ~42, not its source column ~51. The viewport frames the display one.
  const left = s.view().left;
  assert(left > 0 && left <= 42, `reveal used a display column, left=${left}`);
});

Deno.test("session: resize reclamps scroll", () => {
  const s = makeSession();
  press(s, "G");
  const bottomTop = s.view().top;
  s.resize(80, 100); // taller than the doc
  assertEquals(s.view().top, 0, "growing the viewport pulls top back to 0");
  assert(bottomTop >= 0);
});

Deno.test("session: WASD never scrolls when the whole document fits", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height: doc.lines.length + 5 }, // everything visible
  );
  press(s, "s");
  assertEquals(s.view().top, 0);
  for (let i = 0; i < doc.flatStructure.length + 2; i++) {
    press(s, "s");
    assertEquals(s.view().top, 0, "no scroll while everything is on screen");
  }
  // moving back up and across should also not scroll
  press(s, "w", "a", "d");
  assertEquals(s.view().top, 0);
});

Deno.test("session: WASD scrolls only when the selection anchor leaves the screen", () => {
  const doc = parseDocument(SAMPLE);
  const height = 8;
  const rows = height - 1;
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 80, height },
  );
  // Descend into a section whose children (depth 1) span the whole document, so
  // walking the siblings with `s` forces some moves off-screen and others not.
  press(s, "s"); // first section
  press(s, "s"); // its sibling section (the larger block)
  press(s, "d"); // first child (depth 1)
  assertEquals(s.view().top, 0, "anchors near the top so far — no scroll yet");

  let scrolled = false;
  for (let i = 0; i < doc.flatStructure.length; i++) {
    const beforeTop = s.view().top;
    const beforeSel = s.view().selected;
    press(s, "s"); // walk the depth-1 siblings down the file
    const sel = s.view().selected!;
    if (sel === beforeSel) break; // reached the last sibling (no-op)
    const afterTop = s.view().top;
    // The selection anchor is always on screen after a move.
    assert(
      sel.startLine >= afterTop && sel.startLine <= afterTop + rows - 1,
      `anchor ${sel.startLine} visible in [${afterTop}, ${
        afterTop + rows - 1
      }]`,
    );
    // No scroll when the anchor was already visible; scroll only otherwise.
    if (sel.startLine >= beforeTop && sel.startLine <= beforeTop + rows - 1) {
      assertEquals(
        afterTop,
        beforeTop,
        "no scroll when anchor already visible",
      );
    } else {
      scrolled = true;
    }
  }
  assert(scrolled, "walking across the document scrolled at least once");
});

Deno.test("session: Tab / Shift-Tab navigate depth-first", () => {
  const s = makeSession();
  press(s, "tab"); // first press establishes a selection
  const a = s.view().selected!;
  assert(a, "a node is selected");
  press(s, "tab"); // pre-order successor (descends into children)
  const b = s.view().selected!;
  assert(b !== a, "tab advanced");
  press(s, "shift-tab"); // pre-order predecessor
  assertEquals(s.view().selected, a, "shift-tab returns to the previous node");
});

/** Tab through the tree (depth-first) until a node with `label` is selected. */
function selectByLabel(s: Session, label: string): void {
  for (let i = 0; i < 500; i++) {
    if (s.view().selected?.label === label) return;
    press(s, "tab");
  }
  throw new Error(`node not reached: ${label}`);
}

Deno.test("session: Enter in the card opens the selected reference's card", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter"); // open the info card
  const card = s.view().overlay!;
  assert(card, "card opened");
  assert(card.footer.includes("open"), "footer advertises 'open'");
  const before = card.title;

  press(s, "down"); // select the first reference
  assert(s.view().overlay!.selectedLine !== undefined, "a reference selected");

  press(s, "enter"); // open that reference's card (stay in the overlay)
  const ov = s.view().overlay!;
  assert(ov, "overlay stays open (navigated, not closed)");
  assert(ov.title !== before, "card now describes a different node");
  assertEquals(ov.selectedLine, undefined, "selection reset after navigating");
});

Deno.test("session: z closes the card and centres the main view on the target", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select a reference
  press(s, "z"); // reveal it in the main view
  assertEquals(s.view().overlay, null, "card closed");
  assert(s.view().message.startsWith("→"), "reports the reveal");
  assert(s.view().selected, "a node is selected at the destination");
});

Deno.test("session: z frames the revealed node (centred when it fits)", () => {
  const doc = parseDocument(SAMPLE);
  const height = 14;
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height },
  );
  selectByLabel(s, "pattern myPattern");
  const node = s.view().selected!;
  press(s, "enter"); // open the card
  press(s, "z"); // reveal its own node, framed
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().top,
    frameTop(node.startLine, node.endLine, height, doc.lines.length),
    "viewport framed per frameTop",
  );
});

Deno.test("session: z with no reference selected reveals the card's own node", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  const subject = s.view().selected!; // the lift node
  press(s, "enter"); // open its card (no reference selected)
  press(s, "z"); // reveal the card's own subject
  assertEquals(s.view().overlay, null, "card closed");
  assertEquals(
    s.view().selected?.startOffset,
    subject.startOffset,
    "the card's own node is selected in the main view",
  );
});

Deno.test("session: card up at the first reference returns to scrolling the top", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 100, height: 30 },
  );
  selectByLabel(s, "lift __cfLift_1");
  press(s, "enter");
  press(s, "down"); // select first target
  assert(s.view().overlay!.selectedLine !== undefined);
  press(s, "up"); // deselect, back to top
  assertEquals(s.view().overlay!.selectedLine, undefined, "deselected");
});

Deno.test("session: opening an external definition shows that file", () => {
  const fileText = "export function ext(): boolean {\n  return true;\n}\n";
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      {
        name: "ext",
        filePath,
        fileOffset: 0,
        line: 1,
        preview: "return true;",
      },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts
const flag = ext();`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card (it has the external `ext` reference)
  press(s, "down"); // select that reference
  assert(
    s.view().overlay!.selectedLine !== undefined,
    "a reference is selected",
  );
  press(s, "enter"); // open the external file
  const ov = s.view().overlay!;
  assert(ov, "overlay open");
  assert(ov.title.includes("ext.ts"), `title names the file: ${ov.title}`);
  const text = ov.lines.map((l) => l.text).join("\n");
  assert(
    text.includes("export function ext"),
    "shows the external file's source",
  );
});

Deno.test("session: an external definition opens framed at its line", () => {
  const fileText = Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n");
  const filePath = "/workspace/ext.ts";
  const stub: Semantics = {
    typeAt: () => null,
    prewarm: () => {},
    fileLines: (p) => p === filePath ? parseDocument(fileText).lines : null,
    definitionOf: () => [
      { name: "ext", filePath, fileOffset: 0, line: 10, preview: "" },
    ],
  };
  const doc = parseDocument(`// transformed: /m.ts
const flag = ext();`);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
    stub,
  );
  const flagLabel = doc.flatStructure.find((n) => n.name === "flag")!.label;
  selectByLabel(s, flagLabel);
  press(s, "enter"); // open the card
  press(s, "down"); // select the external reference
  press(s, "enter"); // open the file
  const ov = s.view().overlay!;
  assert(ov.title.includes("ext.ts"), `title names the file: ${ov.title}`);
  assertEquals(ov.scroll, 8, "framed two lines above the definition (line 10)");
});

Deno.test("session: WASD preserves horizontal scroll", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 24, height: doc.lines.length + 5 },
  );
  press(s, "l", "l"); // pan right
  const leftBefore = s.view().left;
  assert(leftBefore > 0, "panned right");
  press(s, "s", "s", "w");
  assertEquals(
    s.view().left,
    leftBefore,
    "horizontal scroll preserved by WASD",
  );
});

Deno.test("session: the help overlay documents file folding and scrolling", () => {
  const s = makeSession();
  press(s, "?");
  const ov = s.view().overlay!;
  const text = ov.lines.map((l) => l.text).join("\n");
  assert(text.includes("Diff files"), "has a Diff files section");
  assert(/hide\s*\/\s*show/.test(text), "documents hide/show");
  assert(text.includes("hide all files"), "documents hide all");
  assert(text.includes("hide test"), "documents hiding test files");
  assert(
    ov.footer.includes("scroll"),
    `footer advertises scrolling: ${ov.footer}`,
  );
});

Deno.test("session: an info card is a dialog; its source view is a blue window", () => {
  const doc = parseDocument(SAMPLE);
  const s = new Session(
    doc,
    { color: true, showLineNumbers: false },
    { width: 90, height: 24 },
  );
  press(s, "s", "s"); // select a section (has both a card and a source view)
  press(s, "enter");
  assert(!s.view().overlay?.sourceView, "the info card is a dialog");
  press(s, "tab"); // toggle to source
  assert(s.view().overlay?.sourceView, "its source view is a source window");
  press(s, "tab"); // back to the card
  assert(!s.view().overlay?.sourceView, "toggled back to the dialog");
});
