import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildFoldPlan,
  diffFiles,
  identityFold,
  isTestPath,
} from "../lib/view/fold.ts";
import type { Line } from "../lib/view/model.ts";
import { Session } from "../lib/view/session.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { parseDocument } from "../lib/view/parse.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { renderFrame, type ViewState } from "../lib/view/render.ts";
import { stripAnsi } from "../lib/view/ansi.ts";

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

Deno.test("diffFiles: ranges, counts, test flag, and summary text", () => {
  const files = diffFiles(TWO_FILES);
  assertEquals(files.length, 2);
  assertEquals(files[0].path, "src/app.ts");
  assertEquals(files[0].headerLine, 0);
  assertEquals(files[0].endLine, 7);
  assertEquals(files[0].isTest, false);
  assertEquals(files[0].summary.text, "▸ src/app.ts  +1 −1");
  assertEquals(files[1].path, "src/app.test.ts");
  assertEquals(files[1].isTest, true, "a .test.ts file is a test file");
  assertEquals(files[1].summary.text, "▸ src/app.test.ts  +1 −0");
});

Deno.test("diffFiles: new / deleted / renamed / binary summaries", () => {
  const created = diffFiles(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "",
    ].join("\n"),
  );
  assertEquals(created[0].summary.text, "▸ new.ts  (new)  +2 −0");

  const deleted = diffFiles(
    [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n"),
  );
  assertEquals(deleted[0].summary.text, "▸ gone.ts  (deleted)  +0 −2");

  const renamed = diffFiles(
    [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n"),
  );
  assertEquals(renamed[0].summary.text, "▸ old.ts → new.ts  +1 −1");

  const binary = diffFiles(
    [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n"),
  );
  assertEquals(binary[0].summary.text, "▸ img.png  (binary)");
});

Deno.test("diffFiles: a non-diff yields no files", () => {
  assertEquals(diffFiles("just some text\nnot a diff\n"), []);
});

// --- fold plan ---------------------------------------------------------------

const ln = (text: string): Line => ({
  text,
  spans: [{ col: 0, text, cls: "plain" }],
});

Deno.test("identityFold: display equals the document", () => {
  const lines = [ln("a"), ln("b"), ln("c")];
  const plan = identityFold(lines);
  assertEquals(plan.displayLines, lines);
  assertEquals(plan.docToDisplay(2), 2);
  assertEquals(plan.displayToDoc(1), 1);
});

Deno.test("buildFoldPlan: a collapsed file becomes one summary row", () => {
  const files = diffFiles(TWO_FILES);
  const docLines = TWO_FILES.split("\n").map(ln);
  // Collapse the first file (lines 0..7) only.
  const plan = buildFoldPlan(docLines, files, new Set([0]));
  // Row 0 is the summary; the second file's lines follow, unchanged.
  assertEquals(plan.displayLines[0].text, files[0].summary.text);
  assertEquals(
    plan.displayLines[1].text,
    "diff --git a/src/app.test.ts b/src/app.test.ts",
  );
  assertEquals(
    plan.displayLines.length,
    docLines.length - 7,
    "seven lines hidden",
  );
  // Every hidden line maps to the summary row (0); the file-2 header maps past it.
  assertEquals(plan.docToDisplay(0), 0, "the file-1 header is the summary row");
  assertEquals(
    plan.docToDisplay(5),
    0,
    "a hidden inner line maps to the summary",
  );
  assertEquals(
    plan.docToDisplay(8),
    1,
    "file-2 header is the row after the summary",
  );
  assertEquals(
    plan.displayToDoc(0),
    0,
    "the summary row stands for the header line",
  );
  assertEquals(plan.displayToDoc(1), 8, "row 1 is the file-2 header");
});

Deno.test("buildFoldPlan: nothing collapsed is the identity", () => {
  const files = diffFiles(TWO_FILES);
  const docLines = TWO_FILES.split("\n").map(ln);
  const plan = buildFoldPlan(docLines, files, new Set());
  assertEquals(plan.displayLines.length, docLines.length);
});

// --- test-path detection -----------------------------------------------------

Deno.test("isTestPath: directories and basenames", () => {
  for (
    const p of [
      "src/app.test.ts",
      "pkg/foo.spec.js",
      "pkg/foo_test.go",
      "a/b/test-helpers.ts",
      "a/b/test_utils.py",
      "test/view-fold.test.ts",
      "packages/x/tests/helper.ts",
      "app/__tests__/x.ts",
      "fixtures/data.json",
      "testdata/sample.bin",
      "components/Button.stories.tsx",
      "conftest.py",
      "goldens/output.golden",
    ]
  ) {
    assert(isTestPath(p), `expected ${p} to be a test file`);
  }
  for (
    const p of [
      "src/app.ts",
      "lib/latest.ts", // contains "test" only as a substring, not a segment/base pattern
      "docs/README.md",
      "attestation.ts",
    ]
  ) {
    assert(!isTestPath(p), `expected ${p} not to be a test file`);
  }
});

// --- folding through the session ---------------------------------------------

function press(s: Session, ...names: string[]): void {
  for (const name of names) {
    s.handleKey(
      name.length === 1 && name >= " " ? { name, char: name } : { name },
    );
  }
}

/** A diff session over `diffText` whose files do not resolve on disk (read-only,
 * but still a diff, so folding is offered). */
function foldSession(diffText: string, height = 30): Session {
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

Deno.test("fold: f hides the file the viewport is on, f again shows it", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "f"); // collapse file 0 (the viewport is at its top)
  const folded = s.displayDoc();
  assertEquals(folded.lines[0].text, "▸ src/app.ts  +1 −1", "summary shown");
  assertEquals(
    folded.lines.length,
    full - 7,
    "the file's seven lines are hidden",
  );
  assertEquals(
    folded.lines[1].text,
    "diff --git a/src/app.test.ts b/src/app.test.ts",
  );
  press(s, "f"); // toggle back
  assertEquals(s.displayDoc().lines.length, full, "showing again restores it");
});

Deno.test("fold: F hides all files, E shows all files", () => {
  const s = foldSession(TWO_FILES);
  const full = s.displayDoc().lines.length;
  press(s, "F");
  const lines = s.displayDoc().lines.map((l) => l.text);
  assert(lines.includes("▸ src/app.ts  +1 −1"), lines.join("|"));
  assert(lines.includes("▸ src/app.test.ts  +1 −0"), lines.join("|"));
  // Only the two summaries and the trailing blank remain.
  assertEquals(s.displayDoc().lines.length, 3);
  press(s, "E");
  assertEquals(s.displayDoc().lines.length, full, "E restores every file");
});

Deno.test("fold: T hides only test / test-support files", () => {
  const s = foldSession(TWO_FILES);
  press(s, "T");
  const lines = s.displayDoc().lines.map((l) => l.text);
  // The test file is a summary; the source file is shown in full.
  assert(lines.includes("▸ src/app.test.ts  +1 −0"), "test file collapsed");
  assert(lines.includes(" keep"), "the source file is still shown in full");
  assert(
    !lines.includes("▸ src/app.ts  +1 −1"),
    "the source file is not collapsed",
  );
  assert(s.view().message.includes("Hid 1 test file"), s.view().message);
});

Deno.test("fold: the collapsed summary renders on screen", () => {
  const s = foldSession(TWO_FILES);
  press(s, "F");
  const view: ViewState = s.view();
  const rows = renderFrame(s.displayDoc(), view);
  const text = rows.map(stripAnsi).join("\n");
  assert(text.includes("▸ src/app.ts  +1 −1"), text);
  assert(text.includes("▸ src/app.test.ts  +1 −0"), text);
});

Deno.test("fold: folding is refused on a non-diff view", () => {
  const doc = {
    text: "const x = 1;\n",
    lines: [{ text: "const x = 1;", spans: [] }],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 10,
  });
  press(s, "f");
  assert(s.view().message.includes("diff view"), s.view().message);
});

