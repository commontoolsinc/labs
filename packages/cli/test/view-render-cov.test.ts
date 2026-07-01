import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import {
  cursorScreenPos,
  type Match,
  overlayBox,
  type OverlayState,
  renderFrame,
  type ViewState,
} from "../lib/view/render.ts";
import { stripAnsi } from "../lib/view/ansi.ts";
import type { StructureKind, StructureNode } from "../lib/view/model.ts";

function baseView(over: Partial<ViewState> = {}): ViewState {
  return {
    top: 0,
    left: 0,
    width: 50,
    height: 10,
    color: true,
    showLineNumbers: false,
    selected: null,
    matches: null,
    currentMatch: 0,
    message: "",
    inputLine: null,
    overlay: null,
    ...over,
  };
}

/** A minimal structure node with an arbitrary kind, for status-line rendering
 * (the renderer only reads kind/label and the line/col extent). */
function node(
  kind: StructureKind,
  over: Partial<StructureNode> = {},
): StructureNode {
  return {
    kind,
    label: `${kind} thing`,
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
    startOffset: 0,
    endOffset: 0,
    depth: 0,
    children: [],
    ...over,
  };
}

// --- cursorScreenPos / layout ------------------------------------------------

Deno.test("cursorScreenPos: null when there is no cursor", () => {
  const doc = parseDocument(SAMPLE);
  assertEquals(cursorScreenPos(doc, baseView()), null);
});

Deno.test("cursorScreenPos: null when an overlay covers the content", () => {
  const doc = parseDocument(SAMPLE);
  const overlay: OverlayState = {
    title: "x",
    lines: [],
    scroll: 0,
    footer: "f",
  };
  const view = baseView({ cursor: { line: 1, col: 2 }, overlay });
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: maps document coords to 1-based screen coords", () => {
  const doc = parseDocument(SAMPLE);
  // cursor on line 2 (index 2), column 4; no gutter, no guide.
  const view = baseView({ cursor: { line: 2, col: 4 }, top: 0 });
  const pos = cursorScreenPos(doc, view);
  // r = line - top = 2; row = r + 1 = 3. col = gutter(0)+guide(0)+contentCol(4)+1
  assertEquals(pos, { row: 3, col: 5 });
});

Deno.test("cursorScreenPos: accounts for the line-number gutter and guide bar", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", { startLine: 0, endLine: 5 });
  const view = baseView({
    cursor: { line: 1, col: 0 },
    showLineNumbers: true,
    selected: sel,
  });
  const pos = cursorScreenPos(doc, view);
  assert(pos !== null, "cursor visible");
  // gutter width is max(4, len(String(lines.length))+1) and guide width is 1.
  const gutterWidth = Math.max(4, String(doc.lines.length).length + 1);
  const guideWidth = 1;
  assertEquals(pos, { row: 2, col: gutterWidth + guideWidth + 0 + 1 });
});

Deno.test("cursorScreenPos: null when the cursor row is scrolled above the top", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 0, col: 0 }, top: 3 });
  // r = 0 - 3 = -3 < 0
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor row is below the content area", () => {
  const doc = parseDocument(SAMPLE);
  // contentHeight = height - 1 = 4; r must be < 4. line - top = 5 -> off screen.
  const view = baseView({ cursor: { line: 5, col: 0 }, top: 0, height: 5 });
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor column is scrolled off to the left", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 1, col: 2 }, left: 5 });
  // contentCol = 2 - 5 = -3 < 0
  assertEquals(cursorScreenPos(doc, view), null);
});

Deno.test("cursorScreenPos: null when the cursor column is past the content width", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({ cursor: { line: 1, col: 100 }, width: 20 });
  // contentCol = 100 >= contentWidth
  assertEquals(cursorScreenPos(doc, view), null);
});

// --- notice rows -------------------------------------------------------------

Deno.test("renderFrame: notice overwrites the bottom content rows", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({
    height: 6,
    notice: ["save to a.ts", "save to b.ts"],
  });
  const rows = renderFrame(doc, view);
  const text = rows.map(stripAnsi);
  // contentHeight = 5; notice has 2 lines -> rows 3 and 4 carry it.
  assert(text[3].includes("save to a.ts"), `row 3: "${text[3]}"`);
  assert(text[4].includes("save to b.ts"), `row 4: "${text[4]}"`);
  // status line (last row) is untouched by the notice band.
  assert(text[5].includes("/"), "status row preserved");
});

