/**
 * Call Kind Detection
 *
 * This module identifies CommonTools-specific call expressions (derive, ifElse,
 * pattern, etc.) to enable appropriate transformation behavior.
 *
 * ## Detection Strategy
 *
 * Detection is provenance-first:
 *
 * 1. **Symbol resolution**: Resolve the callee symbol and verify it comes from
 *    CommonTools declarations or imports.
 *
 * 2. **Alias following**: Follow stable const aliases and call signatures to
 *    preserve detection for `const alias = derive` and `declare const alias:
 *    typeof ifElse` style code.
 *
 * 3. **Synthetic helper support**: Recognize internal `__ctHelpers.*` calls
 *    introduced by the transformer pipeline when symbol resolution is not
 *    available on synthetic nodes.
 *
 * ## Narrow Exceptions
 *
 * The remaining syntactic fallback is intentionally limited to synthetic
 * `__ctHelpers.*` calls and unresolved bare builder identifiers. Local helpers
 * or object methods that merely share a CommonTools name should not be
 * classified as CommonTools calls.
 */
import ts from "typescript";

import { CT_HELPERS_IDENTIFIER, isCommonToolsSymbol } from "../core/mod.ts";
import {
  COMMONTOOLS_BUILDER_EXPORT_NAMES,
  COMMONTOOLS_CALL_EXPORT_NAMES,
  COMMONTOOLS_REACTIVE_ORIGIN_BUILDER_NAMES,
  COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES,
  COMMONTOOLS_RUNTIME_EXPORTS_BY_NAME,
} from "../core/commontools-runtime-registry.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";

const ARRAY_METHOD_NAMES = new Set([
  "map",
  "mapWithPattern",
  "filter",
  "filterWithPattern",
  "flatMap",
  "flatMapWithPattern",
]);

const BUILDER_SYMBOL_NAMES = COMMONTOOLS_BUILDER_EXPORT_NAMES;

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
const COMMONTOOLS_CALL_NAMES = COMMONTOOLS_CALL_EXPORT_NAMES;

export type CallKind =
  | { kind: "ifElse"; symbol?: ts.Symbol }
  | { kind: "when"; symbol?: ts.Symbol }
  | { kind: "unless"; symbol?: ts.Symbol }
  | { kind: "builder"; symbol?: ts.Symbol; builderName: string }
  | { kind: "array-method"; symbol?: ts.Symbol }
  | { kind: "derive"; symbol?: ts.Symbol }
  | { kind: "cell-factory"; symbol?: ts.Symbol; factoryName: string }
  | { kind: "cell-for"; symbol?: ts.Symbol }
  | { kind: "wish"; symbol?: ts.Symbol }
  | { kind: "generate-text"; symbol?: ts.Symbol }
  | { kind: "generate-object"; symbol?: ts.Symbol }
  | { kind: "pattern-tool"; symbol?: ts.Symbol }
  | {
    kind: "runtime-call";
    symbol?: ts.Symbol;
    exportName: string;
    reactiveOrigin: boolean;
  };

export function detectCallKind(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): CallKind | undefined {
  return resolveExpressionKind(call.expression, checker, new Set());
}

export function detectDirectBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Extract<CallKind, { kind: "builder" }> | undefined {
  const builderKind = resolveBuilderExpressionKind(
    call.expression,
    checker,
    new Set(),
    { followFactoryResults: false },
  );
  return builderKind?.kind === "builder" ? builderKind : undefined;
}

export function isReactiveOriginCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callKind = detectCallKind(call, checker);
  return !!callKind && isReactiveOriginKind(callKind);
}

function isReactiveOriginKind(callKind: CallKind): boolean {
  switch (callKind.kind) {
    case "builder":
      return COMMONTOOLS_REACTIVE_ORIGIN_BUILDER_NAMES.has(
        callKind.builderName,
      );
    case "cell-factory":
    case "cell-for":
      return true;
    case "derive":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("derive");
    case "ifElse":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("ifElse");
    case "when":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("when");
    case "unless":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("unless");
    case "wish":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("wish");
    case "generate-text":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("generateText");
    case "generate-object":
      return COMMONTOOLS_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has(
        "generateObject",
      );
    case "runtime-call":
      return callKind.reactiveOrigin;
    default:
      return false;
  }
}

