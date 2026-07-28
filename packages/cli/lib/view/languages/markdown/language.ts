/**
 * The Markdown language for the pager. Colouring and structure live in {@link
 * ./markdown.ts}; this module adapts them to the {@link Language} contract.
 *
 * Markdown has no semantic layer (no `createSemantics`/`createDiffSemantics`),
 * and its diff-hunk navigation is heading-based rather than the generic node
 * remap, so {@link hunkStructure} routes to {@link markdownHeadingNodes}.
 */
import type { StructureNode } from "../../model.ts";
import type { HunkStructureContext, Language } from "../language.ts";
import {
  createMarkdownHighlighter,
  highlightMarkdownLines,
  isMarkdownPath,
  markdownDocument,
  markdownHeadingNodes,
  renderMarkdownLines,
} from "./markdown.ts";

export const markdownLanguage: Language = {
  id: "markdown",

  matches: (fileName) => isMarkdownPath(fileName),

  parseDocument: (text) => markdownDocument(text),

  highlightLines: (text) => highlightMarkdownLines(text),

  renderLines: (text) => renderMarkdownLines(text),

  renderNeedsCompleteFile: true,

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createMarkdownHighlighter(text),

  hunkStructure(ctx: HunkStructureContext): StructureNode[] {
    return markdownHeadingNodes(
      ctx.doc.flatStructure,
      ctx.lineToDiff,
      ctx.hunkEnd,
      ctx.diffLineStarts,
      ctx.rawLines,
    );
  },
};
