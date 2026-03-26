import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { createDataFlowAnalyzer, visitEachChildWithJsx } from "../ast/mod.ts";
import { classifyJsxExpressionSiteRoute } from "./expression-site-policy.ts";
import {
  rewriteExpressionSite,
  rewriteOpaquePathTerminalJsxExpressionSite,
  rewriteOwnedPreClosureJsxExpressionSite,
} from "./expression-site-lowering.ts";

export class JsxExpressionSiteRouterTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    return transform(context);
  }
}

function transform(context: TransformationContext): ts.SourceFile {
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node)) {
      // Skip empty JSX expressions (like JSX comments {/* ... */})
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const route = classifyJsxExpressionSiteRoute(
        node.expression,
        context,
        analyze,
        { allowDeferredRootOwner: true },
      );

      if (route.route === "shared-post-closure") {
        // Pattern-owned JSX roots handled by the shared post-closure
        // expression-site lowering pass.
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (route.route === "shared-pre-closure") {
        const rewritten = rewriteExpressionSite({
          expression: node.expression,
          containerKind: "jsx-expression",
          context,
          analyze,
          visit,
        });
        if (rewritten) {
          return context.factory.createJsxExpression(
            node.dotDotDotToken,
            rewritten,
          );
        }

        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (
        route.route === "owned-pre-closure" &&
        route.owner === "opaque-path-terminal-root"
      ) {
        const rewritten = rewriteOpaquePathTerminalJsxExpressionSite({
          expression: node.expression,
          context,
          analyze,
          visit,
        });
        if (rewritten) {
          return context.factory.createJsxExpression(
            node.dotDotDotToken,
            rewritten,
          );
        }

        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (
        route.route === "owned-pre-closure" &&
        (
          route.owner === "deferred-jsx-array-method-root" ||
          route.owner === "dynamic-element-access-root" ||
          route.owner === "helper-call-root" ||
          route.owner === "object-literal-root"
        )
      ) {
        const rewritten = rewriteOwnedPreClosureJsxExpressionSite({
          expression: node.expression,
          context,
          analyze,
          visit,
        });
        if (rewritten) {
          return context.factory.createJsxExpression(
            node.dotDotDotToken,
            rewritten,
          );
        }

        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (route.route === "skip" && route.reason === "array-method-owned") {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

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
