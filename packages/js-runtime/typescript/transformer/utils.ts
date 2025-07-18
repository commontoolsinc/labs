import ts from "typescript";

/**
 * Check if a source file has the /// <cts-enable /> directive.
 * This directive enables CommonTools transformations for the file.
 */
export function hasCtsEnableDirective(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.getFullText();
  const tripleSlashDirectives = ts.getLeadingCommentRanges(text, 0) || [];

  for (const comment of tripleSlashDirectives) {
    const commentText = text.substring(comment.pos, comment.end);
    if (/^\/\/\/\s*<cts-enable\s*\/>/m.test(commentText)) {
      return true;
    }
  }
  return false;
}