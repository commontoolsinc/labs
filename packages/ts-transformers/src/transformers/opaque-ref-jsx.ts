import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  classifyReactiveContext,
  createDataFlowAnalyzer,
  isEventHandlerJsxAttribute,
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

/**
 * Check if an expression contains binary logical operators (&& or ||) that may
 * need when/unless transformation. This is used to determine if we should
 * process expressions in safe contexts.
 */
function containsLogicalBinaryOperator(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return true;
    }
  }
  // Check children recursively
  let found = false;
  expr.forEachChild((child) => {
    if (!found && ts.isExpression(child)) {
      if (containsLogicalBinaryOperator(child)) {
        found = true;
      }
    }
  });
  return found;
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

      if (isEventHandlerJsxAttribute(node, checker)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const contextInfo = classifyReactiveContext(node, checker, context);
      const inSafeContext = contextInfo.kind === "compute";

      const analysis = analyze(node.expression);

      // Check if expression contains && or || that may need when/unless transformation
      const hasLogicalOps = containsLogicalBinaryOperator(node.expression);

      if (contextInfo.kind === "compute") {
        // Compute JSX does not lower && / || and does not add wrappers.
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      // Skip if doesn't require rewriting AND no logical operators that might need transformation.
      // We need to proceed even with requiresRewrite=false if there are && or || operators
      // because pattern context always lowers them to when/unless for correct semantics.
      if (!analysis.requiresRewrite && !hasLogicalOps) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      // In safe contexts, only proceed if we have binary logical operators
      // that may need when/unless transformation
      if (inSafeContext && !hasLogicalOps) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (context.options.mode === "error") {
        // Only report errors for non-safe contexts
        if (!inSafeContext) {
          context.reportDiagnostic({
            type: "opaque-ref:jsx-expression",
            message:
              "JSX expression with OpaqueRef computation should use derive",
            node: node.expression,
          });
        }
        return node;
      }

      const result = rewriteExpression({
        expression: node.expression,
        analysis,
        context,
        analyze,
        reactiveContextKind: contextInfo.kind,
        inSafeContext,
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
