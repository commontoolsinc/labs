import ts from "typescript";
import {
  TransformationContext,
  type TransformationOptions,
} from "../core/context.ts";
import { createJsxExpressionRule } from "./rules/jsx-expression.ts";
import type { OpaqueRefRule } from "./rules/jsx-expression.ts";
import { createSchemaInjectionRule } from "./rules/schema-injection.ts";
import type { TypeRegistry } from "../core/type-registry.ts";

export interface ModularOpaqueRefTransformerOptions
  extends TransformationOptions {
  typeRegistry?: TypeRegistry;
}

function createRules(typeRegistry?: TypeRegistry): OpaqueRefRule[] {
  return [
    createJsxExpressionRule(),
    createSchemaInjectionRule(typeRegistry),
  ];
}

export function createModularOpaqueRefTransformer(
  program: ts.Program,
  options: ModularOpaqueRefTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const rules = createRules(options.typeRegistry);

  return (transformation) => (sourceFile) => {
    const context = new TransformationContext({
      program,
      sourceFile,
      transformation,
      options,
    });

    let current = sourceFile;

    for (const rule of rules) {
      const next = rule.transform(current, context, transformation);
      if (next !== current) {
        current = next;
        (context as { sourceFile: ts.SourceFile }).sourceFile = current;
      }
    }

    current = context.imports.apply(
      current,
      transformation.factory,
    );
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
