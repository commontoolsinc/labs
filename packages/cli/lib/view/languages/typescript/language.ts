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
  highlightLineEditLocally,
  parseDocument,
} from "./parse.ts";
import { createDiffSemantics, createSemantics } from "./semantics.ts";

export const typeScriptLanguage: Language = {
  id: "typescript",

  // Claims the TypeScript / JavaScript family (`.ts`, `.tsx`, `.mts`, `.cts`,
  // `.js`, `.jsx`, `.mjs`, `.cjs`). It is also the fallback in `languageForFile`
  // for anything unclaimed — a pipe of transformed output, an unknown extension
  // — so those resolve here too, just via that fallback rather than this test.
  matches: (fileName) =>
    fileName !== undefined && /\.[cm]?[jt]sx?$/i.test(fileName),

  parseDocument: (text, fileName) => parseDocument(text, fileName),

  highlightLines: (text, fileName) => highlightDocument(text, fileName),

  highlightFullFileOnDiffEdit: true,

  highlightDiffLineEditLocally: highlightLineEditLocally,

  createHighlighter: (text, fileName) => createHighlighter(text, fileName),

  hunkStructure: (ctx) => remapStructure(ctx),

  // The semantic factories already return `Semantics | undefined`, matching the
  // interface, so they are the methods directly.
  createSemantics,

  createDiffSemantics,
};
