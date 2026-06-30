import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { overlayBox, renderFrame, type ViewState } from "../lib/view/render.ts";
import { _internal } from "../lib/view/render.ts";
import { stripAnsi, visibleWidth } from "../lib/view/ansi.ts";
import { renderLineColored } from "../lib/view/highlight.ts";

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

/** Per-visible-column flag: is a 24-bit background colour active on each cell?
 * (The renderer emits a self-contained SGR after each RESET, so a run with
 * `48;2;` has a bg; RESET clears it.) */
function bgColumns(row: string): boolean[] {
  const out: boolean[] = [];
  let bg = false;
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      // deno-lint-ignore no-control-regex
      const m = row.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (m) {
        bg = m[1] === "0" || m[1] === "" ? false : /48;2;/.test(m[1]);
        i += m[0].length;
        continue;
      }
    }
    out.push(bg);
    i += 1;
  }
  return out;
}

Deno.test("renderFrame: node highlight covers the whole statement, not the padding", () => {
  const doc = parseDocument("const x = 1;\nconst y = 2;\n");
  // A structure node now spans the whole statement `const x = 1;` (12 columns),
  // including the `const` keyword and the `;` — but not the trailing padding,
  // and not the left guide column the renderer reserves while a node is
  // selected.
  const node = doc.flatStructure.find((n) => n.name === "x")!;
  const rows = renderFrame(doc, baseView({ selected: node, width: 40 }));
  const cols = bgColumns(rows[0]);
  const highlighted = cols.filter((c) => c).length;
  assertEquals(highlighted, 12, "the entire statement is highlighted");
  // The highlighted region is one contiguous run (no gap over `const `).
  const first = cols.indexOf(true);
  const last = cols.lastIndexOf(true);
  assertEquals(last - first + 1, highlighted, "highlight is contiguous");
  assertEquals(
    cols[cols.length - 1],
    false,
    "trailing padding not highlighted",
  );
  assertEquals(cols[0], false, "the left guide column is not highlighted");
  // a line outside the (single-line) node has no highlight at all
  const cols1 = bgColumns(rows[1]);
  assertEquals(cols1.some((c) => c), false, "other lines are not highlighted");
});

Deno.test("renderFrame: emits exactly `height` rows", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ height: 12 }));
  assertEquals(rows.length, 12);
});

Deno.test("renderFrame: content rows are verbatim under the colour", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView());
  // line 0 is the section header, line 1 is `const define = undefined;`
  assertEquals(stripAnsi(rows[0]).trimEnd(), doc.lines[0].text);
  assertEquals(stripAnsi(rows[1]).trimEnd(), doc.lines[1].text);
});

Deno.test("renderFrame: horizontal scroll slices from the left offset", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ left: 3 }));
  assertEquals(stripAnsi(rows[1]).trimEnd(), doc.lines[1].text.slice(3));
});

Deno.test("renderFrame: monochrome output equals verbatim text", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ color: false }));
  assertEquals(rows[1].trimEnd(), doc.lines[1].text);
  // no escape sequences at all
  assert(!rows[1].includes("\x1b"));
});

Deno.test("renderFrame: line-number gutter shows numbers", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ showLineNumbers: true }));
  const text = stripAnsi(rows[1]);
  assert(/^\s*2\s/.test(text), `expected line number 2, got "${text}"`);
  assert(text.includes("const define"), "still shows the source");
});

Deno.test("renderFrame: selecting a node draws a guide bar", () => {
  const doc = parseDocument(SAMPLE);
  const node = doc.flatStructure.find((n) => n.endLine > n.startLine)!;
  const rows = renderFrame(
    doc,
    baseView({ top: node.startLine, selected: node, height: 20 }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(/[╭│╰▶]/.test(joined), "guide glyphs present when a node is selected");
});

Deno.test("renderFrame: search matches are highlighted", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({ matches: [{ line: 1, start: 0, end: 5 }], currentMatch: 0 }),
  );
  // current match uses the orange highlight background (48;2;209;154;102)
  assert(rows[1].includes("48;2;209;154;102"), "current match highlighted");
});

Deno.test("renderFrame: status line reports position", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(doc, baseView({ height: 8 }));
  const status = stripAnsi(rows[rows.length - 1]);
  assert(status.includes("/"), `status shows position: "${status}"`);
});

