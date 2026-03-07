import ts from "typescript";
import { detectCallKind } from "./call-kind.ts";
import { unwrapExpression } from "../utils/expression.ts";

/**
 * Returns true when the call expression is a known reactive-origin API
 * (builder, cell factory, derive, wish, etc.).
 *
 * This is a context-based check that does NOT depend on the CELL_BRAND
 * type brand — it inspects the call shape via `detectCallKind`.
 */
export function isReactiveOriginCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const kind = detectCallKind(expression, checker);
  if (!kind) return false;

  switch (kind.kind) {
    case "builder":
    case "cell-factory":
    case "cell-for":
    case "derive":
    case "wish":
    case "generate-object":
    case "pattern-tool":
      return true;
    default:
      return false;
  }
}

/**
 * Returns true when the expression traces back to a reactive source:
 * a reactive-origin call, or a `.key()`/`.get()` chain on a reactive source.
 *
 * `roots` is the set of identifier names that are known to be reactive
 * in the current scope (e.g. pattern parameter names).
 */
export function isReactiveSourceExpression(
  expression: ts.Expression,
  roots: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expression);

  // Check if identifier is a known reactive root
  if (ts.isIdentifier(current) && roots.has(current.text)) {
    return true;
  }

  // Calls: check if this is a reactive-origin call, or .key()/.get() on a reactive source
  if (ts.isCallExpression(current)) {
    if (isReactiveOriginCall(current, checker)) {
      return true;
    }

    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      if (methodName === "key" || methodName === "get") {
        return isReactiveSourceExpression(
          current.expression.expression,
          roots,
          checker,
        );
      }
    }
  }

  // Property access chains: trace through to the root
  if (ts.isPropertyAccessExpression(current)) {
    return isReactiveSourceExpression(current.expression, roots, checker);
  }

  if (ts.isElementAccessExpression(current)) {
    return isReactiveSourceExpression(current.expression, roots, checker);
  }

  return false;
}
