/**
 * Plain-text documents for files whose syntax `cf view` does not recognize.
 * Every non-empty line is one plain span. The document has no structure or
 * definitions.
 */
import type { Document, Line } from "../../model.ts";
import type { Highlighter } from "../language.ts";

/** Render every source line as one plain span. */
export function plainTextLines(text: string): Line[] {
  return text.split("\n").map((line) => ({
    text: line,
    spans: line.length === 0
      ? []
      : [{ col: 0, text: line, cls: "plain" as const }],
  }));
}

/** Build a document with plain lines and no source-language structure. */
export function plainTextDocument(text: string): Document {
  return {
    text,
    lines: plainTextLines(text),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

/** Rebuild the inexpensive plain lines after each edit. */
export function createPlainTextHighlighter(initial: string): Highlighter {
  let text = initial;
  let lines = plainTextLines(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      text = next;
      lines = plainTextLines(next);
      return lines;
    },
  };
}
