import ts from "typescript";
import {
  getCapabilitySummaryCallbackArgument,
  getPatternBuilderCallbackArgument,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { collectPatternCallbackPreScan } from "./pattern-callback-prescan.ts";
import {
  registerCapabilitySummary,
  transformPatternCallback,
} from "./pattern-callback-transform.ts";

function maybeRegisterBuilderCapabilitySummary(
  node: ts.CallExpression,
  context: TransformationContext,
): void {
  const callback = getCapabilitySummaryCallbackArgument(node, context.checker);
  if (callback) {
    registerCapabilitySummary(callback, context, true);
  }
}

function registerBuilderSummariesInSubtree(
  node: ts.Node,
  context: TransformationContext,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      maybeRegisterBuilderCapabilitySummary(current, context);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

export class CapabilityLoweringTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    const {
      arrayMethodPatternCallNodes,
      nonReactiveCapturesByMapPattern,
    } = collectPatternCallbackPreScan(
      context.sourceFile,
      context,
    );

    // ── Main transform pass ────────────────────────────────────────────
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

      if (!ts.isCallExpression(visitedNode)) {
        return visitedNode;
      }

      const callbackArg = getPatternBuilderCallbackArgument(
        visitedNode,
        context.checker,
      );
      if (callbackArg) {
        const isArrayMethodCallback = arrayMethodPatternCallNodes.has(node);
        const nonReactiveCaptures = isArrayMethodCallback
          ? nonReactiveCapturesByMapPattern.get(node)
          : undefined;
        const transformedCallback = transformPatternCallback(
          callbackArg,
          context,
          isArrayMethodCallback,
          nonReactiveCaptures,
        );
        const rewritten = context.factory.updateCallExpression(
          visitedNode,
          visitedNode.expression,
          visitedNode.typeArguments,
          [
            transformedCallback,
            ...visitedNode.arguments.slice(1),
          ],
        );
        registerBuilderSummariesInSubtree(transformedCallback.body, context);
        maybeRegisterBuilderCapabilitySummary(rewritten, context);
        return rewritten;
      }

      maybeRegisterBuilderCapabilitySummary(visitedNode, context);
      return visitedNode;
    };

    return visitEachChildWithJsx(
      context.sourceFile,
      visit,
      context.tsContext,
    ) as ts.SourceFile;
  }
}
