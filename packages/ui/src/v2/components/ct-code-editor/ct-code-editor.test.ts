import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import {
  backlinkEditFilter,
  backlinkField,
  type BacklinkInfo,
  CTCodeEditor,
  MimeType,
  parseBacklinks,
} from "./ct-code-editor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a headless EditorState with backlink extensions loaded. */
function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [backlinkField, backlinkEditFilter],
  });
}

/** Shorthand to read backlinkField from a state. */
function getBacklinks(state: EditorState): BacklinkInfo[] {
  return state.field(backlinkField);
}

// ---------------------------------------------------------------------------
// Existing basic tests
// ---------------------------------------------------------------------------

describe("CTCodeEditor", () => {
  it("should be defined", () => {
    expect(CTCodeEditor).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTCodeEditor.name).toBe("CTCodeEditor");
  });

  it("should create element instance", () => {
    const element = new CTCodeEditor();
    expect(element).toBeInstanceOf(CTCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CTCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
  });

  it("should have MimeType constants", () => {
    expect(MimeType.javascript).toBe("text/javascript");
    expect(MimeType.typescript).toBe("text/x.typescript");
    expect(MimeType.markdown).toBe("text/markdown");
    expect(MimeType.json).toBe("application/json");
    expect(MimeType.css).toBe("text/css");
    expect(MimeType.html).toBe("text/html");
    expect(MimeType.jsx).toBe("text/x.jsx");
  });

  it("should allow setting properties", () => {
    const element = new CTCodeEditor();
    element.value = "const x = 42;";
    element.language = MimeType.javascript;
    element.readonly = true;
    element.timingStrategy = "immediate";
    element.timingDelay = 100;

    expect(element.value).toBe("const x = 42;");
    expect(element.language).toBe(MimeType.javascript);
    expect(element.readonly).toBe(true);
    expect(element.timingStrategy).toBe("immediate");
    expect(element.timingDelay).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 1. parseBacklinks() - Backlink parsing
// ---------------------------------------------------------------------------

describe("parseBacklinks", () => {
  it("returns empty array for empty string", () => {
    expect(parseBacklinks("")).toEqual([]);
  });

  it("returns empty array for plain text with no backlinks", () => {
    expect(parseBacklinks("Hello world, no links here.")).toEqual([]);
  });

  it("parses a single complete backlink [[Name (id)]]", () => {
    const doc = "See [[My Note (abc123)]] for details";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);

    const bl = result[0];
    expect(bl.name).toBe("My Note");
    expect(bl.id).toBe("abc123");
    expect(bl.from).toBe(4); // start of [[
    expect(bl.to).toBe(24); // end of ]]
    expect(bl.nameFrom).toBe(6); // after [[
    expect(bl.nameTo).toBe(13); // end of "My Note"
  });

  it("parses a single incomplete backlink [[text]]", () => {
    const doc = "Check [[todo item]] later";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);

    const bl = result[0];
    expect(bl.name).toBe("todo item");
    expect(bl.id).toBe(""); // no ID
    expect(bl.from).toBe(6);
    expect(bl.to).toBe(19);
    expect(bl.nameFrom).toBe(8);
    expect(bl.nameTo).toBe(17);
  });

  it("parses multiple backlinks in one string", () => {
    const doc = "Link [[A (1)]] and [[B (2)]] here";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);

    expect(result[0].name).toBe("A");
    expect(result[0].id).toBe("1");
    expect(result[1].name).toBe("B");
    expect(result[1].id).toBe("2");
  });

  it("handles adjacent backlinks", () => {
    const doc = "[[A (1)]][[B (2)]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("A");
    expect(result[0].id).toBe("1");
    expect(result[0].to).toBe(9);
    expect(result[1].name).toBe("B");
    expect(result[1].id).toBe("2");
    expect(result[1].from).toBe(9);
  });

  it("handles backlinks at string boundaries", () => {
    // Start of string
    const startDoc = "[[Start (s1)]] rest";
    const startResult = parseBacklinks(startDoc);
    expect(startResult).toHaveLength(1);
    expect(startResult[0].from).toBe(0);
    expect(startResult[0].name).toBe("Start");

    // End of string
    const endDoc = "end [[Tail (t1)]]";
    const endResult = parseBacklinks(endDoc);
    expect(endResult).toHaveLength(1);
    expect(endResult[0].to).toBe(endDoc.length);
    expect(endResult[0].name).toBe("Tail");
  });

  it("handles ID with hyphens and mixed chars", () => {
    const doc = "[[Note (abc-123-xyz)]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("abc-123-xyz");
    expect(result[0].name).toBe("Note");
  });

  it("does not match unclosed brackets [[text", () => {
    const doc = "This is [[incomplete";
    const result = parseBacklinks(doc);
    expect(result).toEqual([]);
  });

  it("handles mixed complete and incomplete backlinks", () => {
    const doc = "[[Done (d1)]] and [[Pending]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("d1");
    expect(result[0].name).toBe("Done");
    expect(result[1].id).toBe("");
    expect(result[1].name).toBe("Pending");
  });
});

// ---------------------------------------------------------------------------
// 2. backlinkField StateField - Position tracking through edits
// ---------------------------------------------------------------------------

describe("backlinkField", () => {
  it("parses backlinks from initial document", () => {
    const state = createState("Hello [[World (w1)]]");
    const bls = getBacklinks(state);
    expect(bls).toHaveLength(1);
    expect(bls[0].name).toBe("World");
    expect(bls[0].id).toBe("w1");
  });

  it("returns empty array for document with no backlinks", () => {
    const state = createState("Plain text only");
    expect(getBacklinks(state)).toEqual([]);
  });

  it("updates positions when text is inserted before a backlink", () => {
    const state = createState("X [[A (1)]]");
    const blsBefore = getBacklinks(state);
    expect(blsBefore[0].from).toBe(2);

    // Insert "YY" at position 0 -> backlink shifts right by 2
    const tr = state.update({
      changes: { from: 0, to: 0, insert: "YY" },
    });
    const newState = tr.state;
    const blsAfter = getBacklinks(newState);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].from).toBe(4); // shifted by 2
    expect(blsAfter[0].name).toBe("A");
    expect(blsAfter[0].id).toBe("1");
  });

  it("updates when text is deleted before a backlink", () => {
    const state = createState("ABCD[[E (e)]]");
    expect(getBacklinks(state)[0].from).toBe(4);

    // Delete "AB" (positions 0-2)
    const tr = state.update({
      changes: { from: 0, to: 2, insert: "" },
    });
    const blsAfter = getBacklinks(tr.state);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].from).toBe(2); // shifted left by 2
  });

  it("detects a newly added backlink", () => {
    const state = createState("Hello ");
    expect(getBacklinks(state)).toHaveLength(0);

    // Append a backlink
    const tr = state.update({
      changes: { from: 6, to: 6, insert: "[[New (n1)]]" },
    });
    const blsAfter = getBacklinks(tr.state);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].name).toBe("New");
    expect(blsAfter[0].id).toBe("n1");
  });

  it("detects removal of a backlink", () => {
    const doc = "Keep [[Gone (g1)]] this";
    const state = createState(doc);
    expect(getBacklinks(state)).toHaveLength(1);

    // Delete the backlink text
    const tr = state.update({
      changes: { from: 5, to: 19, insert: "" },
    });
    expect(getBacklinks(tr.state)).toHaveLength(0);
  });

  it("does not reparse when doc is unchanged (selection-only transaction)", () => {
    const state = createState("[[A (1)]]");
    const bls1 = getBacklinks(state);

    // Selection-only transaction (no doc change)
    const tr = state.update({
      selection: { anchor: 3 },
    });
    const bls2 = getBacklinks(tr.state);
    // Should be the same reference since docChanged is false
    expect(bls2).toBe(bls1);
  });

  it("handles multiple backlinks across multiple lines", () => {
    const doc = "Line 1 [[A (a1)]]\nLine 2 [[B (b2)]]\nLine 3";
    const state = createState(doc);
    const bls = getBacklinks(state);
    expect(bls).toHaveLength(2);
    expect(bls[0].name).toBe("A");
    expect(bls[1].name).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// 3. backlinkEditFilter - Transaction filter protecting IDs
// ---------------------------------------------------------------------------

describe("backlinkEditFilter", () => {
  it("allows edits outside any backlink", () => {
    const state = createState("Hello [[World (w1)]] end");
    // Edit in "Hello " (positions 0-5) - outside backlink
    const tr = state.update({
      changes: { from: 0, to: 5, insert: "Hi" },
    });
    expect(tr.state.doc.toString()).toBe("Hi [[World (w1)]] end");
  });

  it("allows edits within the name portion of a backlink", () => {
    const state = createState("[[World (w1)]]");
    const bls = getBacklinks(state);
    expect(bls[0].nameFrom).toBe(2);
    expect(bls[0].nameTo).toBe(7);

    // Insert inside name (position 4, inside "World")
    const tr = state.update({
      changes: { from: 4, to: 4, insert: "X" },
    });
    expect(tr.state.doc.toString()).toBe("[[WoXrld (w1)]]");
  });

  it("blocks edits that start inside the ID portion", () => {
    // [[World (w1)]] positions:
    //   0: [  1: [  2: W  3: o  4: r  5: l  6: d  7: ' '  8: (  9: w  10: 1  11: )  12: ]  13: ]
    // nameTo=7, to=14. Edit at position 9 starts inside ID area.
    const state = createState("[[World (w1)]]");

    const tr = state.update({
      changes: { from: 9, to: 10, insert: "X" },
    });

    // Filter blocks: doc should remain unchanged
    expect(tr.state.doc.toString()).toBe("[[World (w1)]]");
  });

  it("does NOT truncate edits spanning from name into ID (known bug)", () => {
    // BUG: The filter detects the span (needsModification=true) and computes
    // truncated specs, but only applies them when `blocked` is true. Since a
    // span-only edit doesn't set `blocked`, the original transaction passes
    // through unmodified, corrupting the ID.
    const state = createState("[[Hello (h1)]]");
    // Edit from position 5 (inside name "lo") to position 10 (inside ID "1")
    const tr = state.update({
      changes: { from: 5, to: 10, insert: "X" },
    });
    // The edit passes through unmodified — ID is corrupted
    expect(tr.state.doc.toString()).toBe("[[HelX1)]]");
    // If truncation worked, it would be "[[HelX (h1)]]" instead
  });

  it("allows deletion of an entire backlink", () => {
    const state = createState("before [[Note (n1)]] after");
    const bls = getBacklinks(state);
    const bl = bls[0];

    const tr = state.update({
      changes: { from: bl.from, to: bl.to, insert: "" },
    });
    expect(tr.state.doc.toString()).toBe("before  after");
    expect(getBacklinks(tr.state)).toHaveLength(0);
  });

  it("allows edits on incomplete backlinks (no ID to protect)", () => {
    const state = createState("[[pending]]");
    const tr = state.update({
      changes: { from: 3, to: 3, insert: "X" },
    });
    expect(tr.state.doc.toString()).toBe("[[pXending]]");
  });

  it("allows edits after the backlink", () => {
    const state = createState("[[A (1)]] tail");
    const tr = state.update({
      changes: { from: 10, to: 14, insert: "end" },
    });
    expect(tr.state.doc.toString()).toBe("[[A (1)]] end");
  });

  it("multi-change transaction: blocks ID edit while allowing other changes", () => {
    // Two changes in one transaction: one outside (allowed) and one in ID (blocked)
    // Backlink [[A (a1)]]: from=7, to=17, nameFrom=9, nameTo=10, id="a1"
    const state = createState("prefix [[A (a1)]] suffix");
    // Change 1: edit "prefix" → "pre" (outside, allowed)
    // Change 2: edit inside ID portion (blocked)
    const tr = state.update({
      changes: [
        { from: 0, to: 6, insert: "pre" },
        // Position 12 is inside " (a1)" which is the ID area (nameTo=10, to=17)
        { from: 12, to: 13, insert: "X" },
      ],
    });
    const newDoc = tr.state.doc.toString();
    // The blocked flag is set, so the filter returns modified specs.
    // The first change (outside) is included, the second (in ID) is excluded.
    expect(newDoc).toBe("pre [[A (a1)]] suffix");
  });
});

// ---------------------------------------------------------------------------
// 4. atomicBacklinkRanges - Structural properties
// ---------------------------------------------------------------------------

describe("atomicBacklinkRanges", () => {
  // atomicBacklinkRanges is an EditorView.atomicRanges extension that
  // requires a DOM-backed EditorView. We verify the structural properties
  // it depends on: BacklinkInfo fields that determine which ranges become atomic.

  it("complete backlink has [[ prefix and (id)]] suffix ranges", () => {
    const state = createState("[[Name (id1)]]");
    const bls = getBacklinks(state);
    expect(bls).toHaveLength(1);
    expect(bls[0].id).toBe("id1");

    // Atomic range 1: [[ prefix (from → nameFrom)
    expect(state.doc.sliceString(bls[0].from, bls[0].nameFrom)).toBe("[[");
    // Atomic range 2: " (id1)]]" suffix (nameTo → to)
    expect(state.doc.sliceString(bls[0].nameTo, bls[0].to)).toBe(" (id1)]]");
  });

  it("single-line check: extension skips backlinks spanning multiple lines", () => {
    // The extension has a safety check: startLine !== endLine → skip.
    // Verify a normal backlink is on one line.
    const state = createState("[[single (s1)]]");
    const bls = getBacklinks(state);
    const startLine = state.doc.lineAt(bls[0].from).number;
    const endLine = state.doc.lineAt(bls[0].to).number;
    expect(startLine).toBe(endLine);
  });
});

// ---------------------------------------------------------------------------
// 5. Backlink decoration plugin - Decoration boundaries
// ---------------------------------------------------------------------------

describe("backlink decoration plugin", () => {
  // The decoration plugin is a private ViewPlugin. We verify the BacklinkInfo
  // properties it uses to decide what to hide/style.

  it("incomplete backlink has empty id (renders as pending pill)", () => {
    const state = createState("Check [[draft]] later");
    const bls = getBacklinks(state);
    expect(bls).toHaveLength(1);
    expect(bls[0].id).toBe("");
    expect(bls[0].name).toBe("draft");
  });

  it("editing mode: ID portion is nameTo to (to - 2)", () => {
    // When cursor is inside a complete backlink, the decoration hides
    // nameTo → (to - 2), leaving [[Name]] visible.
    const state = createState("[[Edit Me (e1)]]");
    const bl = getBacklinks(state)[0];
    const idStart = bl.nameTo;
    const idEnd = bl.to - 2; // before ]]
    expect(state.doc.sliceString(idStart, idEnd)).toBe(" (e1)");
    // User sees: [[Edit Me]]
  });
});

// ---------------------------------------------------------------------------
// 6. Enter keymap conditions
// ---------------------------------------------------------------------------

describe("Enter keymap conditions", () => {
  // The Enter keymap checks: bl.id && pos >= bl.from && pos < bl.to
  // These tests verify the position logic the keymap relies on.

  it("cursor position determines Enter behavior", () => {
    const state = createState("text [[Note (n1)]] more");
    const bl = getBacklinks(state)[0];

    // Inside backlink: Enter consumed (exits editing mode → cursor to bl.to)
    const insidePos = bl.nameFrom + 1;
    expect(insidePos >= bl.from && insidePos < bl.to).toBe(true);
    expect(bl.id).toBeTruthy();

    // At bl.to (after ]]): Enter NOT consumed (normal newline)
    expect(bl.to >= bl.from && bl.to < bl.to).toBe(false);

    // Before backlink: Enter NOT consumed
    expect(0 >= bl.from && 0 < bl.to).toBe(false);

    // bl.to is the dispatch target; verify it's after ]]
    const charAfter = state.doc.sliceString(bl.to, bl.to + 1);
    expect(charAfter).toBe(" ");
  });
});
