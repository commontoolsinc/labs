/**
 * The plain-text language for named files whose syntax `cf view` does not
 * recognize. It must remain last in the language registry because it claims
 * every filename left after the syntax-specific languages.
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