Deno.test("fold: revealing the cursor to edit expands every fold", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "app.ts"), "keep\nnew\n");
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
    const diff = [
      "diff --git a/app.ts b/app.ts",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const { doc, edit } = buildDiffDocument(diff, model, ws);
    const s = new Session(
      doc,
      { color: false, showLineNumbers: false },
      { width: 80, height: 30 },
      undefined,
      diffSource(ws, edit),
    );
    press(s, "F"); // collapse the file
    assert(s.displayDoc().lines.length < doc.lines.length, "collapsed");
    press(s, "e"); // reveal the cursor to edit
    assert(s.view().cursor !== null, "cursor revealed");
    assertEquals(
      s.displayDoc().lines.length,
      doc.lines.length,
      "editing expanded every fold",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("fold: a selected node and a search match map onto the summary row", () => {
  const s = foldSession(TWO_FILES);
  press(s, "f"); // collapse file 0 (lines 0..7 → display row 0)
  // Select the collapsed file's node (the first structure node).
  press(s, "tab");
  const sel = s.view().selected;
  assert(sel, "a node is selected");
  assertEquals(sel!.startLine, 0, "the collapsed node sits on the summary row");
  assertEquals(sel!.endLine, 0, "its whole range maps onto that one row");
  // A search for text hidden inside the collapsed file maps to the summary row.
  press(s, "/");
  for (const ch of "keep") press(s, ch);
  press(s, "enter");
  const m = s.view().matches?.[s.view().currentMatch];
  assert(m, "a match was found");
  assertEquals(m!.line, 0, "the hidden match maps to the summary row");
});

Deno.test("fold: F / E / T are refused on a non-diff view", () => {
  const doc = {
    text: "const x = 1;\n",
    lines: [{ text: "const x = 1;", spans: [] }],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 10,
  });
  for (const k of ["F", "E", "T"]) {
    press(s, k);
    assert(s.view().message.includes("diff view"), `${k}: ${s.view().message}`);
  }
});

Deno.test("fold: WASD with no selection picks a node visible on screen while folded", () => {
  const s = foldSession(TWO_FILES);
  press(s, "F"); // collapse everything → summary rows only
  press(s, "tab"); // start navigation with nothing selected
  const sel = s.view().selected;
  assert(sel, "a node was selected");
  // The selected node's (display) start row is on screen.
  assert(
    sel!.startLine >= 0 && sel!.startLine < s.displayDoc().lines.length,
    `selected row ${sel!.startLine} is on screen`,
  );
});

Deno.test("nav: starting navigation with the viewport past every node start selects a node", () => {
  // Two statements far apart; scrolling into the blank gap leaves no node start
  // on screen, so navigation falls back rather than selecting nothing.
  const doc = parseDocument(
    "const a = 1;\n" + "\n".repeat(20) + "const b = 2;\n",
  );
  const s = new Session(doc, { color: false, showLineNumbers: false }, {
    width: 80,
    height: 4,
  });
  for (let i = 0; i < 10; i++) press(s, "j"); // into the gap
  press(s, "tab");
  assert(s.view().selected !== null, "the fallback selected a node");
});

Deno.test("fold: a collapsed file's interior is not navigable", () => {
  const navDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " function f() {}",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,2 +1,2 @@",
    " function g() {}",
    "-x",
    "+y",
    "",
  ].join("\n");
  const s = foldSession(navDiff);
  press(s, "f"); // collapse file 0 (a.ts, at the top)
  const labels = new Set<string>();
  for (let i = 0; i < 16; i++) {
    press(s, "tab");
    const l = s.view().selected?.label;
    if (l) labels.add(l);
  }
  const joined = [...labels].join(" | ");
  assert(
    [...labels].some((l) => l.includes("g")),
    `b.ts's function stays navigable: ${joined}`,
  );
  assert(
    ![...labels].some((l) => l.includes("ƒ f")),
    `a.ts's interior (collapsed) is not navigable: ${joined}`,
  );
  assert(
    [...labels].some((l) => l.includes("a.ts")),
    `the collapsed file itself is still selectable: ${joined}`,
  );
});

