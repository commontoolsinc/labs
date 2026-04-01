import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { visitEachChildWithJsx } from "../ast/mod.ts";
import { classifyExpressionSiteHandling } from "./expression-site-policy.ts";
import {
  rewriteExpressionSite,
  rewriteOwnedPreClosureJsxExpressionSite,
} from "./expression-site-lowering.ts";

export class JsxExpressionSiteRouterTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    return transform(context);
  }
}

function transform(context: TransformationContext): ts.SourceFile {
  const analyze = context.getDataFlowAnalyzer();

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node)) {
      // Skip empty JSX expressions (like JSX comments {/* ... */})
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      const handling = classifyExpressionSiteHandling(
        node.expression,
        "jsx-expression",
        context,
        analyze,
        { allowDeferredRootOwner: true },
      );

      if (
        handling.kind === "shared" &&
        (handling.jsxRoute ?? "shared-post-closure") === "shared-post-closure"
      ) {
        // Pattern-owned JSX roots handled by the shared post-closure
        // expression-site lowering pass.
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (
        handling.kind === "shared" &&
        handling.jsxRoute === "shared-pre-closure"
      ) {
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
        handling.kind === "owned" &&
        handling.owner === "jsx-root"
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
