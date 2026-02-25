import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import { buildProseDecorations } from "./prose-markdown.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a headless EditorState with markdown parsing and a cursor position. */
function createState(doc: string, cursor = 0): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: GFM })],
    selection: { anchor: cursor },
  });
  // Force the syntax tree to parse the full document so decorations work
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Shorthand to check if any decoration in the list is a replace at the given range. */
function hasReplace(
  decos: ReturnType<typeof buildProseDecorations>,
  from: number,
  to: number,
): boolean {
  return decos.some(
    (d) => d.from === from && d.to === to && isReplace(d.value),
  );
}

/** Shorthand to check if any decoration is a mark with the given class at the given range. */
function hasMark(
  decos: ReturnType<typeof buildProseDecorations>,
  from: number,
  to: number,
  className: string,
): boolean {
  return decos.some(
    (d) =>
      d.from === from && d.to === to &&
      isMark(d.value) &&
      d.value.spec?.class === className,
  );
}

function isReplace(deco: Decoration): boolean {
  // Replace decorations have a non-zero (positive) startSide
  return deco.spec?.inclusive !== undefined || (deco as any).startSide > 0 ||
    deco.spec?.widget !== undefined ||
    (typeof (deco as any).point === "boolean" && (deco as any).point === true);
}

function isMark(deco: Decoration): boolean {
  return typeof deco.spec?.class === "string" &&
    (deco as any).point !== true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildProseDecorations", () => {
  describe("headings", () => {
    it("hides # markers when cursor is elsewhere", () => {
      // "# Hello" — cursor at end of doc (pos 7), not on heading line
      const state = createState("# Hello\nother line", 14);
      const decos = buildProseDecorations(state, true);

      // Should have a replace decoration hiding "# " (positions 0-2)
      expect(hasReplace(decos, 0, 2)).toBe(true);
      // Should have a mark decoration for the heading text
      expect(hasMark(decos, 2, 7, "cm-prose-h1")).toBe(true);
    });

    it("reveals # markers when cursor is on the heading line", () => {
      // Cursor at position 3 (within "# Hello")
      const state = createState("# Hello", 3);
      const decos = buildProseDecorations(state, true);

      // Should NOT have a replace decoration (markers visible)
      expect(hasReplace(decos, 0, 2)).toBe(false);
      // Should still have the heading mark, starting from 0 (includes markers)
      expect(hasMark(decos, 0, 7, "cm-prose-h1")).toBe(true);
    });

    it("maps heading levels to correct CSS classes", () => {
      const state = createState("## Second\n### Third", 18);
      const decos = buildProseDecorations(state, true);

      expect(hasMark(decos, 3, 9, "cm-prose-h2")).toBe(true);
      // h3 — cursor is on the third line, so markers visible
      expect(hasMark(decos, 10, 19, "cm-prose-h3")).toBe(true);
    });
  });

  describe("bold (StrongEmphasis)", () => {
    it("hides ** markers when cursor is elsewhere", () => {
      const state = createState("**bold**\nnext", 10);
      const decos = buildProseDecorations(state, true);

      // ** at 0-2 and 6-8 should be hidden
      expect(hasReplace(decos, 0, 2)).toBe(true);
      expect(hasReplace(decos, 6, 8)).toBe(true);
      // Mark for the full range
      expect(hasMark(decos, 0, 8, "cm-prose-bold")).toBe(true);
    });

    it("reveals ** markers when cursor is inside", () => {
      const state = createState("**bold**", 4);
      const decos = buildProseDecorations(state, true);

      // Markers should NOT be hidden
      expect(hasReplace(decos, 0, 2)).toBe(false);
      expect(hasReplace(decos, 6, 8)).toBe(false);
      // Mark still applied
      expect(hasMark(decos, 0, 8, "cm-prose-bold")).toBe(true);
    });
  });

  describe("italic (Emphasis)", () => {
    it("hides * markers when cursor is elsewhere", () => {
      const state = createState("*italic*\nnext", 10);
      const decos = buildProseDecorations(state, true);

      expect(hasReplace(decos, 0, 1)).toBe(true);
      expect(hasReplace(decos, 7, 8)).toBe(true);
      expect(hasMark(decos, 0, 8, "cm-prose-italic")).toBe(true);
    });
  });

  describe("strikethrough", () => {
    it("hides ~~ markers when cursor is elsewhere", () => {
      const state = createState("~~struck~~\nnext", 12);
      const decos = buildProseDecorations(state, true);

      expect(hasReplace(decos, 0, 2)).toBe(true);
      expect(hasReplace(decos, 8, 10)).toBe(true);
      expect(hasMark(decos, 0, 10, "cm-prose-strikethrough")).toBe(true);
    });
  });

  describe("bullet lists", () => {
    it("replaces - marker with bullet widget when cursor is elsewhere", () => {
      const state = createState("- item\nnext", 8);
      const decos = buildProseDecorations(state, true);

      // Should have a replace widget at 0-2 (the "- " marker)
      const bulletDeco = decos.find(
        (d) => d.from === 0 && d.to === 2 && d.value.spec?.widget,
      );
      expect(bulletDeco).toBeDefined();
    });

    it("reveals - marker when cursor is on the line", () => {
      const state = createState("- item", 3);
      const decos = buildProseDecorations(state, true);

      // No replace widget at 0-2
      const bulletDeco = decos.find(
        (d) => d.from === 0 && d.to === 2 && d.value.spec?.widget,
      );
      expect(bulletDeco).toBeUndefined();
    });
  });

  describe("links", () => {
    it("hides brackets and URL when cursor is elsewhere", () => {
      const state = createState("[text](url)\nnext", 14);
      const decos = buildProseDecorations(state, true);

      // Should have replace decorations hiding [ and ](url)
      // Opening [ at 0-1
      expect(hasReplace(decos, 0, 1)).toBe(true);
      // Closing ] and (url) from position 5 to 11
      const closingReplace = decos.find(
        (d) => d.from === 5 && isReplace(d.value),
      );
      expect(closingReplace).toBeDefined();
      // Link mark on full range
      expect(hasMark(decos, 0, 11, "cm-prose-link")).toBe(true);
    });

    it("reveals full syntax when cursor is inside the link", () => {
      const state = createState("[text](url)", 3);
      const decos = buildProseDecorations(state, true);

      // Should NOT have replace decorations
      expect(hasReplace(decos, 0, 1)).toBe(false);
      // Link mark still applied
      expect(hasMark(decos, 0, 11, "cm-prose-link")).toBe(true);
    });
  });

  describe("unfocused editor", () => {
    it("hides all markers when hasFocus is false", () => {
      // Even though cursor is at position 0 (on heading line),
      // hasFocus=false means we treat it as if cursor is elsewhere
      const state = createState("# Hello", 0);
      const decos = buildProseDecorations(state, false);

      // Markers should be hidden because editor is unfocused
      expect(hasReplace(decos, 0, 2)).toBe(true);
    });
  });

  describe("inline code", () => {
    it("hides backticks when cursor is elsewhere", () => {
      const state = createState("`code`\nnext", 8);
      const decos = buildProseDecorations(state, true);

      // Backtick at 0-1 and 5-6 should be hidden
      expect(hasReplace(decos, 0, 1)).toBe(true);
      expect(hasReplace(decos, 5, 6)).toBe(true);
      // Mark for inline code on the content portion (1-5)
      expect(hasMark(decos, 1, 5, "cm-prose-inline-code")).toBe(true);
    });
  });

  describe("blockquotes", () => {
    it("hides > marker and applies line decoration when cursor is elsewhere", () => {
      const state = createState("> quote\nnext", 10);
      const decos = buildProseDecorations(state, true);

      // > marker hidden (positions 0-2 including space)
      expect(hasReplace(decos, 0, 2)).toBe(true);
      // Line decoration for blockquote
      const lineDeco = decos.find(
        (d) => d.from === 0 && d.value.spec?.class === "cm-prose-blockquote",
      );
      expect(lineDeco).toBeDefined();
    });
  });
});
