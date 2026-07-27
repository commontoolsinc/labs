/**
 * The JSON / JSONC language for the pager. Colouring and structure live in
 * {@link ./json.ts}; this module adapts them to the {@link Language} contract.
 *
 * JSON has no semantic layer (no types or cross-file definitions to resolve),
 * so it omits `createSemantics`/`createDiffSemantics`. Its structure is a node
 * tree of object keys, so its diff-hunk navigation reuses the generic {@link
 * remapStructure} the TypeScript language also uses.
 */
import type { Language } from "../language.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createJsonHighlighter,
  isJsonPath,
  jsonDocument,
  jsonHighlightLines,
} from "./json.ts";

export const jsonLanguage: Language = {
  id: "json",

  matches: (fileName) => isJsonPath(fileName),

  parseDocument: (text) => jsonDocument(text),

  highlightLines: (text) => jsonHighlightLines(text),

  createHighlighter: (text) => createJsonHighlighter(text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
