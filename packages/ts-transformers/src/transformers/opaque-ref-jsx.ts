import ts from "typescript";
import {
  hasCtsEnableDirective,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";
import {
  createDataFlowAnalyzer,
  detectCallKind,
  isEventHandlerJsxAttribute,
} from "../ast/mod.ts";
import { OpaqueRefHelperName, rewriteExpression } from "./opaque-ref/mod.ts";

export class OpaqueRefJSXTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return hasCtsEnableDirective(context.sourceFile);
  }

  transform(context: TransformationContext): ts.SourceFile {
    const { tsContext: transformation } = context;

    const out = transform(context);
    return context.imports.apply(
      out,
      transformation.factory,
    );
  }
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

function transform(context: TransformationContext): ts.SourceFile {
  const checker = context.checker;
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      if (isEventHandlerJsxAttribute(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      // Skip if inside a derive callback
      const insideDeriveCallback = isInsideDeriveCallback(node, checker);
      if (insideDeriveCallback) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      const analysis = analyze(node.expression);

      // Skip if doesn't require rewriting
      if (!analysis.requiresRewrite) {
        return ts.visitEachChild(node, visit, context.tsContext);
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
        return context.factory.createJsxExpression(
          node.dotDotDotToken,
          result,
        );
      }
    }

    return ts.visitEachChild(node, visit, context.tsContext);
  };

  return ts.visitEachChild(
    context.sourceFile,
    visit,
    context.tsContext,
  );
}
