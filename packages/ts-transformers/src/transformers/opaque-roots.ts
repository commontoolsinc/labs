import ts from "typescript";

import { detectCallKind } from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { getKnownComputedKeyExpression } from "../utils/reactive-keys.ts";
import type { PathSegment } from "./destructuring-lowering.ts";

export interface OpaqueAccessInfo {
  root?: string;
  rootIdentifier?: ts.Identifier;
  path: PathSegment[];
  dynamic: boolean;
}

export function getOpaqueAccessInfo(
  expr: ts.Expression,
  context: TransformationContext,
): OpaqueAccessInfo {
  const path: PathSegment[] = [];
  let current: ts.Expression = expr;
  let dynamic = false;

  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const arg = current.argumentExpression;
      if (
        arg &&
        (ts.isStringLiteral(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        path.unshift(arg.text);
      } else if (arg) {
        const knownKeyExpression = getKnownComputedKeyExpression(arg, context);
        if (knownKeyExpression) {
          path.unshift(knownKeyExpression);
        } else {
          dynamic = true;
        }
      } else {
        dynamic = true;
      }
      current = current.expression;
      continue;
    }

    break;
  }

  if (ts.isIdentifier(current)) {
    return { root: current.text, rootIdentifier: current, path, dynamic };
  }

  return { path, dynamic };
}

export function isTopmostMemberAccess(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

export function isOpaqueOriginCall(
  expression: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const kind = detectCallKind(expression, context.checker);
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

export function isOpaqueRootInfo(
  info: OpaqueAccessInfo,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const rootIdentifier = info.rootIdentifier;
  if (rootIdentifier) {
    const symbol = context.checker.getSymbolAtLocation(rootIdentifier);
    if (symbol && opaqueRootSymbols.has(symbol)) {
      return true;
    }
  }

  return !!info.root && opaqueRoots.has(info.root);
}

export function isOpaqueSourceExpression(
  expression: ts.Expression,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const current = unwrapExpression(expression);
  const info = getOpaqueAccessInfo(current, context);
  if (isOpaqueRootInfo(info, opaqueRoots, opaqueRootSymbols, context)) {
    return true;
  }

  if (ts.isCallExpression(current)) {
    if (isOpaqueOriginCall(current, context)) {
      return true;
    }

    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      if (methodName === "key" || methodName === "get") {
        return isOpaqueSourceExpression(
          current.expression.expression,
          opaqueRoots,
          opaqueRootSymbols,
          context,
        );
      }
    }
  }

  return false;
}

export function addBindingTargetSymbols(
  name: ts.BindingName,
  bucket: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) {
      bucket.add(symbol);
    }
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingTargetSymbols(element.name, bucket, checker);
  }
}

export function collectLocalOpaqueRootSymbols(
  body: ts.Node,
  context: TransformationContext,
): Set<ts.Symbol> {
  const localOpaqueRootSymbols = new Set<ts.Symbol>();
  const scan = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isOpaqueSourceExpression(
        node.initializer,
        new Set(),
        localOpaqueRootSymbols,
        context,
      )
    ) {
      addBindingTargetSymbols(
        node.name,
        localOpaqueRootSymbols,
        context.checker,
      );
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
  return localOpaqueRootSymbols;
}
