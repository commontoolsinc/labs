/**
 * Call Kind Detection
 *
 * This module identifies compiler-significant call families. Most are
 * Common Fabric-specific calls (derive, ifElse, pattern, etc.), but array-method
 * families are also classified because they establish callback/container
 * boundaries relevant to analysis and lowering.
 *
 * ## Detection Strategy
 *
 * Detection is provenance-first for Common Fabric calls:
 *
 * 1. **Symbol resolution**: Resolve the callee symbol and verify it comes from
 *    Common Fabric declarations or imports.
 *
 * 2. **Alias following**: Follow stable const aliases and call signatures to
 *    preserve detection for `const alias = derive` and `declare const alias:
 *    typeof ifElse` style code.
 *
 * 3. **Synthetic helper support**: Recognize internal `__cfHelpers.*` calls
 *    introduced by the transformer pipeline when symbol resolution is not
 *    available on synthetic nodes.
 *
 * ## Narrow Exceptions
 *
 * The remaining syntactic fallback is intentionally limited to synthetic
 * `__cfHelpers.*` calls, unresolved bare builder identifiers, and explicit
 * reactive array-method receiver checks. Plain array methods share the same
 * syntax family but require separate ownership classification; consumers
 * should use `classifyArrayMethodCallSite(...)` when that distinction matters.
 */
import ts from "typescript";

import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";
import { isCommonFabricSymbol } from "../core/common-fabric-symbols.ts";
import { getEnclosingFunctionLikeDeclaration } from "./function-predicates.ts";
import {
  COMMONFABRIC_BUILDER_EXPORT_NAMES,
  COMMONFABRIC_CALL_EXPORT_NAMES,
  COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES,
  COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES,
  COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME,
} from "../core/commonfabric-runtime-registry.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import { classifyOpaquePathTerminalCall } from "../transformers/opaque-roots.ts";
import { getTypeAtLocationWithFallback } from "./utils.ts";

const BUILDER_SYMBOL_NAMES = COMMONFABRIC_BUILDER_EXPORT_NAMES;

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
const COMMONFABRIC_CALL_NAMES = COMMONFABRIC_CALL_EXPORT_NAMES;
const WILDCARD_OBJECT_METHOD_NAMES = new Set(["keys", "values", "entries"]);

export type ArrayMethodFamilyName = "map" | "filter" | "flatMap";

export interface ArrayMethodAccessKind {
  readonly family: ArrayMethodFamilyName;
  readonly lowered: boolean;
}

const ARRAY_METHOD_ACCESS_BY_NAME = new Map<string, ArrayMethodAccessKind>([
  ["map", { family: "map", lowered: false }],
  ["mapWithPattern", { family: "map", lowered: true }],
  ["filter", { family: "filter", lowered: false }],
  ["filterWithPattern", { family: "filter", lowered: true }],
  ["flatMap", { family: "flatMap", lowered: false }],
  ["flatMapWithPattern", { family: "flatMap", lowered: true }],
]);

function getArrayMethodAccessKindByName(
  name: string,
): ArrayMethodAccessKind | undefined {
  return ARRAY_METHOD_ACCESS_BY_NAME.get(name);
}

function isKnownArrayMethodName(name: string): boolean {
  return ARRAY_METHOD_ACCESS_BY_NAME.has(name);
}

export type ArrayMethodOwnership = "plain" | "reactive";

export interface ArrayMethodCallSiteInfo extends ArrayMethodAccessKind {
  readonly ownership: ArrayMethodOwnership;
}

export interface ReactiveCollectionProvenanceOptions {
  readonly allowTypeBasedRoot?: boolean;
  readonly allowImplicitReactiveParameters?: boolean;
  readonly allowReactiveArrayCallbackParameters?: boolean;
  readonly sameScope?: ts.FunctionLikeDeclaration;
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
  readonly logger?: (message: string) => void;
}

export type ArrayCallbackContainerCallKind =
  | "reactive-array-method"
  | "plain-array-value"
  | "plain-array-void";

type ImplicitReactiveParameterContextKind =
  | "builder"
  | "reactive-array-method";

export interface ArrayMethodResultSinkCallInfo {
  readonly sink: "join";
  readonly receiverFamily: ArrayMethodFamilyName;
  readonly receiverLowered: boolean;
}

