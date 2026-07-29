/**
 * The plain-text language for input whose syntax `cf view` cannot select from
 * a filename. It must remain last in the language registry because it claims
 * every named file left after the syntax-specific languages; the registry also
 * returns it when no filename exists.
 */
import type { Language } from "../language.ts";
import {
  createPlainTextHighlighter,
  plainTextDocument,
  plainTextLines,
} from "./plain-text.ts";

export const plainTextLanguage: Language = {
  id: "plain-text",

  matches: (fileName) => fileName !== undefined,

  parseDocument: (text) => plainTextDocument(text),

  highlightLines: (text) => plainTextLines(text),

  createHighlighter: (text) => createPlainTextHighlighter(text),

  hunkStructure: () => [],
};