Deno.test("line numbers: file mode shows new-file lines and blanks for structure", () => {
  const diff = [
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -40,3 +40,4 @@",
    " keep40",
    "-old",
    "+new41",
    "+new42",
    " keep43",
    "",
  ].join("\n");
  const s = foldSession(diff);
  press(s, "#"); // input position
  const input = s.view().lineNumbers!;
  assertEquals(input[4], 5, "input: the ' keep40' line is input line 5");
  press(s, "#"); // file / message line
  const file = s.view().lineNumbers!;
  // Context/added lines carry their new-file line; the diff structure is blank.
  assertEquals(file[0], null, "the diff --git header has no file line");
  assertEquals(file[3], null, "the hunk header has no file line");
  assertEquals(file[4], 40, "' keep40' is new-file line 40");
  assertEquals(file[5], null, "the removed line has no new-file line");
  assertEquals(file[6], 41, "'+new41' is new-file line 41");
  assertEquals(file[8], 43, "' keep43' is new-file line 43");
});

Deno.test("line numbers: file mode numbers a commit message from one", () => {
  const show = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A",
    "Date:   now",
    "",
    "    Subject",
    "    ",
    "    Body.",
    "",
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const s = foldSession(show);
  press(s, "#", "#"); // → file / message line
  const nums = s.view().lineNumbers!;
  assertEquals(nums[0], null, "the commit header line is blank");
  assertEquals(nums[4], 1, "the subject is message line 1");
  assertEquals(nums[6], 3, "the body is message line 3");
});

Deno.test("fold: navigating after the selected file collapses resumes at that file", () => {
  const navDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " function f() {}",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,2 +1,2 @@",
    " function g() {}",
    "-x",
    "+y",
    "",
  ].join("\n");
  const s = foldSession(navDiff);
  // Dive into the first file's interior.
  press(s, "tab", "tab", "tab");
  const inside = s.view().selected!;
  assert(inside.startLine <= 6, "a node inside the first file is selected");
  press(s, "f"); // collapse the file the selection is in
  press(s, "s"); // navigate: the folded-away selection resumes at the file
  const sel = s.view().selected!;
  assert(sel, "a node is selected after collapsing the selected file");
  assert(sel.label.includes("a.ts") || sel.label.includes("b.ts"), sel.label);
});