export function isReactiveValueSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  return !!getImplicitReactiveParameterCallKind(symbol, checker) ||
    isVariableFromReactiveCallSymbol(symbol, checker);
}

export function isReactiveValueExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(expression);

  try {
    const type = checker.getTypeAtLocation(target);
    if (isOpaqueRefType(type, checker)) {
      return true;
    }
  } catch {
    // Fall through to structural analysis.
  }

  if (ts.isIdentifier(target)) {
    return isReactiveValueSymbol(checker.getSymbolAtLocation(target), checker);
  }

  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return isReactiveValueExpression(target.expression, checker);
  }

  if (ts.isCallExpression(target)) {
    if (isReactiveOriginCall(target, checker)) {
      return true;
    }
    return isLoweredReactiveArrayMethodCall(target, checker);
  }

  return false;
}

export function isSimpleReactiveAccessExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(expression);

  if (ts.isIdentifier(target)) {
    return isReactiveValueExpression(target, checker);
  }

  if (ts.isPropertyAccessExpression(target)) {
    return isSimpleReactiveAccessExpression(target.expression, checker);
  }

  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    return !!argument &&
      (
        ts.isLiteralExpression(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument)
      ) &&
      isSimpleReactiveAccessExpression(target.expression, checker);
  }

  return false;
}

function resolveExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const target = stripWrappers(expression);

  const builderKind = resolveBuilderExpressionKind(target, checker, new Set(), {
    followFactoryResults: true,
  });
  if (builderKind) return builderKind;

  const syntheticHelperKind = getSyntheticHelperCallKind(target);
  if (syntheticHelperKind) return syntheticHelperKind;

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
    if (ARRAY_METHOD_NAMES.has(name)) {
      // Only classify as array-map if receiver is reactive (OpaqueRef/Cell).
      // Plain Array.prototype methods should not be treated as reactive.
      if (
        isReactiveValueExpression(target.expression, checker) ||
        isReactiveArrayMethodChain(target.expression, checker)
      ) {
        return { kind: "array-method" };
      }
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

function stripInitializerAccess(expression: ts.Expression): ts.Expression {
  let current = stripWrappers(expression);

  while (true) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = stripWrappers(current.expression);
      continue;
    }
    break;
  }

  return current;
}

function isReactiveArrayMethodChain(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(expression);
  return ts.isCallExpression(target) &&
    detectCallKind(target, checker)?.kind === "array-method";
}

function isLoweredReactiveArrayMethodCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(call.expression);
  return ts.isPropertyAccessExpression(target) &&
    target.name.text.endsWith("WithPattern") &&
    detectCallKind(call, checker)?.kind === "array-method";
}

function getImplicitReactiveParameterCallKind(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): "builder" | "array-method" | undefined {
  if (!symbol) return undefined;
  const declarations = symbol.getDeclarations();
  if (!declarations) return undefined;

  for (const declaration of declarations) {
    let paramNode: ts.Node = declaration;
    while (
      ts.isBindingElement(paramNode) ||
      ts.isObjectBindingPattern(paramNode) ||
      ts.isArrayBindingPattern(paramNode)
    ) {
      paramNode = paramNode.parent;
    }
    if (!ts.isParameter(paramNode)) continue;

    let functionNode: ts.Node | undefined = paramNode.parent;
    while (functionNode && !ts.isFunctionLike(functionNode)) {
      functionNode = functionNode.parent;
    }
    if (!functionNode) continue;

    let candidate: ts.Node | undefined = functionNode.parent;
    while (candidate && !ts.isCallExpression(candidate)) {
      candidate = candidate.parent;
    }
    if (!candidate) continue;

    const callKind = detectCallKind(candidate as ts.CallExpression, checker);
    if (callKind?.kind === "builder" || callKind?.kind === "array-method") {
      return callKind.kind;
    }
  }

  return undefined;
}

function isVariableFromReactiveCallSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;

  for (const decl of declarations) {
    let initExpr: ts.Expression | undefined;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      initExpr = decl.initializer;
    } else if (ts.isBindingElement(decl)) {
      let parent: ts.Node = decl;
      while (
        ts.isBindingElement(parent) ||
        ts.isObjectBindingPattern(parent) ||
        ts.isArrayBindingPattern(parent)
      ) {
        parent = parent.parent;
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer) {
        initExpr = parent.initializer;
      }
    }
    if (!initExpr) continue;

    const current = stripInitializerAccess(initExpr);
    if (!ts.isCallExpression(current)) continue;

    if (
      isReactiveOriginCall(current, checker) ||
      isLoweredReactiveArrayMethodCall(current, checker)
    ) {
      return true;
    }
  }

  return false;
}

function resolveBuilderExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  options: { followFactoryResults: boolean },
): Extract<CallKind, { kind: "builder" }> | undefined {
  const target = stripWrappers(expression);

  if (ts.isCallExpression(target)) {
    if (!options.followFactoryResults) {
      return undefined;
    }
    return resolveBuilderExpressionKind(
      target.expression,
      checker,
      seen,
      options,
    );
  }

  const symbol = getExpressionSymbol(target, checker);
  if (symbol) {
    const kind = resolveBuilderSymbolKind(symbol, checker, seen, options);
    if (kind) return kind;
  } else {
    const fallbackName = getDirectBuilderName(target);
    if (fallbackName) {
      return { kind: "builder", builderName: fallbackName };
    }
  }

  if (!symbol || canUseBuilderSignatureFallback(symbol)) {
    const type = checker.getTypeAtLocation(target);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    for (const signature of signatures) {
      const signatureSymbol = getSignatureSymbol(signature);
      if (!signatureSymbol) continue;
      const kind = resolveBuilderSymbolKind(
        signatureSymbol,
        checker,
        seen,
        options,
      );
      if (kind) return kind;
    }
  }

  return undefined;
}

function getExpressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name);
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && ts.isExpression(argument)) {
      return checker.getSymbolAtLocation(argument);
    }
  }
  return checker.getSymbolAtLocation(expression);
}

function getDirectBuilderName(expression: ts.Expression): string | undefined {
  if (
    ts.isIdentifier(expression) && BUILDER_SYMBOL_NAMES.has(expression.text)
  ) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === CT_HELPERS_IDENTIFIER &&
    BUILDER_SYMBOL_NAMES.has(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function getSyntheticHelperCallKind(
  expression: ts.Expression,
):
  | Exclude<CallKind, { kind: "builder" | "array-method" | "cell-for" }>
  | undefined {
  if (!ts.isPropertyAccessExpression(expression)) {
    return undefined;
  }
  if (
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== CT_HELPERS_IDENTIFIER
  ) {
    return undefined;
  }
  return createNamedCallKind(expression.name.text);
}

function resolveBuilderSymbolKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  options: { followFactoryResults: boolean },
): Extract<CallKind, { kind: "builder" }> | undefined {
  const importedBuilderName = getImportedCommonToolsNamedExport(
    symbol,
    BUILDER_SYMBOL_NAMES,
  );
  if (importedBuilderName) {
    return { kind: "builder", symbol, builderName: importedBuilderName };
  }

  const resolved = resolveAlias(symbol, checker, seen);
  if (!resolved) return undefined;
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);

  const name = resolved.getName();
  if (BUILDER_SYMBOL_NAMES.has(name) && isCommonToolsSymbol(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }
  if (BUILDER_SYMBOL_NAMES.has(name) && isImportedFromCommonTools(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }
  if (BUILDER_SYMBOL_NAMES.has(name) && isAmbientSymbol(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }

  for (const declaration of resolved.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer &&
      shouldFollowBuilderInitializer(declaration.initializer, options)
    ) {
      const nested = resolveBuilderExpressionKind(
        declaration.initializer,
        checker,
        seen,
        options,
      );
      if (nested) return nested;
    }
  }

  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function shouldFollowBuilderInitializer(
  initializer: ts.Expression,
  options: { followFactoryResults: boolean },
): boolean {
  const target = stripWrappers(initializer);
  return ts.isIdentifier(target) ||
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target) ||
    (options.followFactoryResults && ts.isCallExpression(target));
}

function canUseBuilderSignatureFallback(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return true;

  return declarations.every((declaration) =>
    !ts.isVariableDeclaration(declaration) ||
    (isConstVariableDeclaration(declaration) && !declaration.initializer)
  );
}

function isImportedFromCommonTools(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (ts.isImportDeclaration(current)) {
        return ts.isStringLiteral(current.moduleSpecifier) &&
          (current.moduleSpecifier.text === "commontools" ||
            current.moduleSpecifier.text === "@commontools/common");
      }
      current = current.parent;
    }
    return false;
  });
}

