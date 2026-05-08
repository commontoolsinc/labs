import ts from "typescript";

import type { EmitterContext } from "../types.ts";
import { createReactiveWrapperForExpression } from "../rewrite-helpers.ts";
import {
  classifyArrayMethodCall,
  isSafeEventHandlerCall,
} from "../../../ast/mod.ts";

function isArrayMethodReceiverExpression(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;

  while (
    parent &&
    (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isPartiallyEmittedExpression(parent)
    )
  ) {
    if (parent.expression !== current) {
      return false;
    }
    current = parent;
    parent = parent.parent;
  }

  while (
    parent &&
    (
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)
    ) &&
    parent.expression === current
  ) {
    current = parent;
    parent = parent.parent;
  }

  return !!parent && ts.isCallExpression(parent) &&
    parent.expression === current &&
    !!classifyArrayMethodCall(parent);
}

export function emitPropertyAccess(
  params: EmitterContext,
): ts.Expression | undefined {
  const {
    expression,
    dataFlows,
    context,
    inSafeContext,
    preferDeriveWrappers,
  } = params;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  // Skip derive wrapping in safe contexts - they don't need it
  if (inSafeContext) return undefined;

  if (dataFlows.length === 0) return undefined;
  if (isArrayMethodReceiverExpression(expression)) return undefined;
  if (
    expression.parent &&
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression
  ) {
    if (!isSafeEventHandlerCall(expression.parent)) return undefined;
  }

  return createReactiveWrapperForExpression(
    expression,
    dataFlows,
    context,
    {
      preferDeriveWrapper: preferDeriveWrappers,
    },
  );
}