export interface ArrayMethodResultSinkReceiverChainCallInfo {
  readonly sinkCall: ArrayMethodResultSinkCallInfo;
  readonly depth: number;
}

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

export type WildcardTraversalCallKind =
  | "object-wildcard-traversal"
  | "json-stringify";

type ExpressionCache<T> = WeakMap<ts.TypeChecker, WeakMap<ts.Expression, T>>;

const callKindCacheByChecker: ExpressionCache<CallKind | null> = new WeakMap();
const directBuilderKindCacheByChecker: ExpressionCache<
  Extract<CallKind, { kind: "builder" }> | null
> = new WeakMap();
const reactiveValueCacheByChecker: ExpressionCache<boolean> = new WeakMap();
const reactiveCollectionProvenanceCacheByChecker: ExpressionCache<boolean> =
  new WeakMap();

function getCheckerExpressionCache<T>(
  cacheByChecker: ExpressionCache<T>,
  checker: ts.TypeChecker,
): WeakMap<ts.Expression, T> {
  let cache = cacheByChecker.get(checker);
  if (!cache) {
    cache = new WeakMap<ts.Expression, T>();
    cacheByChecker.set(checker, cache);
  }
  return cache;
}

function getCachedExpressionValue<T>(
  cacheByChecker: ExpressionCache<T>,
  checker: ts.TypeChecker,
  expression: ts.Expression,
  compute: () => T,
): T {
  const cache = getCheckerExpressionCache(cacheByChecker, checker);
  if (cache.has(expression)) {
    return cache.get(expression)!;
  }
  const value = compute();
  cache.set(expression, value);
  return value;
}

function usesDefaultReactiveCollectionProvenanceOptions(
  options: ReactiveCollectionProvenanceOptions,
): boolean {
  return options.allowTypeBasedRoot === undefined &&
    options.allowImplicitReactiveParameters === undefined &&
    options.allowReactiveArrayCallbackParameters === undefined &&
    options.sameScope === undefined &&
    options.typeRegistry === undefined &&
    options.logger === undefined;
}

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
  return resolveBuilderExpressionKind(
    call.expression,
    checker,
    new Set(),
    { followFactoryResults: false },
  );
}

export function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const builderKind = detectDirectBuilderCall(call, checker);
  if (builderKind?.builderName === "pattern") {
    return true;
  }

  const target = stripWrappers(call.expression);
  return ts.isPropertyAccessExpression(target) &&
    target.name.text === "pattern";
}

export function getPatternBuilderCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!isPatternBuilderCall(call, checker)) {
    return undefined;
  }

  const callbackArg = call.arguments[0];
  if (callbackArg && isCallbackFunctionExpression(callbackArg)) {
    return callbackArg;
  }
  return undefined;
}

export function getPatternToolCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const callKind = detectCallKind(call, checker);
  if (callKind?.kind !== "pattern-tool") {
    const target = stripWrappers(call.expression);
    if (
      !ts.isPropertyAccessExpression(target) ||
      target.name.text !== "patternTool"
    ) {
      return undefined;
    }
  }

  const callbackArg = call.arguments[0];
  if (callbackArg && isCallbackFunctionExpression(callbackArg)) {
    return callbackArg;
  }
  return undefined;
}

export function getCapabilitySummaryCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const callKind = detectCallKind(call, checker);
  if (!callKind) return undefined;

  let callbackArg: ts.Expression | undefined;
  if (callKind.kind === "derive") {
    callbackArg = call.arguments[call.arguments.length - 1];
  } else if (
    callKind.kind === "builder" &&
    (
      callKind.builderName === "lift" ||
      callKind.builderName === "handler" ||
      callKind.builderName === "computed" ||
      callKind.builderName === "action"
    )
  ) {
    callbackArg = call.arguments[0];
  }

  if (callbackArg && isCallbackFunctionExpression(callbackArg)) {
    return callbackArg;
  }
  return undefined;
}

export function getDeriveInputAndCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): {
  input: ts.Expression;
  callback: ts.ArrowFunction | ts.FunctionExpression;
} | undefined {
  const callKind = detectCallKind(call, checker);
  if (callKind?.kind !== "derive") {
    return undefined;
  }

  const callback = getCapabilitySummaryCallbackArgument(call, checker);
  if (!callback) {
    return undefined;
  }

  const callbackIndex = call.arguments.indexOf(callback);
  const inputIndex = callbackIndex === 1 ? 0 : callbackIndex === 3 ? 2 : -1;
  const input = inputIndex >= 0 ? call.arguments[inputIndex] : undefined;
  if (!input) {
    return undefined;
  }

  return { input, callback };
}

