/**
 * The YAML language for the pager. It provides syntax highlighting for direct
 * files, diffs, and live edits. YAML does not provide structure navigation or
 * a semantic layer.
 */
import type { Language } from "../language.ts";
import {
  createYamlHighlighter,
  isYamlPath,
  yamlDocument,
  yamlHighlightLines,
} from "./yaml.ts";

export const yamlLanguage: Language = {
  id: "yaml",

  matches: (fileName) => isYamlPath(fileName),

  parseDocument: (text) => yamlDocument(text),

  highlightLines: (text) => yamlHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createYamlHighlighter(text),

  hunkStructure: () => [],
};
