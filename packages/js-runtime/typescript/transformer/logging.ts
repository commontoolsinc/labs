import ts from "typescript";
import { TransformerOptions } from "./debug.ts";
import { hasCtsEnableDirective } from "./utils.ts";

export interface LoggingTransformerOptions extends TransformerOptions {
  showTransformed?: boolean;
}

/**
 * Transformer that logs the transformed source code without modifying it.
 * This should be added at the end of the transformer chain to see the final output.
 *
 * When a logger is provided and the file has the CTS directive, it will output
 * the transformed source code to help developers understand what transformations
 * were applied.
 */
export function createLoggingTransformer(
  _program: ts.Program,
  options: LoggingTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const logger = options.logger;
  const showTransformed = options.showTransformed;

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      const hasDirective = hasCtsEnableDirective(sourceFile);

      // Log the transformed source when logger is provided and file has directive
      if (logger && hasDirective) {
        const printer = ts.createPrinter({
          newLine: ts.NewLineKind.LineFeed,
          removeComments: false,
        });
        const transformedSource = printer.printFile(sourceFile);

        // When --show-transformed is used, output only the source
        // Otherwise include headers for debugging
        if (showTransformed) {
          logger(transformedSource);
        } else {
          logger(`\n=== TRANSFORMED SOURCE: ${sourceFile.fileName} ===`);
          logger(transformedSource);
          logger(`=== END TRANSFORMED SOURCE ===\n`);
        }
      }

      // Return the source file unchanged
      return sourceFile;
    };
  };
}