export function isReactiveOriginCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callKind = detectCallKind(call, checker);
  return !!callKind && isReactiveOriginKind(callKind);
}

export function classifyWildcardTraversalCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): WildcardTraversalCallKind | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  if (checker) {
    const symbol = checker.getSymbolAtLocation(target.name);
    const resolved = symbol
      ? (resolveAlias(symbol, checker, new Set()) ?? symbol)
      : undefined;

    for (const declaration of resolved?.getDeclarations() ?? []) {
      if (!hasIdentifierName(declaration)) continue;

      const owner = findOwnerName(declaration);
      if (!owner) continue;

      const name = declaration.name.text;
      if (
        owner === "ObjectConstructor" &&
        WILDCARD_OBJECT_METHOD_NAMES.has(name)
      ) {
        return "object-wildcard-traversal";
      }

      if (owner === "JSON" && name === "stringify") {
        return "json-stringify";
      }
    }
  }

  if (
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Object" &&
    WILDCARD_OBJECT_METHOD_NAMES.has(target.name.text)
  ) {
    return "object-wildcard-traversal";
  }

  if (
    ts.isIdentifier(target.expression) &&
    target.expression.text === "JSON" &&
    target.name.text === "stringify"
  ) {
    return "json-stringify";
  }

  return undefined;
}

function isCallbackFunctionExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

export function isWildcardTraversalCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return !!classifyWildcardTraversalCall(call, checker);
}

export function classifyArrayMethodAccess(
  expression: ts.Expression,
): ArrayMethodAccessKind | undefined {
  const target = stripWrappers(expression);

  let methodName: string | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    methodName = target.name.text;
  } else if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteralLike(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      methodName = argument.text;
    }
  }

  return methodName ? getArrayMethodAccessKindByName(methodName) : undefined;
}

export function classifyArrayMethodCall(
  call: ts.CallExpression,
): ArrayMethodAccessKind | undefined {
  return classifyArrayMethodAccess(call.expression);
}

export function getLoweredArrayMethodName(
  family: ArrayMethodFamilyName,
): string {
  return `${family}WithPattern`;
}

export function classifyArrayMethodCallSite(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ArrayMethodCallSiteInfo | undefined {
  const access = classifyArrayMethodCall(call);
  if (!access) {
    return undefined;
  }

  const target = stripWrappers(call.expression);
  if (
    !ts.isPropertyAccessExpression(target) &&
    !ts.isElementAccessExpression(target)
  ) {
    return { ...access, ownership: "plain" };
  }

  return {
    ...access,
    ownership: hasReactiveCollectionProvenance(
        target.expression,
        checker,
      )
      ? "reactive"
      : "plain",
  };
}

export function classifyArrayCallbackContainerCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ArrayCallbackContainerCallKind | undefined {
  const arrayMethodCallSite = classifyArrayMethodCallSite(call, checker);
  if (arrayMethodCallSite?.ownership === "reactive") {
    if (isConsumedByTerminalChainCall(call)) {
      return "plain-array-value";
    }
    return "reactive-array-method";
  }

  if (
    arrayMethodCallSite?.ownership === "plain" &&
    !arrayMethodCallSite.lowered
  ) {
    return "plain-array-value";
  }

  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  if (!signature || !declaration) {
    return undefined;
  }

  const owner = findOwnerName(declaration);
  if (!owner || !ARRAY_OWNER_NAMES.has(owner)) {
    return undefined;
  }

  const returnType = checker.getReturnTypeOfSignature(signature);
  return (returnType.flags & ts.TypeFlags.Void) === 0
    ? "plain-array-value"
    : "plain-array-void";
}

export function classifyArrayMethodResultSinkCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): ArrayMethodResultSinkCallInfo | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const receiver = stripWrappers(target.expression);
  if (!ts.isCallExpression(receiver)) {
    return undefined;
  }

  const receiverMethod = classifyArrayMethodCall(receiver);
  if (!receiverMethod) {
    return undefined;
  }

  if (checker) {
    const symbol = checker.getSymbolAtLocation(target.name);
    const resolved = symbol
      ? (resolveAlias(symbol, checker, new Set()) ?? symbol)
      : undefined;
    const declarations = resolved?.getDeclarations() ?? [];

    for (const declaration of declarations) {
      if (!hasIdentifierName(declaration)) continue;

      const owner = findOwnerName(declaration);
      if (!owner) continue;

      if (
        ARRAY_OWNER_NAMES.has(owner) &&
        declaration.name.text === "join"
      ) {
        return {
          sink: "join",
          receiverFamily: receiverMethod.family,
          receiverLowered: receiverMethod.lowered,
        };
      }
    }

    if (declarations.length > 0) {
      return undefined;
    }
  }

  if (target.name.text === "join") {
    return {
      sink: "join",
      receiverFamily: receiverMethod.family,
      receiverLowered: receiverMethod.lowered,
    };
  }

  return undefined;
}

