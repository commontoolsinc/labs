import ts from "typescript";

import { applyPendingImports, createImportManager } from "../core/imports.ts";
import { getCommonToolsImportIdentifier } from "../core/common-tools.ts";
import {
  createTransformationContext,
  type TransformationOptions,
} from "../core/context.ts";
import { createJsxExpressionRule } from "./rules/jsx-expression.ts";
import type { OpaqueRefRule } from "./rules/jsx-expression.ts";
import type { OpaqueRefHelperName } from "./transforms.ts";
import { createSchemaInjectionRule } from "./rules/schema-injection.ts";

export type ModularOpaqueRefTransformerOptions = TransformationOptions;

function createRules(
  recordHelperReference: (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => void,
): OpaqueRefRule[] {
  return [
    createJsxExpressionRule(recordHelperReference),
    createSchemaInjectionRule(recordHelperReference),
  ];
}

export function createModularOpaqueRefTransformer(
  program: ts.Program,
  options: ModularOpaqueRefTransformerOptions = {},
): ts.TransformerFactory<ts.SourceFile> {
  const helperReferences: Record<OpaqueRefHelperName, ts.Identifier[]> = {
    derive: [],
    ifElse: [],
    toSchema: [],
  };
  const recordHelperReference = (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => {
    helperReferences[helper].push(identifier);
  };

  const rules = createRules(recordHelperReference);

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
    const bindReferencesToImport = (
      helper: OpaqueRefHelperName,
    ) => {
      const refs = helperReferences[helper];
      if (!refs.length) return;
      const importIdentifier = getCommonToolsImportIdentifier(
        current,
        transformation.factory,
        helper,
      );
      if (!importIdentifier) return;
      const textRange = {
        pos: importIdentifier.pos,
        end: importIdentifier.end,
      };
      const sourceMapRange = ts.getSourceMapRange(importIdentifier);
      for (const identifier of refs) {
        ts.setOriginalNode(identifier, importIdentifier);
        ts.setTextRange(identifier, textRange);
        if (sourceMapRange) {
          ts.setSourceMapRange(identifier, sourceMapRange);
        }
      }
    };

    bindReferencesToImport("derive");
    bindReferencesToImport("ifElse");
    bindReferencesToImport("toSchema");
    helperReferences.derive.length = 0;
    helperReferences.ifElse.length = 0;
    helperReferences.toSchema.length = 0;
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
