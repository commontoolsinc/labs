/**
 * Coverage-focused tests for the diff editable source (`lib/view/diffedit.ts`).
 *
 * These drive the source's callbacks (revert, expandContext, dirtyLabels, save)
 * and the incremental highlighter directly, reaching the error and edge branches
 * the session-level tests don't normally exercise: a diff that no longer parses,
 * a cursor outside any file or hunk, a path mismatch between the edited and the
 * original diff, a missing workspace file, a hunk with no room to expand, the
 * read-only (no-disk) source, and the defensive guards in `save`.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffEdit,
  type DiffWorkspace,
} from "../lib/view/diffdoc.ts";
import {
  _internal as _de,
  createDiffHighlighter,
  diffSource,
} from "../lib/view/diffedit.ts";

/** A workspace backed by a real temp dir. */
function tempWs(
  files: Record<string, string>,
): { root: string; ws: DiffWorkspace; done: () => void } {
  const root = Deno.makeTempDirSync();
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(join(root, name), content);
  }
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

/** Build the editable source for a diff against a workspace. */
function sourceFor(diff: string, ws: DiffWorkspace) {
  const model = parseDiff(diff)!;
  const { edit } = buildDiffDocument(diff, model, ws);
  return { src: diffSource(ws, edit), edit };
}

const FILE_TEXT = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 0;
+const y = 2;
 const z = 3;
