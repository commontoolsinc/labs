/**
 * The TypeScript (and TSX/JS) language for the pager. It is the catch-all: any
 * file no more specific language claims is coloured and navigated as
 * TypeScript, which is also right for the transformed-pattern blobs the pager is
 * most often handed. Highlighting, structure, incremental editing and the
 * semantic layer all live in the neighbouring {@link ./parse.ts} and {@link
 * ./semantics.ts}; this module only adapts them to the {@link Language}
 * contract.
 */
import type { Language } from "../language.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightDocument,
  parseDocument,
} from "./parse.ts";
import { createDiffSemantics, createSemantics } from "./semantics.ts";

export const typeScriptLanguage: Language = {
  id: "typescript",

  // The catch-all: the registry consults it last, so returning true here means
  // "everything no other language claimed". A pipe of transformed output (no
  // file name) lands here too.
  matches: () => true,

  parseDocument: (text, fileName) => parseDocument(text, fileName),

  highlightLines: (text, fileName) => highlightDocument(text, fileName),

  createHighlighter: (text, fileName) => createHighlighter(text, fileName),

  hunkStructure: (ctx) => remapStructure(ctx),

  createSemantics: (text, options) =>
    createSemantics(text, options) ?? undefined,

  createDiffSemantics: (diffText, maps, options) =>
    createDiffSemantics(diffText, maps, options) ?? undefined,
};
