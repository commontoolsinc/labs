/**
 * The Python language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits. Python does not provide structure
 * navigation or a semantic layer.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import {
  createPythonHighlighter,
  pythonDocument,
  pythonHighlightLines,
} from "./python.ts";

export const pythonLanguage: Language = {
  id: "python",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".py", ".pyi", ".pyw"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["py"],
    interpreters: [
      /^python(?:\d+(?:\.\d+)*)?$/,
      /^pypy(?:\d+(?:\.\d+)*)?$/,
    ],
    sharedExtensions: [],
  },

  parseDocument: (text) => pythonDocument(text),

  highlightLines: (text) => pythonHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createPythonHighlighter(text),

  hunkStructure: () => [],
};
