import ts from "typescript";

export function createCaptureTransformer(
  capture: (sourceFile: ts.SourceFile) => void,
): ts.TransformerFactory<ts.SourceFile> {
  return () => (sourceFile) => {
    capture(sourceFile);
    return sourceFile;
  };
}
