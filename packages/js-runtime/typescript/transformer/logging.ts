import ts from "typescript";
import { createDebugger, TransformerOptions } from "./debug.ts";

/**
 * Options for the logging transformer
 */
export interface LoggingTransformerOptions extends TransformerOptions {
  // No additional options needed
}

/**
 * Transformer that logs the transformed source code without modifying it.
 * This should be added at the end of the transformer chain to see the final output.
 * 
 * IMPORTANT: This transformer is responsible for showing the final transformed code
 * when debugging is enabled. It should ALWAYS log the transformed source when
 * debug is true to help developers understand what transformations were applied.
 */
export function createLoggingTransformer(
  _program: ts.Program,
  options: LoggingTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const debug = createDebugger('LoggingTransformer', options);

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      // Check if this file has the /// <cts-enable /> directive
      const hasCtsEnableDirective = (): boolean => {
        const text = sourceFile.getFullText();
        const tripleSlashDirectives = ts.getLeadingCommentRanges(text, 0) || [];

        for (const comment of tripleSlashDirectives) {
          const commentText = text.substring(comment.pos, comment.end);
          if (/^\/\/\/\s*<cts-enable\s*\/>/m.test(commentText)) {
            return true;
          }
        }
        return false;
      };
      
      const hasDirective = hasCtsEnableDirective();
      
      // Don't log when --show-transformed is used to keep output clean
      
      // ALWAYS log the transformed source when debugging is enabled
      // This is the primary purpose of this transformer
      // Only log files that have the directive
      if (debug.isEnabled() && debug.logTransformedSource && hasDirective) {
        const printer = ts.createPrinter({
          newLine: ts.NewLineKind.LineFeed,
          removeComments: false,
        });
        const transformedSource = printer.printFile(sourceFile);
        debug.logTransformedSource(sourceFile.fileName, transformedSource);
      }

      // Return the source file unchanged
      return sourceFile;
    };
  };
}