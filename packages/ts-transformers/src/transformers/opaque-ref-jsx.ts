import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  createDataFlowAnalyzer,
  isEventHandlerJsxAttribute,
  isInsideSafeCallbackWrapper,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { rewriteExpression } from "./opaque-ref/mod.ts";

export class OpaqueRefJSXTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return transform(context);
  }
}

function transform(context: TransformationContext): ts.SourceFile {
  const checker = context.checker;
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node)) {
      // Skip empty JSX expressions (like JSX comments {/* ... */})
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (isEventHandlerJsxAttribute(node)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      // Skip if inside a safe callback wrapper (derive, computed, action, lift, handler)
      // These contexts already provide reactive tracking, so JSX expressions
      // don't need to be wrapped in derive.
      if (isInsideSafeCallbackWrapper(node, checker)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const analysis = analyze(node.expression);

      // Skip if doesn't require rewriting
      if (!analysis.requiresRewrite) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
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

      const result = rewriteExpression({
        expression: node.expression,
        analysis,
        context,
        analyze,
      });

      if (result) {
        // IMPORTANT: Visit children of the rewritten expression to transform nested JSX
        const visitedResult = visitEachChildWithJsx(
          result,
          visit,
          context.tsContext,
        ) as ts.Expression;
        return context.factory.createJsxExpression(
          node.dotDotDotToken,
          visitedResult,
        );
      }

      // No rewrite needed, but visit children to transform nested expressions
      return visitEachChildWithJsx(node, visit, context.tsContext);
    }

    return visitEachChildWithJsx(node, visit, context.tsContext);
  };

  return visitEachChildWithJsx(
    context.sourceFile,
    visit,
    context.tsContext,
  ) as ts.SourceFile;
}