Deno.test("renderFrame: overlay paints its title over the content", () => {
  const doc = parseDocument(SAMPLE);
  const rows = renderFrame(
    doc,
    baseView({
      width: 60,
      height: 16,
      overlay: {
        title: "DEFINITION-PEEK",
        lines: [{
          text: "hello",
          spans: [{ col: 0, text: "hello", cls: "plain" }],
        }],
        scroll: 0,
        footer: "esc close",
      },
    }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(joined.includes("DEFINITION-PEEK"), "overlay title shown");
  assert(joined.includes("hello"), "overlay body shown");
});

Deno.test("renderFrame: a non-BMP glyph keeps the overlay borders flush", () => {
  // `𝑻` is a surrogate pair (two UTF-16 units, one column). If width maths
  // counted code units the right border would drift; assert every row is
  // exactly `view.width` columns wide, both in the title and the body.
  const doc = parseDocument(SAMPLE);
  const width = 72;
  const rows = renderFrame(
    doc,
    baseView({
      width,
      height: 16,
      overlay: {
        title: "𝑻 lift __cfLift_1",
        lines: [{
          text: "𝑻 input",
          spans: [{ col: 0, text: "𝑻 input", cls: "plain" }],
        }],
        scroll: 0,
        footer: "esc close",
      },
    }),
  );
  for (const row of rows) {
    assertEquals(visibleWidth(row), width, `row width: "${stripAnsi(row)}"`);
  }
  // The right border sits at the same display column on every boxed row.
  const rightBorderCols = rows
    .map((r) => [...stripAnsi(r)])
    .filter((chars) => /[╮│╯]/.test(chars.join("")))
    .map((chars) => chars.findLastIndex((c) => "╮│╯".includes(c)));
  assert(rightBorderCols.length >= 3, "the box has multiple bordered rows");
  assertEquals(
    new Set(rightBorderCols).size,
    1,
    `right border aligned at one column, got ${rightBorderCols}`,
  );
  assert(rows.map(stripAnsi).join("\n").includes("𝑻 lift"), "title survives");
});

Deno.test("renderFrame: overlay on a tiny terminal does not throw", () => {
  const doc = parseDocument(SAMPLE);
  const overlay = {
    title: "DEFINITION-PEEK",
    lines: [{
      text: "hello",
      spans: [{ col: 0, text: "hello", cls: "plain" as const }],
    }],
    scroll: 0,
    footer: "esc close",
  };
  // Sizes smaller than the overlay's border chrome must not crash the renderer
  // (a negative inner width/height would feed a negative repeat/slice). The
  // box collapses and the overlay is simply skipped.
  for (const [width, height] of [[2, 1], [3, 2], [1, 1], [6, 3]]) {
    // The call itself throwing is the regression under test; reaching the
    // assertion means it did not.
    const rows = renderFrame(doc, baseView({ width, height, overlay }));
    assertEquals(
      rows.length,
      height,
      `emits ${height} rows at ${width}x${height}`,
    );
  }
});

Deno.test("overlayBox: inner dimensions never go negative", () => {
  for (let width = 0; width <= 50; width++) {
    for (let height = 0; height <= 24; height++) {
      const box = overlayBox(width, height);
      assert(box.innerW >= 0, `innerW >= 0 at ${width}x${height}`);
      assert(box.innerH >= 0, `innerH >= 0 at ${width}x${height}`);
      assert(box.x >= 0, `x >= 0 at ${width}x${height}`);
      assert(box.y >= 0, `y >= 0 at ${width}x${height}`);
      // The box never extends past the terminal it is centred in.
      assert(box.boxW <= Math.max(0, width), `boxW fits at ${width}x${height}`);
      assert(
        box.boxH <= Math.max(0, height),
        `boxH fits at ${width}x${height}`,
      );
    }
  }
});

Deno.test("render _internal: sliceVisible keeps ANSI and counts visible cols", () => {
  const colored = renderLineColored(
    { text: "abcdef", spans: [{ col: 0, text: "abcdef", cls: "plain" }] },
    true,
  );
  const sliced = _internal.sliceVisible(colored, 2, 4);
  assertEquals(stripAnsi(sliced), "cd");
});

Deno.test("render _internal: padTo pads to visible width", () => {
  assertEquals(_internal.visibleLen(_internal.padTo("hi", 5)), 5);
});