function getImportedCommonToolsNamedExport(
  symbol: ts.Symbol,
  allowedNames: ReadonlySet<string>,
): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current)) {
      current = current.parent;
    }
    if (
      !current ||
      !ts.isImportDeclaration(current) ||
      !ts.isStringLiteral(current.moduleSpecifier) ||
      (current.moduleSpecifier.text !== "commontools" &&
        current.moduleSpecifier.text !== "@commontools/common")
    ) {
      continue;
    }

    const importedName = declaration.propertyName?.text ??
      declaration.name.text;
    if (allowedNames.has(importedName)) {
      return importedName;
    }
  }
  return undefined;
}

function isAmbientSymbol(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) =>
      declaration.getSourceFile().isDeclarationFile ||
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !==
        0
    );
}

function resolveSymbolKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const importedName = getImportedCommonToolsNamedExport(
    symbol,
    COMMONTOOLS_CALL_NAMES,
  );
  if (importedName) {
    return createNamedCallKind(importedName, symbol);
  }

  const resolved = resolveAlias(symbol, checker, seen);
  if (!resolved) return undefined;
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);

  const declarations = resolved.declarations ?? [];
  const name = resolved.getName();

  for (const declaration of declarations) {
    const cellKind = detectCellMethodFromDeclaration(resolved, declaration);
    if (cellKind) return cellKind;

    if (
      isArrayMethodDeclaration(declaration) ||
      isOpaqueRefMethodDeclaration(declaration)
    ) {
      return { kind: "array-method", symbol: resolved };
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
      if (!nested) continue;
      if (
        nested.kind === "builder" &&
        !isConstVariableDeclaration(declaration)
      ) {
        continue;
      }
      return nested;
    }
  }

  const namedCallKind = createNamedCallKind(name, resolved);
  if (
    namedCallKind &&
    (
      isCommonToolsSymbol(resolved) ||
      isImportedFromCommonTools(resolved) ||
      isAmbientSymbol(resolved)
    )
  ) {
    return namedCallKind;
  }

  return undefined;
}

function createNamedCallKind(
  name: string,
  symbol?: ts.Symbol,
):
  | Exclude<CallKind, { kind: "builder" | "array-method" | "cell-for" }>
  | undefined {
  const spec = COMMONTOOLS_RUNTIME_EXPORTS_BY_NAME.get(name);
  if (!spec || spec.category !== "call") {
    return undefined;
  }

  switch (spec.callKind) {
    case "derive":
      return symbol ? { kind: "derive", symbol } : { kind: "derive" };
    case "ifElse":
      return symbol ? { kind: "ifElse", symbol } : { kind: "ifElse" };
    case "when":
      return symbol ? { kind: "when", symbol } : { kind: "when" };
    case "unless":
      return symbol ? { kind: "unless", symbol } : { kind: "unless" };
    case "cell-factory":
      return symbol
        ? { kind: "cell-factory", symbol, factoryName: name }
        : { kind: "cell-factory", factoryName: name };
    case "wish":
      return symbol ? { kind: "wish", symbol } : { kind: "wish" };
    case "generate-text":
      return symbol
        ? { kind: "generate-text", symbol }
        : { kind: "generate-text" };
    case "generate-object":
      return symbol
        ? { kind: "generate-object", symbol }
        : { kind: "generate-object" };
    case "pattern-tool":
      return symbol
        ? { kind: "pattern-tool", symbol }
        : { kind: "pattern-tool" };
    case "runtime-call":
      return symbol
        ? {
          kind: "runtime-call",
          symbol,
          exportName: name,
          reactiveOrigin: spec.reactiveOrigin,
        }
        : {
          kind: "runtime-call",
          exportName: name,
          reactiveOrigin: spec.reactiveOrigin,
        };
  }
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

function isArrayMethodDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (!ARRAY_METHOD_NAMES.has(declaration.name.text)) return false;

  const owner = findOwnerName(declaration);
  if (!owner) return false;
  return ARRAY_OWNER_NAMES.has(owner);
}

function isOpaqueRefMethodDeclaration(declaration: ts.Declaration): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (!ARRAY_METHOD_NAMES.has(declaration.name.text)) return false;

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
