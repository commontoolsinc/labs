/**
 * Call Kind Detection
 *
 * This module identifies CommonTools-specific call expressions (derive, ifElse,
 * recipe, etc.) to enable appropriate transformation behavior.
 *
 * ## Detection Strategy
 *
 * Detection uses a layered approach with name-based fallbacks:
 *
 * 1. **Identifier check**: For direct calls like `derive(...)`, we match by
 *    function name. This is the fast path for the common case.
 *
 * 2. **Symbol resolution**: For property access and aliased calls, we resolve
 *    the symbol and check if it originates from `commontools.d.ts` via
 *    `isCommonToolsSymbol()`.
 *
 * 3. **Name-based fallback**: If symbol resolution fails or the symbol doesn't
 *    come from CommonTools declarations, we fall back to name matching.
 *
 * ## Why Fallbacks Exist
 *
 * The name-based fallbacks are intentional and necessary for:
 *
 * - **Test environments**: Tests use synthetic type declarations that don't
 *   come from `commontools.d.ts`, so `isCommonToolsSymbol()` returns false.
 *
 * - **Synthetic nodes**: During transformation, we create synthetic AST nodes
 *   that lack proper source file associations.
 *
 * - **Incomplete type information**: Some edge cases where TypeScript's type
 *   checker can't fully resolve symbols.
 *
 * ## False Positive Risk
 *
 * Name-based detection could theoretically match user-defined functions with
 * the same names (e.g., a custom `derive` function). In practice:
 *
 * - These names are domain-specific and unlikely to collide
 * - A false positive would still produce valid (if unexpected) transformations
 * - The `isCommonToolsSymbol` check catches most production cases correctly
 */
import ts from "typescript";

import { isCommonToolsSymbol } from "../core/mod.ts";

const BUILDER_SYMBOL_NAMES = new Set([
  "recipe",
  "pattern",
  "handler",
  "action",
  "lift",
  "computed",
  "render",
]);

const ARRAY_OWNER_NAMES = new Set([
  "Array",
  "ReadonlyArray",
]);

const OPAQUE_REF_OWNER_NAMES = new Set([
  "OpaqueRefMethods",
  "OpaqueRef",
]);

const CELL_LIKE_CLASSES = new Set([
  "Cell",
  "Writable", // Alias for Cell that better expresses write-access semantics
  "OpaqueCell",
  "Stream",
  "ComparableCell",
  "ReadonlyCell",
  "WriteonlyCell",
  "CellTypeConstructor",
]);

const CELL_FACTORY_NAMES = new Set(["of"]);
const CELL_FOR_NAMES = new Set(["for"]);

export type CallKind =
  | { kind: "ifElse"; symbol?: ts.Symbol }
  | { kind: "when"; symbol?: ts.Symbol }
  | { kind: "unless"; symbol?: ts.Symbol }
  | { kind: "builder"; symbol?: ts.Symbol; builderName: string }
  | { kind: "array-map"; symbol?: ts.Symbol }
  | { kind: "derive"; symbol?: ts.Symbol }
  | { kind: "cell-factory"; symbol?: ts.Symbol; factoryName: string }
  | { kind: "cell-for"; symbol?: ts.Symbol }
  | { kind: "wish"; symbol?: ts.Symbol }
  | { kind: "generate-object"; symbol?: ts.Symbol }
  | { kind: "pattern-tool"; symbol?: ts.Symbol };

export function detectCallKind(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): CallKind | undefined {
  return resolveExpressionKind(call.expression, checker, new Set());
}

function resolveExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const target = stripWrappers(expression);

  // Fast path: match identifier names directly without symbol resolution.
  // This handles the common case of direct calls like `derive(...)`.
  // See module documentation for why name-based detection is acceptable.
  if (ts.isIdentifier(target)) {
    const name = target.text;
    if (name === "derive") {
      return { kind: "derive" };
    }
    if (name === "ifElse") {
      return { kind: "ifElse" };
    }
    if (name === "when") {
      return { kind: "when" };
    }
    if (name === "unless") {
      return { kind: "unless" };
    }
    if (name === "cell") {
      return { kind: "cell-factory", factoryName: "cell" };
    }
    if (name === "wish") {
      return { kind: "wish" };
    }
    if (name === "generateObject") {
      return { kind: "generate-object" };
    }
    if (name === "patternTool") {
      return { kind: "pattern-tool" };
    }
    if (BUILDER_SYMBOL_NAMES.has(name)) {
      return { kind: "builder", builderName: name };
    }
  }

  if (ts.isCallExpression(target)) {
    return resolveExpressionKind(target.expression, checker, seen);
  }

  let symbol: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    symbol = checker.getSymbolAtLocation(target.name);
  } else if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (argument && ts.isExpression(argument)) {
      symbol = checker.getSymbolAtLocation(argument);
    }
  } else if (ts.isIdentifier(target)) {
    symbol = checker.getSymbolAtLocation(target);
  } else {
    symbol = checker.getSymbolAtLocation(target);
  }

  if (symbol) {
    const kind = resolveSymbolKind(symbol, checker, seen);
    if (kind) return kind;
  }

  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    if (name === "map" || name === "mapWithPattern") {
      return { kind: "array-map" };
    }
    if (name === "derive") {
      return { kind: "derive" };
    }
    if (name === "ifElse") {
      return { kind: "ifElse" };
    }
    if (name === "when") {
      return { kind: "when" };
    }
    if (name === "unless") {
      return { kind: "unless" };
    }
    if (name === "wish") {
      return { kind: "wish" };
    }
    if (name === "generateObject") {
      return { kind: "generate-object" };
    }
    if (name === "patternTool") {
      return { kind: "pattern-tool" };
    }
    if (BUILDER_SYMBOL_NAMES.has(name)) {
      return { kind: "builder", builderName: name };
    }
  }

  const type = checker.getTypeAtLocation(target);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  for (const signature of signatures) {
    const signatureSymbol = getSignatureSymbol(signature);
    if (!signatureSymbol) continue;
    const kind = resolveSymbolKind(signatureSymbol, checker, seen);
    if (kind) return kind;
  }

  return undefined;
}

function stripWrappers(expression: ts.Expression): ts.Expression {
  let current: ts.Expression = expression;

  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }

  return current;
}

function resolveSymbolKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const resolved = resolveAlias(symbol, checker, seen);
  if (!resolved) return undefined;
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);

  const declarations = resolved.declarations ?? [];
  const name = resolved.getName();

  for (const declaration of declarations) {
    const builderKind = detectBuilderFromDeclaration(resolved, declaration);
    if (builderKind) return builderKind;

    const cellKind = detectCellMethodFromDeclaration(resolved, declaration);
    if (cellKind) return cellKind;

    if (
      isArrayMapDeclaration(declaration) ||
      isOpaqueRefMapDeclaration(declaration)
    ) {
      return { kind: "array-map", symbol: resolved };
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isExpression(declaration.initializer)
    ) {
      const nested = resolveExpressionKind(
        declaration.initializer,
        checker,
        seen,
      );
      if (nested) return nested;
    }
  }

  if (name === "ifElse" && isCommonToolsSymbol(resolved)) {
    return { kind: "ifElse", symbol: resolved };
  }

  if (name === "when" && isCommonToolsSymbol(resolved)) {
    return { kind: "when", symbol: resolved };
  }

  if (name === "unless" && isCommonToolsSymbol(resolved)) {
    return { kind: "unless", symbol: resolved };
  }

  if (name === "derive" && isCommonToolsSymbol(resolved)) {
    return { kind: "derive", symbol: resolved };
  }

  if (name === "cell" && isCommonToolsSymbol(resolved)) {
    return { kind: "cell-factory", symbol: resolved, factoryName: "cell" };
  }

  if (name === "wish" && isCommonToolsSymbol(resolved)) {
    return { kind: "wish", symbol: resolved };
  }

  if (name === "generateObject" && isCommonToolsSymbol(resolved)) {
    return { kind: "generate-object", symbol: resolved };
  }

  if (name === "patternTool" && isCommonToolsSymbol(resolved)) {
    return { kind: "pattern-tool", symbol: resolved };
  }

  if (BUILDER_SYMBOL_NAMES.has(name) && isCommonToolsSymbol(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }

  // Name-based fallback (see module documentation for rationale)
  if (name === "ifElse") {
    return { kind: "ifElse", symbol: resolved };
  }

  if (name === "when") {
    return { kind: "when", symbol: resolved };
  }

  if (name === "unless") {
    return { kind: "unless", symbol: resolved };
  }

  if (name === "derive") {
    return { kind: "derive", symbol: resolved };
  }

  if (name === "cell") {
    return { kind: "cell-factory", symbol: resolved, factoryName: "cell" };
  }

  if (name === "wish") {
    return { kind: "wish", symbol: resolved };
  }

  if (name === "generateObject") {
    return { kind: "generate-object", symbol: resolved };
  }

  if (name === "patternTool") {
    return { kind: "pattern-tool", symbol: resolved };
  }

  if (BUILDER_SYMBOL_NAMES.has(name)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }

  if (name === "map" || name === "mapWithPattern") {
    return { kind: "array-map", symbol: resolved };
  }

  return undefined;
}

