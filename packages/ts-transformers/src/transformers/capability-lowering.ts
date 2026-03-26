import ts from "typescript";
import {
  detectCallKind,
  isFunctionLikeExpression,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { collectPatternCallbackPreScan } from "./pattern-callback-prescan.ts";
import {
  registerCapabilitySummary,
  transformPatternCallback,
} from "./pattern-callback-transform.ts";

function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const kind = detectCallKind(call, checker);
  if (kind?.kind === "builder" && kind.builderName === "pattern") {
    return true;
  }

  const expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text === "pattern";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "pattern";
  }
  return false;
}

function maybeRegisterBuilderCapabilitySummary(
  node: ts.CallExpression,
  context: TransformationContext,
): void {
  const callKind = detectCallKind(node, context.checker);
  if (!callKind) return;

  const registerFrom = (arg: ts.Expression | undefined): void => {
    if (!arg || !isFunctionLikeExpression(arg)) return;
    registerCapabilitySummary(arg, context, true);
  };

  if (callKind.kind === "derive") {
    registerFrom(node.arguments[1]);
    return;
  }

  if (callKind.kind === "builder") {
    if (callKind.builderName === "lift") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "handler") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "computed") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "action") {
      registerFrom(node.arguments[0]);
      return;
    }
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
      isPatternBuilderCall,
    );

    // ── Main transform pass ────────────────────────────────────────────
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

      if (!ts.isCallExpression(visitedNode)) {
        return visitedNode;
      }

      if (isPatternBuilderCall(visitedNode, context.checker)) {
        const callbackArg = visitedNode.arguments[0];
        if (callbackArg && isFunctionLikeExpression(callbackArg)) {
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