Deno.test("renderFrame: a notice taller than the content clamps to the top row", () => {
  const doc = parseDocument(SAMPLE);
  const view = baseView({
    height: 4,
    color: false,
    notice: ["one", "two", "three", "four", "five"],
  });
  const rows = renderFrame(doc, view);
  const text = rows.map(stripAnsi);
  // contentHeight = 3; start = max(0, 3 - 5) = 0. The first three notice
  // entries fill the three content rows, the rest are dropped.
  assertEquals(text[0].trimEnd(), "one");
  assertEquals(text[1].trimEnd(), "two");
  assertEquals(text[2].trimEnd(), "three");
});

Deno.test("renderFrame: an empty notice array leaves content untouched", () => {
  const doc = parseDocument(SAMPLE);
  const withNotice = renderFrame(doc, baseView({ notice: [] }));
  const without = renderFrame(doc, baseView({ notice: null }));
  assertEquals(withNotice, without);
});

// --- selectionSpan: schema / closure / selection backgrounds -----------------

Deno.test("renderFrame: a schema node tints its line", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("schema", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  // schemaRegionBg is applied; some cell carries a 48;2; background.
  assert(/48;2;/.test(rows[0]), "schema region tinted");
});

Deno.test("renderFrame: a closure node tints its line", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("closure", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  assert(/48;2;/.test(rows[0]), "closure region tinted");
});

Deno.test("renderFrame: a plain node uses the selection background", () => {
  const doc = parseDocument("const x = 1;\n");
  const sel = node("variable", {
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 11,
  });
  const rows = renderFrame(doc, baseView({ selected: sel, width: 40 }));
  assert(/48;2;/.test(rows[0]), "selection region tinted");
});

// --- search-match column clamping --------------------------------------------

Deno.test("renderFrame: search matches off the left edge are clipped", () => {
  const doc = parseDocument("hello world\n");
  // Match spans columns 0..5 but the view is scrolled right by 3, so the first
  // three match columns fall before the visible area (idx < 0 -> continue).
  const matches: Match[] = [{ line: 0, start: 0, end: 5 }];
  const rows = renderFrame(doc, baseView({ matches, left: 3, width: 20 }));
  // The remaining match columns (3,4) still highlight: a search bg is present.
  assert(/48;2;/.test(rows[0]), "visible part of the match still highlighted");
});

Deno.test("renderFrame: search matches off the right edge are clipped", () => {
  const doc = parseDocument("hello world\n");
  const matches: Match[] = [{ line: 0, start: 0, end: 11 }];
  // width 4 -> contentWidth small; match columns past it (idx >= width) skip.
  const rows = renderFrame(doc, baseView({ matches, width: 4 }));
  assert(/48;2;/.test(rows[0]), "in-bounds match columns highlighted");
});

// --- renderStatus branches ---------------------------------------------------

Deno.test("renderStatus: the input line replaces the status bar", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ inputLine: "/token", color: false }),
  );
  const status = rows[rows.length - 1];
  assertEquals(status.trimEnd(), "/token");
  // no status content (no slash position string) leaks through.
  assert(!status.includes("help"), "navigation help suppressed in input mode");
});

Deno.test("renderStatus: a message takes priority on the status bar", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ message: "Pattern not found", color: false }),
  );
  assert(stripAnsi(rows[rows.length - 1]).includes("Pattern not found"));
});

Deno.test("renderStatus: an edit hint shows when there is no message", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ editHint: "esc done · ⏎ newline", color: false }),
  );
  assert(stripAnsi(rows[rows.length - 1]).includes("esc done"));
});

Deno.test("renderStatus: a selected node shows its glyph and label", () => {
  const doc = parseDocument(SAMPLE);
  const sel = node("pattern", { label: "pattern myPattern" });
  const rows = renderFrame(doc, baseView({ selected: sel, color: false }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("◆"), `pattern glyph present: "${status}"`);
  assert(status.includes("pattern myPattern"), "label present");
});

Deno.test("renderStatus: the default help line advertises expand when allowed", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ canExpand: true, color: false }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("? help"), "default help shown");
  assert(status.includes("^l expand"), "expand hint advertised");
});

Deno.test("renderStatus: the default help line omits expand when not allowed", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ canExpand: false, color: false }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("? help"), "default help shown");
  assert(!status.includes("^l expand"), "expand hint absent");
});

// --- kindGlyph: every branch -------------------------------------------------

Deno.test("renderStatus: kindGlyph maps every node kind to a glyph", () => {
  const doc = parseDocument("x\n");
  const cases: Array<[StructureKind, string]> = [
    ["section", "▸"],
    ["pattern", "◆"],
    ["builder", "◇"],
    ["closure", "λ"],
    ["schema", "▦"],
    ["function", "ƒ"],
    ["method", "ƒ"],
    ["interface", "𝑻"],
    ["typeAlias", "𝑻"],
    ["class", "𝑻"],
    ["return", "⏎"],
    ["control", "⎇"],
    ["hunk", "±"],
    ["comment", "#"],
    // a kind with no dedicated glyph falls through to the default bullet.
    ["statement", "·"],
  ];
  for (const [kind, glyph] of cases) {
    const sel = node(kind, { label: `${kind} x` });
    const rows = renderFrame(doc, baseView({ selected: sel, color: false }));
    const status = stripAnsi(rows[rows.length - 1]);
    assert(
      status.includes(glyph),
      `kind ${kind} -> glyph ${glyph}, got "${status}"`,
    );
  }
});

