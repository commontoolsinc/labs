import ts from "typescript";
import { containsOpaqueRef, isEventHandlerJsxAttribute } from "../types.ts";
import { transformExpressionWithOpaqueRef } from "../transforms.ts";

export function createJsxExpressionRule(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();

  return (context) => (sourceFile) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isJsxExpression(node) && node.expression) {
        if (isEventHandlerJsxAttribute(node)) {
          return ts.visitEachChild(node, visit, context);
        }
        if (!containsOpaqueRef(node.expression, checker)) {
          return ts.visitEachChild(node, visit, context);
        }
        const transformed = transformExpressionWithOpaqueRef(
          node.expression,
          checker,
          context.factory,
          sourceFile,
          context,
        );
        if (transformed !== node.expression) {
          return context.factory.createJsxExpression(
            node.dotDotDotToken,
            transformed,
          );
        }
      }
      return ts.visitEachChild(node, visit, context);
    };

    return ts.visitEachChild(sourceFile, visit, context);
  };
}