export function classifyArrayMethodResultSinkReceiverChainCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): ArrayMethodResultSinkReceiverChainCallInfo | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const receiver = stripWrappers(target.expression);
  if (!ts.isCallExpression(receiver)) {
    return undefined;
  }

  const sinkCall = classifyArrayMethodResultSinkCall(receiver, checker);
  if (!sinkCall) {
    const receiverChain = classifyArrayMethodResultSinkReceiverChainCall(
      receiver,
      checker,
    );
    if (!receiverChain) {
      return undefined;
    }

    return {
      sinkCall: receiverChain.sinkCall,
      depth: receiverChain.depth + 1,
    };
  }

  return {
    sinkCall,
    depth: 1,
  };
}

function isReactiveOriginKind(callKind: CallKind): boolean {
  switch (callKind.kind) {
    case "builder":
      return COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES.has(
        callKind.builderName,
      );
    case "cell-factory":
    case "cell-for":
      return true;
    case "derive":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("derive");
    case "ifElse":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("ifElse");
    case "when":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("when");
    case "unless":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("unless");
    case "wish":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("wish");
    case "generate-text":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("generateText");
    case "generate-object":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has(
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
  return hasImplicitReactiveParameterContext(symbol, checker) ||
    isVariableFromReactiveCallSymbol(symbol, checker);
}

export function isReactiveValueExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return getCachedExpressionValue(
    reactiveValueCacheByChecker,
    checker,
    expression,
    () => {
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
        return isReactiveValueSymbol(
          checker.getSymbolAtLocation(target),
          checker,
        );
      }

      if (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        return isReactiveValueExpression(target.expression, checker);
      }

      if (ts.isCallExpression(target)) {
        if (classifyOpaquePathTerminalCall(target) === "key") {
          return true;
        }
        if (isReactiveOriginCall(target, checker)) {
          return true;
        }
        return isLoweredReactiveArrayMethodCall(target, checker);
      }

      return false;
    },
  );
}