`;

// --- revert error branches ---------------------------------------------------

Deno.test("diffedit cov: revert returns null when the edited text no longer parses as a diff", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // `current` is not a diff at all, so parseDiff(current) is null. The text
    // differs from the original, so the early `original === current` guard does
    // not fire — execution reaches the `!cur || !base` guard.
    const out = src.revert!(DIFF, "this is just some plain text\n", 0, "chunk");
    assertEquals(out, null, "an unparseable edited diff reverts to nothing");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert returns null when the cursor is outside every file", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = DIFF.replace("+const y = 2;", "+const y = 2;X");
    // A cursor line far past the diff sits in no file.
    const out = src.revert!(DIFF, edited, 9999, "chunk");
    assertEquals(out, null, "no file under the cursor: nothing to revert");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert returns null when the file at the cursor's index has a different path", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "a.ts"), "a1\na2\n");
    Deno.writeTextFileSync(join(root, "b.ts"), "b1\nb2\n");
    Deno.writeTextFileSync(join(root, "c.ts"), "c1\nc2\n");
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
    // The original's second file is b.ts; the "current" second file is c.ts, so
    // at file index 1 the paths disagree and revert bails out.
    const original = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 a1
-a0
+a2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 b1
-b0
+b2
`;
    const current = original
      .replace("a/b.ts b/b.ts", "a/c.ts b/c.ts")
      .replace("--- a/b.ts", "--- a/c.ts")
      .replace("+++ b/b.ts", "+++ b/c.ts")
      .replace(" b1", " c1")
      .replace("-b0", "-c0")
      .replace("+b2", "+c2");
    const { src } = sourceFor(original, ws);
    // Cursor on the second file's hunk (its line index in the current text).
    const curFileLine = current.split("\n").indexOf(" c1");
    const out = src.revert!(original, current, curFileLine, "chunk");
    assertEquals(
      out,
      null,
      "a path mismatch at the cursor's file index is a no-op",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit cov: revert with the 'file' scope restores the whole file's slice", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = DIFF.replace("+const y = 2;", "+const y = 2;EDIT");
    // The cursor sits inside the hunk, but the "file" scope reverts the file as
    // a whole regardless.
    const cursor = edited.split("\n").indexOf("+const y = 2;EDIT");
    const out = src.revert!(DIFF, edited, cursor, "file")!;
    assert(out !== null, "file revert produced a result");
    assert(!out.text.includes("const y = 2;EDIT"), "the file edit is undone");
    assertEquals(out.text, DIFF, "the file slice is restored to the original");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: revert chunk returns null when the original has no matching hunk", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "l1\nl2\nl3\nl4\nl5\nl6\n");
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
    // The original has one hunk; the "current" has gained a second hunk in the
    // same file. A chunk revert of the second hunk finds it in `current` but not
    // in `base`, so `baseHunk` is undefined and revert returns null.
    const original = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 l1
-l0
+l2
`;
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 l1
-l0
+l2
@@ -5,2 +5,2 @@
 l5
-x6
+l6
`;
    const { src } = sourceFor(original, ws);
    const cursor = current.split("\n").lastIndexOf("+l6");
    const out = src.revert!(original, current, cursor, "chunk");
    assertEquals(
      out,
      null,
      "no original hunk at that index: nothing to revert",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// --- expandContext error branches -------------------------------------------

const EXPAND_FILE = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
const EXPAND_DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;

Deno.test("diffedit cov: expandContext returns null when the text no longer parses", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    const out = src.expandContext!("not a diff\n", "not a diff\n", 0);
    assertEquals(out, null, "an unparseable diff cannot be expanded");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the cursor is in no hunk", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // The file/header lines (line 0) are in no hunk body.
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, 0);
    assertEquals(
      out,
      null,
      "with no hunk under the cursor there is nothing to expand",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the file cannot be resolved", () => {
  const { root, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // The workspace resolves and reads at build time (so the source is editable
    // and exposes expandContext), then `resolve` is flipped off so the later
    // expand finds no path for the hunk's file.
    let resolveOk = true;
    const ws: DiffWorkspace = {
      resolve: (p) => (resolveOk ? join(root, p) : null),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const { src } = sourceFor(EXPAND_DIFF, ws);
    resolveOk = false;
    const cursor = EXPAND_DIFF.split("\n").indexOf(" gamma");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor);
    assertEquals(out, null, "no resolvable path: cannot read more context");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the file content cannot be read", () => {
  const { root, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // Resolves fine throughout, but `read` is flipped off after build, so the
    // expand cannot fetch the file's lines.
    let readOk = true;
    const ws: DiffWorkspace = {
      resolve: (p) => join(root, p),
      read: (a) => {
        if (!readOk) return null;
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    };
    const { src } = sourceFor(EXPAND_DIFF, ws);
    readOk = false;
    const cursor = EXPAND_DIFF.split("\n").indexOf(" gamma");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor);
    assertEquals(out, null, "unreadable file: cannot reveal more context");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the hunk already covers the whole file", () => {
  // The hunk spans the entire two-line file, so there is no context above or
  // below it to reveal.
  const { ws, done } = tempWs({ "m.ts": "one\ntwo\n" });
  try {
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 one
-t...
+two
`;
    const { src } = sourceFor(diff, ws);
    const cursor = diff.split("\n").indexOf(" one");
    const out = src.expandContext!(diff, diff, cursor);
    assertEquals(out, null, "a whole-file hunk has nothing left to expand");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the baseline has fewer hunks", () => {
  const { ws, done } = tempWs({
    "m.ts": "a\nb\nc\nd\ne\nf\ng\nh\n",
  });
  try {
    // `current` carries a second hunk; `baseline` carries only the first. The
    // cursor sits in the second hunk, so the global hunk index is 1, which the
    // baseline's flattened hunk list does not have.
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
@@ -6,3 +6,3 @@
 f
-y
+g
 h
`;
    const baseline = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
`;
    const { src } = sourceFor(current, ws);
    const cursor = current.split("\n").indexOf(" f");
    const out = src.expandContext!(current, baseline, cursor);
    assertEquals(
      out,
      null,
      "the baseline lacks the cursor's hunk: no expansion",
    );
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext returns null when the hunk header is malformed for the expansion regex", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    // A bare "@@ -3 noise" line sits before the file header. parseDiff treats it
    // as "other" (it has no `+` side), so the model still finds the real hunk at
    // global index 0 and the cursor maps into it. But applyExpansion scans for
    // any line matching /^@@ -\d/ and reaches this orphan first; the strict
    // header regex then rejects it, so applyExpansion returns null and the whole
    // expansion bails out.
    const diff = `@@ -3 noise
diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -3,3 +3,3 @@
 gamma
-old delta
+delta
 epsilon
`;
    const { src } = sourceFor(diff, ws);
    const cursor = diff.split("\n").indexOf(" epsilon");
    const out = src.expandContext!(diff, diff, cursor);
    assertEquals(out, null, "a malformed hunk header cannot be expanded");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext reveals context below the hunk and grows its counts", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // The cursor on the hunk's bottom context line expands downward.
    const cursor = EXPAND_DIFF.split("\n").indexOf(" epsilon");
    const out = src.expandContext!(EXPAND_DIFF, EXPAND_DIFF, cursor)!;
    assert(out !== null, "a backing file with room below expands");
    assert(out.text.includes(" zeta"), "the line below the hunk is revealed");
    assert(out.inserted > 0, "at least one line was inserted");
    // The grown header reflects the larger hunk (3 lines of context become 4).
    const header = out.text.split("\n").find((l) => l.startsWith("@@"))!;
    assertEquals(header, "@@ -3,4 +3,4 @@");
    // Revealing context is not an edit: the baseline grows the same way.
    assert(out.baseline.includes(" zeta"), "the baseline grew identically");
  } finally {
    done();
  }
});

// --- dirtyLabels branches ----------------------------------------------------

Deno.test("diffedit cov: dirtyLabels returns empty when a side fails to parse", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // The edited text is not a diff, so parseDiff(current) is null. The original
    // and current differ, so the early equality guard does not fire.
    assertEquals(src.dirtyLabels!(DIFF, "plain text, not a diff\n"), []);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: dirtyLabels names a single file when a change is inside its slice", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
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
    const original = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;
    // The edit is inside x.ts's header..endLine slice, so the per-file body
    // comparison attributes it to x.ts directly (the non-fallback branch).
    const current = original.replace("+const y = 3;", "+const y = 30;");
    const { src } = sourceFor(original, ws);
    assertEquals(src.dirtyLabels!(original, current), ["x.ts"]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diffedit cov: dirtyLabels names no file when the change pins to none (e.g. a message)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "x.ts"), "const x = 1;\nconst y = 3;\n");
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
    // A leading noise line precedes the first file. Both diffs carry it; the
    // edit only changes that leading line, which sits outside every file's
    // header..endLine slice, so no per-file body differs — a save writes no
    // file, and dirtyLabels names none.
    const original = `preamble note
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;
    const current = original.replace("preamble note", "preamble note EDITED");
    const { src } = sourceFor(original, ws);
    assertEquals(
      src.dirtyLabels!(original, current),
      [],
      "a change outside every file slice names no file",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// --- createDiffHighlighter: getter, no-op update, markdown line scan ----------

Deno.test("diffedit cov: the highlighter's lines getter returns the seeded lines and a no-op update is a no-op", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const model = parseDiff(DIFF)!;
    const { doc } = buildDiffDocument(DIFF, model, ws);
    const hl = createDiffHighlighter(DIFF, doc.lines);
    // The getter exposes the seed.
    assertEquals(
      hl.lines.length,
      doc.lines.length,
      "lines getter returns the seed",
    );
    assertEquals(hl.lines[0].text, doc.lines[0].text);
    // Updating with the identical text short-circuits and returns the same set.
    const same = hl.update(DIFF);
    assertEquals(same, hl.lines, "a no-op update returns the existing lines");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: the highlighter recolours a Markdown body line via the +++ header scan", () => {
  // Seed-less so the highlighter renders every line itself, then edit a body
  // line whose nearest preceding header is `+++ b/doc.md` — exercising the
  // Markdown-aware path in the recolour.
  const diff = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,2 +1,2 @@
 # Title
-old body
+new body text
`;
  const hl = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  const bodyIdx = raw.indexOf("+new body text");
  raw[bodyIdx] = "+new body text changed";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[bodyIdx].text, "+new body text changed");
  // The marker keeps its added-line colour.
  assertEquals(out[bodyIdx].spans[0].cls, "diffAdd");
});

Deno.test("diffedit cov: a CRLF .ts header selects TypeScript for edited lines", () => {
  const diff = [
    "diff --git a/generic.ts b/generic.ts\r",
    "--- a/generic.ts\r",
    "+++ b/generic.ts\r",
    "@@ -0,0 +1 @@\r",
    "+const identity = <T>(value: T): T => value;\r",
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("value;", "value ;");
  const line = highlighter.update(raw.join("\n"))[4];
  assertEquals(
    line.spans.find((span) => span.text === "value" && span.cls === "parameter")
      ?.cls,
    "parameter",
  );
});

Deno.test("diffedit cov: renamed removed lines use the old extension", () => {
  const diff = `diff --git a/generic.ts b/generic.tsx
--- a/generic.ts
+++ b/generic.tsx
@@ -1 +1 @@
-const identity = <T>(value: T): T => value;
+const view = <div>ready</div>;
`;
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("value;", "value ;");
  const line = highlighter.update(raw.join("\n"))[4];
  assertEquals(
    line.spans.find((span) => span.text === "value" && span.cls === "parameter")
      ?.cls,
    "parameter",
  );
});

Deno.test("diffedit cov: source lines resembling file headers keep the diff path", () => {
  const diff = `diff --git a/generic.ts b/generic.ts
--- a/generic.ts
+++ b/generic.ts
@@ -1 +1 @@
--- oldValue; const before = <T>(input: T): T => input;
+++ newValue; const after = <T>(input: T): T => input;
`;
  const highlighter = createDiffHighlighter(diff);
  const raw = diff.split("\n");
  raw[4] = raw[4].replace("oldValue", "previousValue");
  raw[5] = raw[5].replace("newValue", "nextValue");
  const lines = highlighter.update(raw.join("\n"));
  for (const index of [4, 5]) {
    assertEquals(
      lines[index].spans.find((span) =>
        span.text === "input" && span.cls === "parameter"
      )?.cls,
      "parameter",
      `line ${index + 1} uses the .ts parser`,
    );
  }
});

Deno.test("diffedit cov: the highlighter scans past a missing +++ to the diff --git Markdown header", () => {
  // No `+++ ` line at all (a truncated header), so the backward scan from the
  // edited body line reaches the `diff --git ...md` header instead.
  const text = [
    "diff --git a/notes.md b/notes.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+text",
  ].join("\n");
  const hl = createDiffHighlighter(text);
  const raw = text.split("\n");
  const idx = raw.indexOf("+text");
  raw[idx] = "+text more";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[idx].text, "+text more");
  assertEquals(out[idx].spans[0].cls, "diffAdd");
});

Deno.test("diffedit cov: the highlighter returns plain (non-Markdown) colouring when no header precedes a line", () => {
  // A body-only fragment with no preceding header: the backward scan finds
  // nothing and reports not-Markdown.
  const text = [" context", "-old", "+changed"].join("\n");
  const hl = createDiffHighlighter(text);
  const raw = text.split("\n");
  raw[2] = "+changed more";
  const out = hl.update(raw.join("\n"));
  assertEquals(out[2].text, "+changed more");
  assertEquals(out[2].spans[0].cls, "diffAdd");
});

// --- read-only source and save's defensive guards ---------------------------

Deno.test("diffedit cov: a diff matching no file on disk yields a read-only source whose save is a no-op", () => {
  // An empty `lines` map means nothing on disk backs the diff: the source is
  // read-only and its save reports there is nothing to write.
  const emptyEdit: DiffEdit = {
    lines: new Map(),
    fileText: new Map(),
    hunks: [],
  };
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const src = diffSource(ws, emptyEdit);
  assertEquals(src.editable, false, "no backing file: not editable");
  assertEquals(src.label, null);
  assert(
    (src.reason ?? "").includes("doesn't match"),
    "the reason explains the diff matches nothing",
  );
  assertEquals(
    src.save("any text"),
    "Nothing to save — this diff matches no file on disk.",
  );
});

Deno.test("diffedit cov: save skips a verified hunk whose file was not captured and reports nothing written", () => {
  // A hand-built edit: one verified hunk pointing at a path that is NOT present
  // in `fileText`. save() collects it into `byFile` but then finds no base
  // content for the path, skips it, and (nothing written) returns the empty
  // message. `lines` is non-empty so the source is the editable one, not the
  // read-only branch.
  const edit: DiffEdit = {
    lines: new Map([[5, { absPath: "/ghost/m.ts", newLine: 0, markerLen: 1 }]]),
    fileText: new Map(), // deliberately missing /ghost/m.ts
    hunks: [
      { absPath: "/ghost/m.ts", newStart: 1, newCount: 1, verified: true },
    ],
  };
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const src = diffSource(ws, edit);
  assertEquals(src.editable, true, "a non-empty lines map is editable");
  // One hunk body, so save matches it to the (verified) recorded hunk.
  const text = "@@ -1,1 +1,1 @@\n+only line\n";
  assertEquals(
    src.save(text),
    "Saved 0 files",
    "an uncaptured file is skipped, leaving nothing written",
  );
});

Deno.test("diffedit cov: save writes the verified hunk's new side back to the captured file", () => {
  const { root, ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    // Edit the added line's content, then save: the new side replaces the file
    // line range the hunk recorded.
    const edited = DIFF.replace("+const y = 2;", "+const y = 2; // saved");
    const msg = src.save(edited);
    assert(msg.startsWith("Saved"), `save reports success: ${msg}`);
    const onDisk = Deno.readTextFileSync(join(root, "m.ts")).split("\n");
    assertEquals(onDisk[1], "const y = 2; // saved");
    assertEquals(onDisk[0], "const x = 1;");
    assertEquals(onDisk[2], "const z = 3;");
  } finally {
    done();
  }
});

// --- editableStart: position/verified-aware line editability -----------------

Deno.test("editableStart: a null model (buffer is not a diff) refuses every line", () => {
  assertEquals(_de.editableStart(null, [], " some text", 0), null);
});

Deno.test("editableStart: editable only inside a verified hunk", () => {
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,3 @@
 keep
-old
+new
+added
`;
  const model = parseDiff(diff)!;
  const lines = diff.split("\n");
  // One hunk, marked verified and backed by a file.
  const verified = [{
    absPath: "/x",
    newStart: 1,
    newCount: 3,
    verified: true,
  }];
  // Line 4 = " keep" (ctx) → editable past the marker; 5 = "-old" (removed) →
  // refused; 6/7 = "+new"/"+added" (add) → editable; 0 = the file header → not
  // in any hunk, refused.
  assertEquals(_de.editableStart(model, verified, lines[4], 4), 1, "context");
  assertEquals(
    _de.editableStart(model, verified, lines[5], 5),
    null,
    "removed",
  );
  assertEquals(_de.editableStart(model, verified, lines[6], 6), 1, "added");
  assertEquals(_de.editableStart(model, verified, lines[0], 0), null, "header");
  // The same hunk, unverified: even its context/added lines are refused.
  const unver = [{ absPath: null, newStart: 1, newCount: 3, verified: false }];
  assertEquals(
    _de.editableStart(model, unver, lines[4], 4),
    null,
    "unverified",
  );
});

// --- commit amend helpers ----------------------------------------------------

Deno.test("pendingAmend: null when there is no editable message", () => {
  assertEquals(
    _de.pendingAmend(() => null, () => null, false, "a", "b"),
    null,
  );
});

Deno.test("pendingAmend: null when the full buffer is unchanged", () => {
  const msg = { sha: "abcdef1", start: 0, end: 0 };
  const both = () => msg;
  assertEquals(_de.pendingAmend(both, both, false, "    hi", "    hi"), null);
});

Deno.test("pendingAmend: an unchanged message still amends changed commit contents", () => {
  const msg = { sha: "abcdef1", start: 0, end: 0 };
  const both = () => msg;
  assertEquals(
    _de.pendingAmend(both, both, true, "    hi\n-old", "    hi\n+new"),
    { sha: "abcdef1", subject: "hi" },
  );
});

Deno.test("baselineAfterSave: keeps the baseline for a changed hunk layout", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const moved = DIFF.replace("b/m.ts", "b/other.ts");
    assertEquals(
      src.baselineAfterSave!(DIFF, moved, { amendCommit: false }),
      DIFF,
    );

    const extra = `${DIFF}@@ -5,0 +6,1 @@\n+extra\n`;
    assertEquals(
      src.baselineAfterSave!(DIFF, extra, { amendCommit: false }),
      DIFF,
    );
  } finally {
    done();
  }
});

Deno.test("diffSource: ignores commit-shaped text inside a file diff", () => {
  const head = "1".repeat(40);
  const embedded = "2".repeat(40);
  const text = [
    `From ${head} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Subject",
    "",
    "diff --git a/m.ts b/m.ts",
    "index 1111..2222 100644",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    `From ${embedded} Mon Sep 17 00:00:00 2001`,
    "From: C D <c@d.example>",
    "Date: Thu, 2 Jul 2026 12:00:00 -0700",
    "Subject: embedded text",
    "",
  ].join("\n");
  const { ws, done } = tempWs({ "m.ts": "new\n" });
  const matched: string[] = [];
  try {
    const model = parseDiff(text)!;
    const { edit } = buildDiffDocument(text, model, ws);
    const src = diffSource(ws, edit, undefined, {
      headSha: () => head,
      fileAtCommit: () => null,
      applyFileChanges: (committed) => committed,
      amendCommit: () => ({ status: "unused", head }),
      commitMatchesDiff: (commit) => {
        matched.push(commit);
        return commit === head;
      },
    });
    const edited = text.replace("+new", "+newer");

    assertEquals(src.pendingAmend!(text, edited), {
      sha: head,
      subject: "(empty commit message)",
    });
    assertEquals(matched, [head]);
  } finally {
    done();
  }
});

Deno.test("save: rejects a diff with a different hunk count", () => {
  const { root, ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(DIFF, ws);
    const edited = `${DIFF.replace("+const y = 2;", "+const y = 20;")}` +
      `@@ -3,0 +4,1 @@\n+const added = true;\n`;

    assertThrows(
      () => src.save(edited, DIFF, { amendCommit: false }),
      Error,
      "The edited diff no longer matches its saved hunk map.",
    );
    assertEquals(Deno.readTextFileSync(join(root, "m.ts")), FILE_TEXT);
  } finally {
    done();
  }
});

// --- message-scope revert ----------------------------------------------------

const SHOW_DIFF = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: A B <a@b>",
  "Date:   now",
  "",
  "    Subject",
  "",
  "diff --git a/m.ts b/m.ts",
  "--- a/m.ts",
  "+++ b/m.ts",
  "@@ -1,2 +1,2 @@",
  " const x = 1;",
  "-const y = 0;",
  "+const y = 2;",
  " const z = 3;",
  "",
].join("\n");

Deno.test("diffedit cov: message revert restores the message region", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(SHOW_DIFF, ws);
    const edited = SHOW_DIFF.replace("    Subject", "    Subject CHANGED");
    const out = src.revert!(SHOW_DIFF, edited, 4, "message")!;
    assert(out, "reverted");
    assertEquals(out.text.split("\n")[4], "    Subject", "message restored");
  } finally {
    done();
  }
});

Deno.test("diffedit cov: message revert is null when the cursor is in no message", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    const { src } = sourceFor(SHOW_DIFF, ws);
    const edited = SHOW_DIFF.replace("    Subject", "    Subject CHANGED");
    // Cursor on the "commit" line, outside the indented message region.
    assertEquals(src.revert!(SHOW_DIFF, edited, 0, "message"), null);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: message revert is null when the baseline has no such region", () => {
  const { ws, done } = tempWs({ "m.ts": FILE_TEXT });
  try {
    // Original has no commit header; current gains one. The baseline lacks the
    // message region the cursor is in, so the revert declines.
    const original = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,2 +1,2 @@",
      " const x = 1;",
      "-const y = 0;",
      "+const y = 2;",
      " const z = 3;",
      "",
    ].join("\n");
    const { src } = sourceFor(original, ws);
    assertEquals(src.revert!(original, SHOW_DIFF, 4, "message"), null);
  } finally {
    done();
  }
});

// --- expandRoom and the join helpers ----------------------------------------

Deno.test("diffedit cov: expandRoom is empty when the text no longer parses", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // A non-diff has no hunks to report room for.
    assertEquals(src.expandRoom!("not a diff\n").size, 0);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandRoom skips a hunk whose file has no new side", () => {
  const { ws, done } = tempWs({ "m.ts": EXPAND_FILE });
  try {
    const { src } = sourceFor(EXPAND_DIFF, ws);
    // A deleted file's new path is /dev/null, i.e. absent, so its hunk backs no
    // workspace file and offers no room — hunkFooting returns null for it.
    const del = `diff --git a/m.ts b/m.ts
deleted file mode 100644
--- a/m.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-beta
`;
    assertEquals(src.expandRoom!(del).size, 0);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: expandContext declines when the save map lacks the cursor's hunk", () => {
  const { ws, done } = tempWs({ "m.ts": "a\nb\nc\nd\ne\nf\ng\nh\n" });
  try {
    // The source is built from a one-hunk diff, so its save map has one entry.
    // A later `current` grows a second hunk; a cursor in it resolves to global
    // index 1, which the save map does not have — hunkFooting finds no range.
    const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
`;
    const { src } = sourceFor(oneHunk, ws);
    const current = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 a
-x
+b
 c
@@ -6,3 +6,3 @@
 f
-y
+g
 h
`;
    const cursor = current.split("\n").indexOf(" f");
    assertEquals(src.expandContext!(current, current, cursor), null);
  } finally {
    done();
  }
});

Deno.test("diffedit cov: dropHeaderBetween declines a non-diff and a lone hunk", () => {
  // A non-diff has no hunks to join.
  assertEquals(_de.dropHeaderBetween("not a diff", 0), null);
  // A single hunk has no second one to take the header off.
  const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
`;
  assertEquals(_de.dropHeaderBetween(oneHunk, 0), null);
});

Deno.test("diffedit cov: joinAdjacent declines when the text will not drop a header", () => {
  // The save map claims two adjacent, verified, same-file hunks, but the text
  // holds only one, so dropHeaderBetween finds no pair and the join backs out.
  const oneHunk = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
`;
  const hunks = [
    { absPath: "/x", newStart: 1, newCount: 1, verified: true },
    { absPath: "/x", newStart: 2, newCount: 1, verified: true },
  ];
  assertEquals(_de.joinAdjacent(oneHunk, oneHunk, hunks, 0), null);
});

Deno.test("diffedit cov: joinAdjacent keeps hunks from different commits separate", () => {
  const twoHunks = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-a
+A
@@ -2,1 +2,1 @@
-b
+B
`;
  const hunks = [
    {
      absPath: "/x",
      newStart: 1,
      newCount: 1,
      verified: true,
      writable: true,
      commitSha: "1111",
    },
    {
      absPath: "/x",
      newStart: 2,
      newCount: 1,
      verified: true,
      writable: true,
      commitSha: "2222",
    },
  ];

  assertEquals(_de.joinAdjacent(twoHunks, twoHunks, hunks, 0), null);
  assertEquals(hunks.length, 2);
});
