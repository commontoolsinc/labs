import ts from "typescript";

import type { TransformationContext } from "../../core/context.ts";
import { isEventHandlerJsxAttribute } from "../types.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";
import { createDataFlowAnalyzer } from "../dataflow.ts";
import { rewriteExpression } from "../rewrite/rewrite.ts";
import { detectCallKind } from "../call-kind.ts";

export interface OpaqueRefRule {
  readonly name: string;
  transform(
    sourceFile: ts.SourceFile,
    context: TransformationContext,
    transformation: ts.TransformationContext,
  ): ts.SourceFile;
}

function isInsideDeriveCallback(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    // Check if we're inside an arrow function or function expression
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      // Check if this function is an argument to a derive call
      const functionParent = current.parent;
      if (
        functionParent &&
        ts.isCallExpression(functionParent) &&
        functionParent.arguments.includes(current as ts.Expression)
      ) {
        const callKind = detectCallKind(functionParent, checker);
        if (callKind?.kind === "derive") {
          return true;
        }
      }
    }
    current = current.parent;
  }

  return false;
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

          // Skip if inside a derive callback
          const insideDeriveCallback = isInsideDeriveCallback(node, checker);
          if (insideDeriveCallback) {
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
        context.imports.require({
          module: "commontools",
          name: helper,
        });
      }

      return updated;
    },
  };
}
