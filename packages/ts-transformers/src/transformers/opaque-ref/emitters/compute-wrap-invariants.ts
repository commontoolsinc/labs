import ts from "typescript";

import { classifyReactiveContext, detectCallKind } from "../../../ast/mod.ts";
import type { TransformationContext } from "../../../core/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import type { AnalyzeFn } from "../types.ts";

function isTransparentWrapContainer(node: ts.Expression): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isJsxExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxSelfClosingElement(node)
  );
}

function isSupportedPatternBoundary(
  node: ts.Expression,
  context: TransformationContext,
): boolean {
  if (!ts.isCallExpression(node)) return false;

  const callKind = detectCallKind(node, context.checker);
  return (
    callKind?.kind === "array-method" ||
    callKind?.kind === "derive" ||
    callKind?.kind === "ifElse" ||
    callKind?.kind === "when" ||
    callKind?.kind === "unless" ||
    callKind?.kind === "builder"
  );
}

function getNodeSnippet(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  maxLength = 160,
): string {
  try {
    const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  } catch {
    return ts.SyntaxKind[node.kind];
  }
}

function throwComputeWrapCompilerBug(
  message: string,
  culprit: ts.Expression,
  container: ts.Expression,
  containerLabel: string,
  context: TransformationContext,
): never {
  const culpritContext = classifyReactiveContext(
    culprit,
    context.checker,
    context,
  );
  throw new Error(
    [
      `Internal Common Tools compiler error: ${containerLabel} compute-wrap decision disagreed with reactive-context classification.`,
      "This is a bug in the compiler, not in your code. Please report it to the maintainers.",
      message,
      `Culprit: ${ts.SyntaxKind[culprit.kind]} \`${
        getNodeSnippet(culprit, context.sourceFile)
      }\``,
      `Container: ${ts.SyntaxKind[container.kind]} \`${
        getNodeSnippet(container, context.sourceFile)
      }\``,
      `Reactive context: ${culpritContext.kind} (${culpritContext.owner})`,
    ].join("\n"),
  );
}

function findSupportedPatternBoundaryAncestor(
  node: ts.Expression,
  container: ts.Expression,
  context: TransformationContext,
): ts.Expression | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current && current !== container) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return undefined;
    }

    if (ts.isExpression(current)) {
      if (isSupportedPatternBoundary(current, context)) {
        return current;
      }

      if (!isTransparentWrapContainer(current)) {
        return undefined;
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function assertValidComputeWrapCandidate(
  culprit: ts.Expression,
  container: ts.Expression,
  containerLabel: string,
  context: TransformationContext,
): void {
  const culpritContext = classifyReactiveContext(
    culprit,
    context.checker,
    context,
  );

  if (culpritContext.kind === "compute") {
    throwComputeWrapCompilerBug(
      "The emitter tried to add a compute wrapper around a node that the shared context classifier already considers compute.",
      culprit,
      container,
      containerLabel,
      context,
    );
  }

  const supportedBoundary = findSupportedPatternBoundaryAncestor(
    culprit,
    container,
    context,
  );
  if (supportedBoundary) {
    throwComputeWrapCompilerBug(
      `The emitter identified a node inside an already-supported pattern boundary: \`${
        getNodeSnippet(supportedBoundary, context.sourceFile)
      }\`.`,
      culprit,
      container,
      containerLabel,
      context,
    );
  }
}

export function findPendingComputeWrapCandidate(
  expr: ts.Expression,
  analyze: AnalyzeFn,
  context: TransformationContext,
): ts.Expression | undefined {
  let pending: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (pending) return;

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Nested callbacks establish their own rewrite boundaries.
      return;
    }

    if (!ts.isExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isSimpleOpaqueRefAccess(node, context.checker)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isTransparentWrapContainer(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const nodeAnalysis = analyze(node);
    if (!nodeAnalysis.containsOpaqueRef || !nodeAnalysis.requiresRewrite) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isSupportedPatternBoundary(node, context)) {
      return;
    }

    pending = node;
  };

  visit(expr);
  return pending;
}
