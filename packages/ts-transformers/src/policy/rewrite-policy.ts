import ts from "typescript";
import {
  getCellKind,
  isCellBrandedType,
} from "../transformers/opaque-ref/opaque-ref.ts";
import type { ReactiveContextKind } from "../ast/reactive-context.ts";

export type ReactiveReceiverKind =
  | "plain"
  | "reactive"
  | "celllike_requires_rewrite";

export function classifyReactiveReceiverKind(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ReactiveReceiverKind {
  if (!type) return "plain";

  // Brand-based detection (primary signal).
  if (isCellBrandedType(type, checker)) {
    const kind = getCellKind(type, checker);
    if (kind === "cell" || kind === "stream") {
      return "celllike_requires_rewrite";
    }
    // Opaque values auto-unwrap in compute callbacks.
    return "reactive";
  }

  // String-based fallback: recognise Cell/Stream/Writable even if the brand
  // is absent (e.g. after OpaqueRef debranding).  Only match top-level type
  // names — not types nested inside arrays or other generics.
  const typeStr = checker.typeToString(type);
  const startsWithReactive = (prefix: string) =>
    typeStr === prefix.slice(0, -1) || typeStr.startsWith(prefix);
  if (
    startsWithReactive("Cell<") ||
    startsWithReactive("Stream<") ||
    startsWithReactive("Writable<")
  ) {
    return "celllike_requires_rewrite";
  }
  if (
    startsWithReactive("OpaqueRef<") ||
    startsWithReactive("OpaqueCell<") ||
    startsWithReactive("OpaqueRefMethods<")
  ) {
    return "reactive";
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
