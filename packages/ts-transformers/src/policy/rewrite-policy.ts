import ts from "typescript";
import {
  getCellKind,
  isOpaqueRefType,
} from "../transformers/opaque-ref/opaque-ref.ts";
import type { ReactiveContextKind } from "../ast/reactive-context.ts";

export type ReactiveReceiverKind =
  | "plain"
  | "opaque_autounwrapped"
  | "celllike_requires_rewrite";

export function classifyReactiveReceiverKind(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ReactiveReceiverKind {
  if (!type || !isOpaqueRefType(type, checker)) {
    return "plain";
  }

  const kind = getCellKind(type, checker);
  if (kind === "cell" || kind === "stream") {
    return "celllike_requires_rewrite";
  }

  // Opaque values auto-unwrap in compute callbacks.
  return "opaque_autounwrapped";
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
  if (methodName !== "map") {
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
