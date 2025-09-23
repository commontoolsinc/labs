import ts from "typescript";

const BUILDER_SYMBOL_NAMES = new Set([
  "recipe",
  "handler",
  "lift",
  "compute",
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

const COMMONTOOLS_PATH_FRAGMENT = "commontools";

export type CallKind =
  | { kind: "ifElse"; symbol?: ts.Symbol }
  | { kind: "builder"; symbol?: ts.Symbol; builderName: string }
  | { kind: "array-map"; symbol?: ts.Symbol }
  | { kind: "derive"; symbol?: ts.Symbol };

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

  // Check for simple identifier names first (for cases where symbol resolution might fail)
  if (ts.isIdentifier(target)) {
    const name = target.text;
    if (name === "derive") {
      return { kind: "derive" };
    }
    if (name === "ifElse") {
      return { kind: "ifElse" };
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

  if (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "map"
  ) {
    return { kind: "array-map" };
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

  if (name === "ifElse" && symbolIsCommonTools(resolved)) {
    return { kind: "ifElse", symbol: resolved };
  }

  if (name === "derive" && symbolIsCommonTools(resolved)) {
    return { kind: "derive", symbol: resolved };
  }

  if (BUILDER_SYMBOL_NAMES.has(name) && symbolIsCommonTools(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }

  if (name === "ifElse") {
    return { kind: "ifElse", symbol: resolved };
  }

  if (name === "derive") {
    return { kind: "derive", symbol: resolved };
  }

  if (BUILDER_SYMBOL_NAMES.has(name)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }

  if (name === "map") {
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

function isArrayMapDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (declaration.name.text !== "map") return false;

  const owner = findOwnerName(declaration);
  if (!owner) return false;
  return ARRAY_OWNER_NAMES.has(owner);
}

function isOpaqueRefMapDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (declaration.name.text !== "map") return false;

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

function symbolIsCommonTools(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  return declarations.some((declaration) =>
    declaration.getSourceFile().fileName.includes(COMMONTOOLS_PATH_FRAGMENT)
  );
}
