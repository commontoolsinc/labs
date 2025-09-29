import ts from "typescript";
import { applyPendingImports, createImportManager } from "../core/imports.ts";
import {
  createTransformationContext,
  type TransformationOptions,
} from "../core/context.ts";
import { createClosureTransformRule } from "./rules/closure-transform.ts";

export type ClosureTransformerOptions = TransformationOptions;

export function createClosureTransformer(
  program: ts.Program,
  options: ClosureTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const rule = createClosureTransformRule();

  return (transformation) => (sourceFile) => {
    const imports = createImportManager();
    const context = createTransformationContext(
      program,
      sourceFile,
      transformation,
      options,
      imports,
    );

    // Apply the closure transformation rule
    let current = rule.transform(sourceFile, context, transformation);

    // Apply pending imports
    current = applyPendingImports(current, transformation.factory, imports);

    // Handle diagnostics if in error mode
    if (
      context.options.mode === "error" &&
      context.diagnostics.length > 0
    ) {
      const message = context.diagnostics
        .map((diagnostic) =>
          `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.message}`
        )
        .join("\n");
      throw new Error(`Closure transformation errors:\n${message}`);
    }

    return current;
  };
}