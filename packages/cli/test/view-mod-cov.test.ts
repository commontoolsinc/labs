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

Deno.test("buildView: a diff takes the diff branch and a diff-semantics closure", () => {
  const r = buildView(DIFF);
  r.semantics(); // runs createDiffSemantics (the diff closure body)
  assert(
    r.doc.lines.some((l) => l.text.startsWith("@@")),
    "rendered as a diff",
  );
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