function resolveAlias(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Symbol | undefined {
  let current = symbol;
  while (true) {
    if (seen.has(current)) return current;
    if (!(current.flags & ts.SymbolFlags.Alias)) break;
    const aliased = checker.getAliasedSymbol(current);
    if (!aliased) break;
    current = aliased;
  }
  return current;
}

function detectBuilderFromDeclaration(
  symbol: ts.Symbol,
  declaration: ts.Declaration,
): CallKind | undefined {
  if (!hasIdentifierName(declaration)) return undefined;

  const name = declaration.name.text;
  if (!BUILDER_SYMBOL_NAMES.has(name)) return undefined;

  return {
    kind: "builder",
    symbol,
    builderName: name,
  };
}

function detectCellMethodFromDeclaration(
  symbol: ts.Symbol,
  declaration: ts.Declaration,
): CallKind | undefined {
  if (!hasIdentifierName(declaration)) return undefined;

  const name = declaration.name.text;

  // Check for static methods on Cell-like classes
  const owner = findOwnerName(declaration);
  if (owner && CELL_LIKE_CLASSES.has(owner)) {
    if (CELL_FACTORY_NAMES.has(name)) {
      return { kind: "cell-factory", symbol, factoryName: name };
    }
    if (CELL_FOR_NAMES.has(name)) {
      return { kind: "cell-for", symbol };
    }
  }

  return undefined;
}

function isArrayMapDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (declaration.name.text !== "map") return false;

  const owner = findOwnerName(declaration);
  if (!owner) return false;
  return ARRAY_OWNER_NAMES.has(owner);
}

function isOpaqueRefMapDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (
    declaration.name.text !== "map" &&
    declaration.name.text !== "mapWithPattern"
  ) return false;

  const owner = findOwnerName(declaration);
  if (!owner) return false;
  return OPAQUE_REF_OWNER_NAMES.has(owner);
}

function findOwnerName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      if (current.name) return current.name.text;
    }
    if (ts.isSourceFile(current)) break;
    current = current.parent;
  }
  return undefined;
}

function hasIdentifierName(
  declaration: ts.Declaration,
): declaration is ts.Declaration & { readonly name: ts.Identifier } {
  const { name } = declaration as { name?: ts.Node };
  return !!name && ts.isIdentifier(name);
}

function getSignatureSymbol(signature: ts.Signature): ts.Symbol | undefined {
  // deno-lint-ignore no-explicit-any
  const sigWithSymbol = signature as any;
  if (sigWithSymbol.symbol) {
    return sigWithSymbol.symbol as ts.Symbol;
  }
  const declaration = signature.declaration;
  if (!declaration) return undefined;
  // deno-lint-ignore no-explicit-any
  const declWithSymbol = declaration as any;
  return declWithSymbol.symbol as ts.Symbol | undefined;
}