export function hasReactiveCollectionProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  options: ReactiveCollectionProvenanceOptions = {},
): boolean {
  if (usesDefaultReactiveCollectionProvenanceOptions(options)) {
    return getCachedExpressionValue(
      reactiveCollectionProvenanceCacheByChecker,
      checker,
      expression,
      () =>
        hasReactiveCollectionProvenanceInternal(
          expression,
          checker,
          options,
          new Set(),
        ),
    );
  }

  return hasReactiveCollectionProvenanceInternal(
    expression,
    checker,
    options,
    new Set(),
  );
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

function hasReactiveCollectionProvenanceInternal(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  options: ReactiveCollectionProvenanceOptions,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = stripWrappers(expression);
  if (options.allowTypeBasedRoot !== false) {
    const type = getTypeAtLocationWithFallback(
      target,
      checker,
      options.typeRegistry,
      options.logger,
    );
    if (type && isOpaqueRefType(type, checker)) {
      return true;
    }
  }

  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return hasReactiveCollectionProvenanceInternal(
      target.expression,
      checker,
      options,
      seenSymbols,
    );
  }

  if (
    ts.isBinaryExpression(target) &&
    (
      target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )
  ) {
    return hasReactiveCollectionProvenanceInternal(
      target.left,
      checker,
      options,
      seenSymbols,
    ) || hasReactiveCollectionProvenanceInternal(
      target.right,
      checker,
      options,
      seenSymbols,
    );
  }

  if (ts.isCallExpression(target)) {
    if (classifyOpaquePathTerminalCall(target) === "key") {
      return true;
    }

    const arrayMethodCall = classifyArrayMethodCall(target);
    if (
      arrayMethodCall &&
      (
        ts.isPropertyAccessExpression(target.expression) ||
        ts.isElementAccessExpression(target.expression)
      )
    ) {
      return hasReactiveCollectionProvenanceInternal(
        target.expression.expression,
        checker,
        options,
        seenSymbols,
      );
    }

    if (isReactiveOriginCall(target, checker)) {
      return true;
    }

    const directBuilder = detectDirectBuilderCall(target, checker);
    return !!directBuilder &&
      COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES.has(directBuilder.builderName);
  }

  if (!ts.isIdentifier(target)) {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);

  if (
    options.allowImplicitReactiveParameters !== false &&
    isSymbolDeclaredInScope(symbol, options.sameScope)
  ) {
    const implicitContext = getImplicitReactiveParameterContextKind(
      symbol,
      checker,
    );
    if (
      implicitContext === "builder" ||
      (
        options.allowReactiveArrayCallbackParameters !== false &&
        implicitContext === "reactive-array-method"
      )
    ) {
      return true;
    }
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (!isDeclarationInScope(declaration, options.sameScope)) {
      continue;
    }

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (
        hasReactiveCollectionProvenanceInternal(
          declaration.initializer,
          checker,
          options,
          seenSymbols,
        )
      ) {
        return true;
      }
      continue;
    }

    if (!ts.isBindingElement(declaration)) {
      continue;
    }

    let parent: ts.Node = declaration;
    while (
      ts.isBindingElement(parent) ||
      ts.isObjectBindingPattern(parent) ||
      ts.isArrayBindingPattern(parent)
    ) {
      parent = parent.parent;
    }

    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer &&
      hasReactiveCollectionProvenanceInternal(
        parent.initializer,
        checker,
        options,
        seenSymbols,
      )
    ) {
      return true;
    }
  }

  return false;
}

function resolveExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const cache = getCheckerExpressionCache(callKindCacheByChecker, checker);
  if (cache.has(expression)) {
    return cache.get(expression) ?? undefined;
  }

  const target = stripWrappers(expression);

  const builderKind = resolveBuilderExpressionKind(target, checker, new Set(), {
    followFactoryResults: true,
  });
  if (builderKind) {
    cache.set(expression, builderKind);
    return builderKind;
  }

  const syntheticHelperKind = getSyntheticHelperCallKind(target);
  if (syntheticHelperKind) {
    cache.set(expression, syntheticHelperKind);
    return syntheticHelperKind;
  }

  if (ts.isCallExpression(target)) {
    const result = resolveExpressionKind(target.expression, checker, seen);
    cache.set(expression, result ?? null);
    return result;
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
    if (kind) {
      cache.set(expression, kind);
      return kind;
    }
  }

  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    if (isKnownArrayMethodName(name)) {
      // Fallback path: when symbol resolution doesn't already identify the
      // array-method family, only treat it as such for reactive receivers.
      if (isReactiveArrayMethodReceiverExpression(target.expression, checker)) {
        const result = { kind: "array-method" } as const;
        cache.set(expression, result);
        return result;
      }
    }
  }

  const type = checker.getTypeAtLocation(target);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  for (const signature of signatures) {
    const signatureSymbol = getSignatureSymbol(signature);
    if (!signatureSymbol) continue;
    const kind = resolveSymbolKind(signatureSymbol, checker, seen);
    if (kind) {
      cache.set(expression, kind);
      return kind;
    }
  }

  cache.set(expression, null);
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

export function isConsumedByTerminalChainCall(
  call: ts.CallExpression,
): boolean {
  let current: ts.Expression = call;

  while (true) {
    const parent = current.parent;
    if (!parent) {
      return false;
    }

    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
      continue;
    }

    if (
      ts.isPropertyAccessExpression(parent) && parent.expression === current
    ) {
      const memberName = parent.name.text;
      if (isKnownArrayMethodName(memberName)) {
        const callParent = parent.parent;
        if (
          callParent &&
          ts.isCallExpression(callParent) &&
          callParent.expression === parent
        ) {
          current = callParent;
          continue;
        }
      }
      return true;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      return true;
    }

    if (ts.isCallExpression(parent) && parent.expression === current) {
      return true;
    }

    return false;
  }
}

function isLoweredReactiveArrayMethodCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callSite = classifyArrayMethodCallSite(call, checker);
  return !!callSite &&
    callSite.lowered &&
    callSite.ownership === "reactive";
}

