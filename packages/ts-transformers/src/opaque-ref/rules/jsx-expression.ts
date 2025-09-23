import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import { isEventHandlerJsxAttribute } from "../types.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";
import { createDataFlowAnalyzer } from "../dataflow.ts";
import { rewriteExpression } from "../rewrite/rewrite.ts";

export interface OpaqueRefRule {
  readonly name: string;
  transform(
    sourceFile: ts.SourceFile,
    context: TransformationContext,
    transformation: ts.TransformationContext,
  ): ts.SourceFile;
}

export function createJsxExpressionRule(): OpaqueRefRule {
  return {
    name: "jsx-expression",
    transform(
      sourceFile,
      context,
      transformation,
    ): ts.SourceFile {
      const checker = context.checker;
      const analyze = createDataFlowAnalyzer(checker);
      const helpers = new Set<OpaqueRefHelperName>();

      const visit: ts.Visitor = (node) => {
        if (ts.isJsxExpression(node) && node.expression) {
          if (isEventHandlerJsxAttribute(node)) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const analysis = analyze(node.expression);

          // Skip if doesn't require rewriting
          if (!analysis.requiresRewrite) {
            return ts.visitEachChild(node, visit, transformation);
          }

          if (context.options.mode === "error") {
            context.reportDiagnostic({
              type: "opaque-ref:jsx-expression",
              message:
                "JSX expression with OpaqueRef computation should use derive",
              node: node.expression,
            });
            return node;
          }

          const rewriteResult = rewriteExpression({
            expression: node.expression,
            analysis,
            context: {
              factory: context.factory,
              checker,
              sourceFile,
              transformation,
              analyze,
            },
          });

          if (rewriteResult) {
            for (const helper of rewriteResult.helpers) {
              helpers.add(helper);
            }
            return context.factory.createJsxExpression(
              node.dotDotDotToken,
              rewriteResult.expression,
            );
          }
        }

        return ts.visitEachChild(node, visit, transformation);
      };

      const updated = ts.visitEachChild(sourceFile, visit, transformation);

      for (const helper of helpers) {
        context.imports.request({ name: helper });
      }

      return updated;
    },
  };
}
