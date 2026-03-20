import ts from "typescript";
import { getCellKind } from "../transformers/opaque-ref/opaque-ref.ts";
import { isReactiveValueExpression } from "../ast/mod.ts";
import type { ReactiveContextKind } from "../ast/reactive-context.ts";

export type ReactiveReceiverKind =
  | "plain"
  | "opaque_autounwrapped"
  | "celllike_requires_rewrite";

export function classifyReactiveReceiverKind(
  expression: ts.Expression | undefined,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ReactiveReceiverKind {
  if (type) {
    const kind = getCellKind(type, checker);
    if (kind === "cell" || kind === "stream") {
      return "celllike_requires_rewrite";
    }
    if (kind === "opaque") {
      return "opaque_autounwrapped";
    }
  }

  if (expression && isReactiveValueExpression(expression, checker)) {
    return "opaque_autounwrapped";
  }

  return "plain";
}

export function shouldLowerLogicalInJsx(
  contextKind: ReactiveContextKind,
  operator: ts.SyntaxKind,
): boolean {
  if (
    operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
    operator !== ts.SyntaxKind.BarBarToken
  ) {
    return false;
  }

  // Policy: lower always in pattern JSX, never in compute/neutral JSX.
  return contextKind === "pattern";
}

export function shouldRewriteCollectionMethod(
  contextKind: ReactiveContextKind,
  methodName: string,
  receiverKind: ReactiveReceiverKind,
): boolean {
  if (
    methodName !== "map" && methodName !== "filter" && methodName !== "flatMap"
  ) {
    return false;
  }

  if (receiverKind === "plain") {
    return false;
  }

  if (contextKind === "pattern") {
    return true;
  }

  if (contextKind === "compute") {
    return receiverKind === "celllike_requires_rewrite";
  }

  return false;
}
