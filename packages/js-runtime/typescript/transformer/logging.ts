import ts from "typescript";

/**
 * Transformer that logs the transformed source code without modifying it.
 * This should be added at the end of the transformer chain to see the final output.
 */
export function createLoggingTransformer(
  _program: ts.Program,
  options: { debug?: boolean } = {},
): ts.TransformerFactory<ts.SourceFile> {
  const { debug = false } = options;

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      // Only log if debug is enabled
      if (debug) {
        const printer = ts.createPrinter();
        const result = printer.printFile(sourceFile);
        console.log("=== START TRANSFORMED SOURCE ===");
        console.log(result);
        console.log("=== END TRANSFORMED SOURCE ===");
      }

      // Return the source file unchanged
      return sourceFile;
    };
  };
}