function hasImplicitReactiveParameterContext(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  return !!getImplicitReactiveParameterContextKind(symbol, checker);
}

function getImplicitReactiveParameterContextKind(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ImplicitReactiveParameterContextKind | undefined {
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

    const call = candidate as ts.CallExpression;
    const callKind = detectCallKind(call, checker);
    if (callKind?.kind === "builder") {
      return "builder";
    }

    if (
      classifyArrayCallbackContainerCall(call, checker) ===
        "reactive-array-method"
    ) {
      return "reactive-array-method";
    }
  }

  return undefined;
}

function isReactiveArrayMethodReceiverExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return hasReactiveCollectionProvenance(expression, checker);
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

function isDeclarationInScope(
  declaration: ts.Declaration,
  scope: ts.FunctionLikeDeclaration | undefined,
): boolean {
  if (!scope) {
    return true;
  }

  return getEnclosingFunctionLikeDeclaration(declaration) === scope;
}

function isSymbolDeclaredInScope(
  symbol: ts.Symbol,
  scope: ts.FunctionLikeDeclaration | undefined,
): boolean {
  if (!scope) {
    return true;
  }

  return (symbol.getDeclarations() ?? []).some((declaration) =>
    isDeclarationInScope(declaration, scope)
  );
}

function resolveBuilderExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  options: { followFactoryResults: boolean },
): Extract<CallKind, { kind: "builder" }> | undefined {
  const cache = options.followFactoryResults
    ? undefined
    : getCheckerExpressionCache(directBuilderKindCacheByChecker, checker);
  if (cache?.has(expression)) {
    return cache.get(expression) ?? undefined;
  }

  const target = stripWrappers(expression);

  if (ts.isCallExpression(target)) {
    if (!options.followFactoryResults) {
      cache?.set(expression, null);
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
    if (kind) {
      cache?.set(expression, kind);
      return kind;
    }
  } else {
    const fallbackName = getDirectBuilderName(target);
    if (fallbackName) {
      const result = { kind: "builder", builderName: fallbackName } as const;
      cache?.set(expression, result);
      return result;
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
      if (kind) {
        cache?.set(expression, kind);
        return kind;
      }
    }
  }

  cache?.set(expression, null);
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
    expression.expression.text === CF_HELPERS_IDENTIFIER &&
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
    expression.expression.text !== CF_HELPERS_IDENTIFIER
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
  const importedBuilderName = getImportedCommonFabricNamedExport(
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
  if (BUILDER_SYMBOL_NAMES.has(name) && isCommonFabricSymbol(resolved)) {
    return { kind: "builder", symbol: resolved, builderName: name };
  }
  if (BUILDER_SYMBOL_NAMES.has(name) && isImportedFromCommonFabric(resolved)) {
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

function isImportedFromCommonFabric(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (ts.isImportDeclaration(current)) {
        return ts.isStringLiteral(current.moduleSpecifier) &&
          (current.moduleSpecifier.text === "commonfabric" ||
            current.moduleSpecifier.text === "@commonfabric/common");
      }
      current = current.parent;
    }
    return false;
  });
}

function getImportedCommonFabricNamedExport(
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
      (current.moduleSpecifier.text !== "commonfabric" &&
        current.moduleSpecifier.text !== "@commonfabric/common")
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
  const importedName = getImportedCommonFabricNamedExport(
    symbol,
    COMMONFABRIC_CALL_NAMES,
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
      isCommonFabricSymbol(resolved) ||
      isImportedFromCommonFabric(resolved) ||
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
  const spec = COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME.get(name);
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
  return isMethodDeclarationOwnedBy(
    declaration,
    isKnownArrayMethodName,
    ARRAY_OWNER_NAMES,
  );
}

function isOpaqueRefMethodDeclaration(declaration: ts.Declaration): boolean {
  return isMethodDeclarationOwnedBy(
    declaration,
    isKnownArrayMethodName,
    OPAQUE_REF_OWNER_NAMES,
  );
}

function isMethodDeclarationOwnedBy(
  declaration: ts.Declaration,
  hasMethodName: (name: string) => boolean,
  ownerNames: ReadonlySet<string>,
): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (!hasMethodName(declaration.name.text)) return false;

  const owner = findOwnerName(declaration);
  return !!owner && ownerNames.has(owner);
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
