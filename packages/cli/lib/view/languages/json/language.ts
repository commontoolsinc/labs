/**
 * The JSON / JSONC language for the pager. Coloring and structure live in
 * {@link ./json.ts}; this module adapts them to the {@link Language} contract.
 *
 * JSON has no semantic layer (no types or cross-file definitions to resolve),
 * so it omits `createSemantics`/`createDiffSemantics`. Its structure is a node
 * tree of object keys, so its diff-hunk navigation reuses the generic {@link
 * remapStructure} the TypeScript language also uses.
 */
import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createJsonHighlighter,
  jsonDocument,
  jsonHighlightLines,
} from "./json.ts";

export const jsonLanguage: Language = {
  id: "json",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".json", ".jsonc"],
    filenames: [],
    filenamePatterns: [/\.jsonc?\.example$/i],
    aliases: ["jsonc"],
    interpreters: [],
  },

  parseDocument: (text) => jsonDocument(text),

  highlightLines: (text) => jsonHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createJsonHighlighter(text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
