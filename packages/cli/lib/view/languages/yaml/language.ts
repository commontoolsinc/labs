/**
 * The YAML language for the pager. It provides syntax highlighting for direct
 * files, diffs, and live edits. YAML does not provide structure navigation or
 * a semantic layer.
 */
import type { Language } from "../language.ts";
import {
  createYamlHighlighter,
  yamlDocument,
  yamlHighlightLines,
} from "./yaml.ts";

export const yamlLanguage: Language = {
  id: "yaml",

  metadata: {
    extensions: [".yaml", ".yml"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["yml"],
    interpreters: [],
  },

  parseDocument: (text) => yamlDocument(text),

  highlightLines: (text) => yamlHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createYamlHighlighter(text),

  hunkStructure: () => [],
};
