import ts from "typescript";

import type { Emitter } from "../types.ts";
import { createIfElseCall } from "../../builtins/ifelse.ts";
import {
  classifyReactiveContext,
  detectCallKind,
  normalizeDataFlows,
  registerSyntheticCallType,
  selectDataFlowsReferencedIn,
} from "../../../ast/mod.ts";
import { isSimpleOpaqueRefAccess } from "../opaque-ref.ts";
import { createBindingPlan } from "../bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "../helpers.ts";

function isTransparentBranchWrapper(node: ts.Expression): boolean {
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

function isSupportedBranchBoundary(
  node: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
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

function throwBranchWrapCompilerBug(
  message: string,
  culprit: ts.Expression,
  branch: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): never {
  const culpritContext = classifyReactiveContext(
    culprit,
    context.checker,
    context,
  );
  throw new Error(
    [
      "Internal Common Tools compiler error: ternary branch wrap decision disagreed with reactive-context classification.",
      "This is a bug in the compiler, not in your code. Please report it to the maintainers.",
      message,
      `Culprit: ${ts.SyntaxKind[culprit.kind]} \`${getNodeSnippet(culprit, context.sourceFile)}\``,
      `Branch: ${ts.SyntaxKind[branch.kind]} \`${getNodeSnippet(branch, context.sourceFile)}\``,
      `Reactive context: ${culpritContext.kind} (${culpritContext.owner})`,
    ].join("\n"),
  );
}

function findSupportedBranchBoundaryAncestor(
  node: ts.Expression,
  branch: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): ts.Expression | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current && current !== branch) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return undefined;
    }

    if (ts.isExpression(current)) {
      if (isSupportedBranchBoundary(current, context)) {
        return current;
      }

      if (!isTransparentBranchWrapper(current)) {
        return undefined;
      }
    }

    current = current.parent;
  }

  return undefined;
}

function assertValidBranchWrapCandidate(
  culprit: ts.Expression,
  branch: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
): void {
  const culpritContext = classifyReactiveContext(
    culprit,
    context.checker,
    context,
  );

  if (culpritContext.kind === "compute") {
    throwBranchWrapCompilerBug(
      "The branch emitter tried to add a compute wrapper around a node that the shared context classifier already considers compute.",
      culprit,
      branch,
      context,
    );
  }

  const supportedBoundary = findSupportedBranchBoundaryAncestor(
    culprit,
    branch,
    context,
  );
  if (supportedBoundary) {
    throwBranchWrapCompilerBug(
      `The branch emitter identified a node inside an already-supported pattern boundary: \`${getNodeSnippet(supportedBoundary, context.sourceFile)}\`.`,
      culprit,
      branch,
      context,
    );
  }
}

function findPendingBranchRewrite(
  expr: ts.Expression,
  analyze: Parameters<Emitter>[0]["analyze"],
  context: Parameters<Emitter>[0]["context"],
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

    if (isTransparentBranchWrapper(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const nodeAnalysis = analyze(node);
    if (!nodeAnalysis.containsOpaqueRef || !nodeAnalysis.requiresRewrite) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isSupportedBranchBoundary(node, context)) {
      return;
    }

    pending = node;
  };

  visit(expr);
  return pending;
}

// Helper to process a conditional branch (whenTrue/whenFalse)
function processBranch(
  expr: ts.Expression,
  context: Parameters<Emitter>[0]["context"],
  analyze: Parameters<Emitter>[0]["analyze"],
  rewriteChildren: Parameters<Emitter>[0]["rewriteChildren"],
): ts.Expression {
  const rewritten = rewriteChildren(expr) || expr;
  const rewrittenAnalysis = analyze(rewritten);
  const rewrittenDataFlows = filterRelevantDataFlows(
    normalizeDataFlows(
      rewrittenAnalysis.graph,
      rewrittenAnalysis.dataFlows,
    ).all,
    rewrittenAnalysis,
    context,
  );

  const pendingRewrite = rewrittenDataFlows.length > 0
    ? findPendingBranchRewrite(rewritten, analyze, context)
    : undefined;

  if (pendingRewrite) {
    assertValidBranchWrapCandidate(pendingRewrite, rewritten, context);

    const plan = createBindingPlan(rewrittenDataFlows);
    const derived = createComputedCallForExpression(rewritten, plan, context);
    if (derived) {
      return derived;
    }
  }

  return rewritten;
}

export const emitConditionalExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  analyze,
  rewriteChildren,
  inSafeContext,
}) => {
  if (!ts.isConditionalExpression(expression)) return undefined;

  // Skip ternary transformation in safe contexts - they don't need ifElse wrapping
  if (inSafeContext) return undefined;

  if (dataFlows.all.length === 0) return undefined;

  const predicateDataFlows = selectDataFlowsReferencedIn(
    dataFlows,
    expression.condition,
  );
  const shouldDerivePredicate = predicateDataFlows.length > 0 &&
    !isSimpleOpaqueRefAccess(expression.condition, context.checker);

  let predicate: ts.Expression = expression.condition;
  if (shouldDerivePredicate) {
    const plan = createBindingPlan(predicateDataFlows);
    const derivedPredicate = createComputedCallForExpression(
      expression.condition,
      plan,
      context,
    );
    if (derivedPredicate) {
      predicate = derivedPredicate;
    }
  }

  const whenTrue = processBranch(
    expression.whenTrue,
    context,
    analyze,
    rewriteChildren,
  );

  const whenFalse = processBranch(
    expression.whenFalse,
    context,
    analyze,
    rewriteChildren,
  );

  const ifElseCall = createIfElseCall({
    expression,
    factory: context.factory,
    ctHelpers: context.ctHelpers,
    sourceFile: context.sourceFile,
    overrides: {
      predicate,
      whenTrue,
      whenFalse,
    },
  });

  // Register the result type for schema injection
  // The result type is the union of whenTrue and whenFalse types (from the original ternary)
  if (context.options.typeRegistry) {
    const resultType = context.checker.getTypeAtLocation(expression);
    registerSyntheticCallType(
      ifElseCall,
      resultType,
      context.options.typeRegistry,
    );
  }

  return ifElseCall;
};
