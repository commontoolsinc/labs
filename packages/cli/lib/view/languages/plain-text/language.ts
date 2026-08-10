/**
 * The plain-text language for input whose syntax `cf view` cannot select from
 * a filename or shebang. It remains last in the language registry and is the
 * registry's fallback.
 */
import type { Language } from "../language.ts";
import {
  createPlainTextHighlighter,
  plainTextDocument,
  plainTextLines,
} from "./plain-text.ts";

export const plainTextLanguage: Language = {
  id: "plain-text",

  metadata: {
    extensions: [".txt"],
    filenames: ["LICENSE", "NOTICE"],
    filenamePatterns: [/^(?:LICENSE|NOTICE)\..+$/i],
    aliases: ["text", "plaintext"],
    interpreters: [],
  },

  parseDocument: (text) => plainTextDocument(text),

  highlightLines: (text) => plainTextLines(text),

  createHighlighter: (text) => createPlainTextHighlighter(text),

  hunkStructure: () => [],
};
