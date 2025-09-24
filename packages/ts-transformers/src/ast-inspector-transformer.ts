import ts from "typescript";

export function createAstInspectorTransformer(
  inspect: (sourceFile: ts.SourceFile) => void,
): ts.TransformerFactory<ts.SourceFile> {
  return () => (sourceFile) => {
    inspect(sourceFile);
    return sourceFile;
  };
}
