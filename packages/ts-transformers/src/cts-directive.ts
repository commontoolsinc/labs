import ts from "typescript";

/**
 * Returns true when the source file starts with the CommonTools
 * triple-slash directive `/// <cts-enable />`.
 */
export function hasCtsEnableDirective(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];
  for (const range of ranges) {
    const commentText = text.slice(range.pos, range.end);
    if (/^\/\/\/\s*<cts-enable\s*\/>/m.test(commentText)) {
      return true;
    }
  }
  return false;
}