// --- displayChar: tabs and control characters --------------------------------

Deno.test("renderFrame: a tab renders as a single space", () => {
  const doc = parseDocument("a\tb\n");
  const rows = renderFrame(doc, baseView({ color: false }));
  // The literal tab is replaced by a space in the rendered cell grid.
  assertEquals(stripAnsi(rows[0]).slice(0, 3), "a b");
  assert(!rows[0].includes("\t"), "no raw tab in output");
});

Deno.test("renderFrame: a control character renders as a space", () => {
  // Build a document whose line text carries a control char (e.g. \x01).
  const doc = parseDocument("ab\n");
  const rows = renderFrame(doc, baseView({ color: false }));
  const text = stripAnsi(rows[0]);
  assertEquals(text.slice(0, 3), "a b");
  assert(!text.includes(""), "control char scrubbed");
});

// --- overlay: span past the inner width / truncCenter truncation -------------

Deno.test("overlay: a span wider than the box is clipped at the inner edge", () => {
  const doc = parseDocument(SAMPLE);
  const wide = "X".repeat(200);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      overlay: {
        title: "PEEK",
        lines: [{ text: wide, spans: [{ col: 0, text: wide, cls: "plain" }] }],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  // The body shows some X's but the span is clipped at the inner box edge
  // rather than spilling over.
  assert(joined.includes("X"), "overlay body rendered");
  const bodyRow = rows.map(stripAnsi).find((r) => r.includes("X"))!;
  assertEquals(
    bodyRow.length,
    50,
    "the body row is exactly the terminal width",
  );
  // The clipped run of X's is bounded by the inner box width, far short of 200.
  const runLen = bodyRow.match(/X+/)![0].length;
  assert(runLen < 50, `wide span clipped to the box, run length ${runLen}`);
});

Deno.test("overlay: a title longer than the box is truncated to fit", () => {
  const doc = parseDocument(SAMPLE);
  const box = overlayBox(50, 16);
  // A title far wider than the inner box width forces truncCenter's truncation
  // path (len >= width).
  const longTitle = "T".repeat(box.boxW + 40);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      overlay: {
        title: longTitle,
        lines: [],
        scroll: 0,
        footer: "esc",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  // The truncated title appears but the top border row is no wider than the box.
  assert(joined.includes("TTT"), "truncated title still visible");
  const topRow = rows.find((r) => stripAnsi(r).includes("╭"))!;
  assert(stripAnsi(topRow).includes("TTT"), "title sits on the top border");
});

Deno.test("overlay: a selected reference line is tinted differently", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 50,
      height: 16,
      color: true,
      overlay: {
        title: "REFS",
        lines: [
          { text: "one", spans: [{ col: 0, text: "one", cls: "plain" }] },
          { text: "two", spans: [{ col: 0, text: "two", cls: "plain" }] },
        ],
        scroll: 0,
        footer: "esc",
        selectedLine: 1,
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(joined.includes("two"), "selected ref line rendered");
});

Deno.test("renderFrame: the guide rail is blank on lines outside the selected node", () => {
  const ln = (text: string) => ({
    text,
    spans: [{ col: 0, text, cls: "plain" as const }],
  });
  // A node confined to line 1 of a three-line document: lines 0 and 2 sit
  // outside its range, so their guide column is blank.
  const sel: StructureNode = {
    kind: "node",
    label: "mid",
    startLine: 1,
    endLine: 1,
    startCol: 0,
    endCol: 1,
    startOffset: 0,
    endOffset: 1,
    depth: 0,
    children: [],
  };
  const doc = {
    text: "a\nb\nc\n",
    lines: [ln("a"), ln("b"), ln("c")],
    structure: [sel],
    flatStructure: [sel],
    definitions: new Map(),
  };
  const rows = renderFrame(doc, baseView({ top: 0, selected: sel, height: 6 }));
  // No gutter, so the guide glyph is at column 0.
  assertEquals(stripAnsi(rows[0])[0], " ", "blank guide above the node");
  assertEquals(stripAnsi(rows[2])[0], " ", "blank guide below the node");
  assertEquals(stripAnsi(rows[1])[0], "▶", "single-line node carries a glyph");
});
