/**
 * The JSON, JSONC, and JSON Lines languages for the pager. Coloring and
 * structure live in {@link ./json.ts}; this module adapts them to the
 * {@link Language} contract. JSON Lines uses the same tokenizer with fresh
 * lexical state for each record.
 *
 * JSON has no semantic layer (no types or cross-file definitions to resolve),
 * so it omits `createSemantics`/`createDiffSemantics`. A single JSON or JSONC
 * value contributes a node tree of object keys. One-record JSON Lines input
 * can contribute the same structure, while multi-record input has no
 * cross-record structure. Diff-hunk navigation reuses the generic
 * {@link remapStructure} the TypeScript language also uses.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createJsonHighlighter,
  createJsonLinesHighlighter,
  jsonDocument,
  jsonHighlightLines,
  jsonLinesDocument,
  jsonLinesHighlightLines,
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

/** JSON Lines and NDJSON with lexical state isolated to each record. */
export const jsonLinesLanguage: Language = {
  id: "json-lines",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".jsonl", ".ndjson"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["jsonl", "ndjson"],
    interpreters: [],
  },

  parseDocument: (text) => jsonLinesDocument(text),

  highlightLines: (text) => jsonLinesHighlightLines(text),

  createHighlighter: (text) => createJsonLinesHighlighter(text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
