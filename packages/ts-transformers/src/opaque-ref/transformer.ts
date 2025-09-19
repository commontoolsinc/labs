import ts from "typescript";

import { applyPendingImports, createImportManager } from "../core/imports.ts";
import {
  createTransformationContext,
  type TransformationOptions,
} from "../core/context.ts";
import { createJsxExpressionRule } from "./rules/jsx-expression.ts";
import type { OpaqueRefRule } from "./rules/jsx-expression.ts";
import { createSchemaInjectionRule } from "./rules/schema-injection.ts";

export type ModularOpaqueRefTransformerOptions = TransformationOptions;

function createRules(): OpaqueRefRule[] {
  return [
    createJsxExpressionRule(),
    createSchemaInjectionRule(),
  ];
}

export function createModularOpaqueRefTransformer(
  program: ts.Program,
  options: ModularOpaqueRefTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const rules = createRules();

  return (transformation) => (sourceFile) => {
    const imports = createImportManager();
    const context = createTransformationContext(
      program,
      sourceFile,
      transformation,
      options,
      imports,
    );

    let current = sourceFile;

    for (const rule of rules) {
      const next = rule.transform(current, context, transformation);
      if (next !== current) {
        current = next;
        (context as { sourceFile: ts.SourceFile }).sourceFile = current;
      }
    }

    current = applyPendingImports(current, transformation.factory, imports);
    (context as { sourceFile: ts.SourceFile }).sourceFile = current;

    if (
      context.options.mode === "error" &&
      context.diagnostics.length > 0
    ) {
      const message = context.diagnostics
        .map((diagnostic) =>
          `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.message}`
        )
        .join("\n");
      throw new Error(`OpaqueRef transformation errors:\n${message}`);
    }

    return current;
  };
}
