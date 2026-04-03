import ts from "typescript";
import { createRegisteredTypeLiteral } from "../ast/type-building.ts";

import {
  classifyArrayMethodCall,
  detectCallKind,
  ensureTypeNodeRegistered,
  getDeriveInputAndCallbackArgument,
  getTypeAtLocationWithFallback,
  getTypeFromTypeNodeWithFallback,
  getVariableInitializer,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  isFunctionLikeExpression,
  isUnresolvedSchemaType,
  registerSyntheticCallType,
  typeToSchemaTypeNode,
  unwrapCellLikeType,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "../ast/mod.ts";
import {
  type CapabilityParamSummary,
  type CapabilitySummaryRegistry,
  HelpersOnlyTransformer,
  TransformationContext,
  type TypeRegistry,
} from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";
import {
  applyShrinkAndWrap,
  type CapabilitySummaryApplicationMode,
  containsAnyOrUnknownTypeNode,
  isCellLikeTypeNode,
  printTypeNode,
} from "./type-shrinking.ts";

/**
 * Schema Injection Transformer - TypeRegistry Integration
 *
 * This transformer injects JSON schemas for CommonTools core functions (pattern, derive,
 * pattern, handler, lift) by analyzing TypeScript types and converting them to runtime schemas.
 *
 * ## TypeRegistry Integration (Unified Approach)
 *
 * All transformation paths now consistently check the TypeRegistry for closure-captured types.
 * The TypeRegistry is a WeakMap<TypeNode, Type> that enables coordination between transformers:
 *
 * 1. **ClosureTransformer** (runs first):
 *    - Creates synthetic TypeNodes for closure-captured variables
 *    - Registers TypeNode -> Type mappings in TypeRegistry
 *    - Enables type information preservation through AST transformations
 *
 * 2. **SchemaInjectionTransformer** (this file):
 *    - Checks TypeRegistry for existing Type mappings before inferring types
 *    - Preserves closure-captured type information from ClosureTransformer
 *    - Registers newly inferred types back into TypeRegistry
 *
 * 3. **SchemaGeneratorTransformer** (runs last):
 *    - Uses TypeRegistry to find Type information for synthetic TypeNodes
 *    - Generates accurate JSON schemas even for transformed/synthetic nodes
 *
 * ## Pattern-Specific Behavior
 *
 * - **Handler**: Checks TypeRegistry for type arguments, uses `unknown` fallback
 * - **Derive**: Checks TypeRegistry for type arguments, preserves shorthand property types
 * - **Pattern**: Checks TypeRegistry before inferring, registers inferred types
 * - **Pattern**: Checks TypeRegistry for type arguments
 * - **Lift**: Checks TypeRegistry for type arguments and inferred types
 *
 * ## Why This Matters
 *
 * Without TypeRegistry checking, closure-captured variables lose their type information
 * when ClosureTransformer creates synthetic AST nodes. By checking the registry first,
 * we preserve the original Type information and generate accurate schemas.
 *
 * Example: `const foo = { label: "test" }; pattern(() => ({ cell: foo }))`
 * - ClosureTransformer creates synthetic type for `foo`, registers it
 * - SchemaInjectionTransformer finds that type in TypeRegistry
 * - SchemaGeneratorTransformer uses it to create accurate schema for `foo`
 */

function shouldDropFallbackTypeForSchema(
  node: ts.TypeNode | undefined,
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  if (!node || !type) return false;
  if (containsAnyOrUnknownTypeNode(node)) return false;

  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  let rebuilt: ts.TypeNode | undefined;
  try {
    rebuilt = checker.typeToTypeNode(type, sourceFile, typeToNodeFlags);
  } catch (_e: unknown) {
    // typeToTypeNode can throw on deeply recursive or circular types.
    rebuilt = undefined;
  }
  if (!rebuilt) return false;
  return containsAnyOrUnknownTypeNode(rebuilt);
}

function normalizeTypeNodeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function extractCellLikeInnerTypeNode(
  node: ts.TypeNode,
): ts.TypeNode | undefined {
  if (!isCellLikeTypeNode(node)) return undefined;
  if (!ts.isTypeReferenceNode(node)) return undefined;
  if (!node.typeArguments || node.typeArguments.length === 0) return undefined;
  return node.typeArguments[0];
}

function getSymbolTypeAtSource(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.Type {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ??
    sourceFile;
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function findCapabilitySummaryForParameter(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
  capabilityRegistry?: CapabilitySummaryRegistry,
  options?: {
    readonly checker?: ts.TypeChecker;
    readonly includeNestedCallbacks?: boolean;
  },
): CapabilityParamSummary | undefined {
  const summary = options?.includeNestedCallbacks
    ? analyzeFunctionCapabilities(fn, {
      checker: options.checker,
      includeNestedCallbacks: true,
    })
    : capabilityRegistry
    ? (capabilityRegistry.get(fn) ?? analyzeFunctionCapabilities(fn))
    : undefined;
  if (!summary) return undefined;
  const parameter = fn.parameters[index];
  if (!parameter) return undefined;
  const paramName = ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : `__param${index}`;
  return summary.params.find((param) => param.name === paramName);
}

function applyCapabilitySummaryToArgument(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  argumentNode: ts.TypeNode | undefined,
  argumentType: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  capabilityRegistry?: CapabilitySummaryRegistry,
  mode: CapabilitySummaryApplicationMode = "full",
  context?: TransformationContext,
  fnNode?: ts.Node,
): ts.TypeNode | undefined {
  if (!argumentNode) return argumentNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    0,
    capabilityRegistry,
    (argumentNode.pos < 0 || argumentNode.end < 0) &&
      context?.isSyntheticComputeCallback?.(fnNode ?? fn)
      ? {
        checker,
        includeNestedCallbacks: true,
      }
      : undefined,
  );
  if (!paramSummary) {
    return argumentNode;
  }

  const innerTypeNode = extractCellLikeInnerTypeNode(argumentNode);
  const shouldWrap = !!innerTypeNode;
  const baseTypeNode = innerTypeNode ?? argumentNode;
  let baseType = shouldWrap && argumentType
    ? (unwrapCellLikeType(argumentType, checker) ?? argumentType)
    : argumentType;

  if (!baseType) {
    baseType = getTypeFromTypeNodeWithFallback(
      baseTypeNode,
      checker,
      context?.options.typeRegistry,
    );
  }

  return applyShrinkAndWrap(
    paramSummary,
    baseTypeNode,
    baseType,
    shouldWrap,
    checker,
    sourceFile,
    factory,
    mode,
    mode === "defaults_only" ? "opaque" : paramSummary.capability,
    context,
    fnNode ?? fn,
  );
}

function applyCapabilitySummaryToParameter(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  parameterIndex: number,
  parameterNode: ts.TypeNode | undefined,
  parameterType: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  capabilityRegistry?: CapabilitySummaryRegistry,
  context?: TransformationContext,
  fnNode?: ts.Node,
): ts.TypeNode | undefined {
  if (!parameterNode) return parameterNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    parameterIndex,
    capabilityRegistry,
    parameterNode.pos < 0 || parameterNode.end < 0
      ? {
        checker,
        includeNestedCallbacks: true,
      }
      : undefined,
  );
  if (!paramSummary) {
    return parameterNode;
  }

  const innerTypeNode = extractCellLikeInnerTypeNode(parameterNode);
  const shouldWrap = !!innerTypeNode;
  const baseTypeNode = innerTypeNode ?? parameterNode;
  let baseType = shouldWrap && parameterType
    ? (unwrapCellLikeType(parameterType, checker) ?? parameterType)
    : parameterType;

  if (!baseType) {
    baseType = getTypeFromTypeNodeWithFallback(
      baseTypeNode,
      checker,
      context?.options.typeRegistry,
    );
  }

  return applyShrinkAndWrap(
    paramSummary,
    baseTypeNode,
    baseType,
    shouldWrap,
    checker,
    sourceFile,
    factory,
    "full",
    paramSummary.capability,
    context,
    fnNode ?? fn,
  );
}

function collectFunctionSchemaTypeNodes(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  fallbackArgType?: ts.Type,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
  argumentCapabilityMode: CapabilitySummaryApplicationMode = "full",
  context?: TransformationContext,
): {
  argument?: ts.TypeNode;
  argumentType?: ts.Type; // Store the Type for registry
  result?: ts.TypeNode;
  resultType?: ts.Type; // Store the Type for registry
} {
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!signature) return {};

  // 1. Get parameter TypeNode (prefer original if it exists)
  const parameter = fn.parameters.length > 0 ? fn.parameters[0] : undefined;
  let argumentNode: ts.TypeNode | undefined;
  let argumentType: ts.Type | undefined;

  // Check for underscore prefix FIRST - this convention overrides type inference
  // Underscore-prefixed parameters are intentionally unused and should be `never`
  if (isIntentionallyUnusedSchemaParameter(parameter)) {
    // Return never type directly - don't infer or use explicit type
    argumentNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  } else if (parameter?.type) {
    // Use original TypeNode from source - preserves all type information!
    argumentNode = parameter.type;
    // Also get the Type for registry - use fallback for synthetic TypeNodes
    argumentType = getTypeFromTypeNodeWithFallback(
      parameter.type,
      checker,
      typeRegistry,
    );
  } else {
    // Need to infer - get type and convert to TypeNode
    const paramType = inferParameterType(
      parameter,
      signature,
      checker,
      fallbackArgType,
      typeRegistry,
    );
    if (paramType && !isAnyOrUnknownType(paramType)) {
      argumentType = paramType; // Store for registry
      argumentNode = typeToSchemaTypeNode(paramType, checker, sourceFile);
    }
    // If inference failed, leave argumentNode undefined - we'll use unknown below
  }

  // Capability-based shrinking and wrapper selection for the first parameter.
  const originalArgumentNode = argumentNode;
  const originalArgumentType = argumentType;
  argumentNode = applyCapabilitySummaryToArgument(
    fn,
    argumentNode,
    argumentType,
    checker,
    sourceFile,
    factory,
    capabilityRegistry,
    argumentCapabilityMode,
    context,
    fn,
  );
  if (
    argumentNode && originalArgumentNode &&
    argumentNode !== originalArgumentNode
  ) {
    // The node was wrapped/shrunk synthetically; recover a concrete Type when
    // possible so schema generation does not degrade to unknown/true.
    let recovered: ts.Type | undefined;
    try {
      recovered = getTypeFromTypeNodeWithFallback(
        argumentNode,
        checker,
        typeRegistry,
      );
    } catch (_e: unknown) {
      // Synthetic wrapped/shrunk nodes may not be resolvable by the checker.
      recovered = undefined;
    }

    if (recovered && !isAnyOrUnknownType(recovered)) {
      argumentType = recovered;
    } else if (
      originalArgumentType && !isAnyOrUnknownType(originalArgumentType) &&
      normalizeTypeNodeText(printTypeNode(argumentNode, sourceFile)) ===
        normalizeTypeNodeText(printTypeNode(originalArgumentNode, sourceFile))
    ) {
      // If lowering recreated an equivalent TypeNode (new identity, same shape),
      // preserve the original inferred type to avoid degrading property schemas.
      argumentType = originalArgumentType;
    } else {
      argumentType = undefined;
    }
  }

  if (
    shouldDropFallbackTypeForSchema(
      argumentNode,
      argumentType,
      checker,
      sourceFile,
    )
  ) {
    argumentType = undefined;
  }

  // 2. Get return type TypeNode
  let resultNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;

  if (fn.type) {
    // Explicit return type annotation - use it directly!
    resultNode = fn.type;
    // Also get the Type for registry - use fallback for synthetic TypeNodes
    resultType = getTypeFromTypeNodeWithFallback(
      fn.type,
      checker,
      typeRegistry,
    );
  } else {
    // Need to infer return type
    const returnType = inferReturnType(fn, signature, checker);
    if (returnType && !isUnresolvedSchemaType(returnType)) {
      resultType = returnType; // Store for registry
      resultNode = typeToSchemaTypeNode(returnType, checker, sourceFile);
    }
    // If inference failed, leave resultNode undefined - we'll use unknown below
  }

  if (
    shouldDropFallbackTypeForSchema(
      resultNode,
      resultType,
      checker,
      sourceFile,
    )
  ) {
    resultType = undefined;
  }

  const needsResultRecovery = !resultNode ||
    containsAnyOrUnknownTypeNode(resultNode) ||
    shouldDropFallbackTypeForSchema(
      resultNode,
      resultType,
      checker,
      sourceFile,
    );

  if (needsResultRecovery) {
    const returnExpr = getCallbackReturnExpression(fn);
    if (context && returnExpr && ts.isObjectLiteralExpression(returnExpr)) {
      const recoveredNode = buildObjectLiteralReturnTypeNode(
        returnExpr,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        capabilityRegistry,
        context,
      );
      if (recoveredNode) {
        resultNode = recoveredNode;
        resultType = undefined;
      }
    }

    if (!resultNode || containsAnyOrUnknownTypeNode(resultNode)) {
      const projectedResult = recoverProjectedResultSchema(
        fn,
        checker,
        sourceFile,
        argumentNode,
        argumentType ?? fallbackArgType,
        typeRegistry,
      );
      if (projectedResult?.result) {
        resultNode = projectedResult.result;
        resultType = projectedResult.resultType;
      }
    }
  }

  // 3. If we couldn't infer a type, we can't transform at all
  // Both types are required for derive/lift to work
  if (!argumentNode && !resultNode) {
    return {}; // No types could be determined
  }

  // Build result object with only defined properties
  const result: {
    argument?: ts.TypeNode;
    argumentType?: ts.Type;
    result?: ts.TypeNode;
    resultType?: ts.Type;
  } = {};

  if (argumentNode) {
    result.argument = argumentNode;
    if (argumentType) result.argumentType = argumentType;
  }
  if (resultNode) {
    result.result = resultNode;
    if (resultType) result.resultType = resultType;
  }

  return result;
}

function createToSchemaCall(
  { ctHelpers, factory }: Pick<
    TransformationContext,
    "ctHelpers" | "factory"
  >,
  typeNode: ts.TypeNode,
  options?: { widenLiterals?: boolean },
): ts.CallExpression {
  const expr = ctHelpers.getHelperExpr("toSchema");

  // Build arguments array if options are provided
  const args: ts.Expression[] = [];
  if (options?.widenLiterals) {
    args.push(
      factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
          "widenLiterals",
          factory.createTrue(),
        ),
      ]),
    );
  }

  return factory.createCallExpression(
    expr,
    [typeNode],
    args,
  );
}

function createUnknownSchemaTypeNode(factory: ts.NodeFactory): ts.TypeNode {
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

function typeToInjectableSchemaTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.TypeNode | undefined {
  if (!type) return undefined;
  if (isUnresolvedSchemaType(type)) {
    return createUnknownSchemaTypeNode(factory);
  }
  return typeToSchemaTypeNode(type, checker, sourceFile);
}

function normalizeSchemaInjectionTypeNode(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
): ts.TypeNode {
  try {
    const type = getTypeFromTypeNodeWithFallback(
      typeNode,
      checker,
      typeRegistry,
    );
    if (isUnresolvedSchemaType(type)) {
      return createUnknownSchemaTypeNode(factory);
    }
  } catch (_e: unknown) {
    // Some synthetic nodes may not round-trip through the checker cleanly.
  }

  return typeNode;
}

function inferSchemaContextualType(
  node: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return checker.getContextualType(node) ?? inferContextualType(node, checker);
}

interface ResolvedInjectableSchemaType {
  readonly typeNode?: ts.TypeNode;
  readonly type?: ts.Type;
  readonly inferred: boolean;
}

interface ResolvedDualSchemaBuilderTypes {
  readonly argumentTypeNode: ts.TypeNode;
  readonly argumentTypeValue: ts.Type | undefined;
  readonly resultTypeNode: ts.TypeNode;
  readonly resultTypeValue: ts.Type | undefined;
}

function resolveInjectableSchemaType(
  explicitTypeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: TypeRegistry | undefined,
  inferType: () => ts.Type | undefined,
): ResolvedInjectableSchemaType {
  if (explicitTypeNode) {
    return {
      typeNode: explicitTypeNode,
      type: getTypeFromTypeNodeWithFallback(
        explicitTypeNode,
        checker,
        typeRegistry,
      ),
      inferred: false,
    };
  }

  const inferredType = inferType();
  return {
    typeNode: typeToInjectableSchemaTypeNode(
      inferredType,
      checker,
      sourceFile,
      factory,
    ),
    type: inferredType,
    inferred: true,
  };
}

/**
 * Creates a schema call and transfers TypeRegistry entry if it exists.
 * This is the unified pattern for all transformation paths to preserve
 * closure-captured type information from ClosureTransformer.
 *
 * @param context - Transformation context
 * @param typeNode - The TypeNode to create a schema for
 * @param typeRegistry - Optional TypeRegistry to check for existing types
 * @param options - Optional schema generation options
 * @returns CallExpression for toSchema() with TypeRegistry entry transferred
 */
function createSchemaCallWithRegistryTransfer(
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
  options?: { widenLiterals?: boolean },
): ts.CallExpression {
  const emittedTypeNode = normalizeSchemaInjectionTypeNode(
    typeNode,
    checker,
    context.factory,
    typeRegistry,
  );
  const schemaCall = createToSchemaCall(context, emittedTypeNode, options);

  // Transfer TypeRegistry entry from source typeNode to schema call
  // This preserves type information for closure-captured variables
  if (typeRegistry && emittedTypeNode === typeNode) {
    const typeFromRegistry = typeRegistry.get(typeNode);
    if (typeFromRegistry) {
      typeRegistry.set(schemaCall, typeFromRegistry);
    }
  }

  return schemaCall;
}

function createRegisteredSchemaCallFromResolvedType(
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  resolved: ResolvedInjectableSchemaType,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
  options?: { widenLiterals?: boolean },
): ts.CallExpression | undefined {
  if (!resolved.typeNode) {
    return undefined;
  }

  const schemaCall = createSchemaCallWithRegistryTransfer(
    context,
    resolved.typeNode,
    checker,
    typeRegistry,
    options,
  );

  if (
    resolved.inferred &&
    typeRegistry &&
    resolved.type &&
    !isUnresolvedSchemaType(resolved.type)
  ) {
    typeRegistry.set(schemaCall, resolved.type);
  }

  return schemaCall;
}

/**
 * Gets type from TypeRegistry if available, otherwise uses fallback.
 * Used for inferred types that may have been created by ClosureTransformer.
 *
 * @param typeNode - The TypeNode to look up in registry
 * @param fallbackType - Type to use if not found in registry
 * @param typeRegistry - Optional TypeRegistry to check
 * @returns Type from registry or fallback type
 */
function getTypeFromRegistryOrFallback(
  typeNode: ts.TypeNode | undefined,
  fallbackType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
): ts.Type | undefined {
  if (typeNode && typeRegistry?.has(typeNode)) {
    return typeRegistry.get(typeNode);
  }
  return fallbackType;
}

function registerInjectedCallResultType(
  originalCall: ts.CallExpression,
  updatedCall: ts.CallExpression,
  resultTypeNode: ts.TypeNode,
  resultTypeValue: ts.Type | undefined,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): void {
  if (!typeRegistry) return;

  const resolvedType = getTypeFromRegistryOrFallback(
    resultTypeNode,
    resultTypeValue,
    typeRegistry,
  ) ?? getTypeFromTypeNodeWithFallback(resultTypeNode, checker, typeRegistry);

  if (!resolvedType || isAnyOrUnknownType(resolvedType)) {
    return;
  }

  registerSyntheticCallType(updatedCall, resolvedType, typeRegistry);
  registerSyntheticCallType(originalCall, resolvedType, typeRegistry);
}

function applyCallbackBuilderArgumentCapabilitySummary(
  callback: ts.ArrowFunction | ts.FunctionExpression | undefined,
  argumentTypeNode: ts.TypeNode,
  argumentTypeValue: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  capabilityRegistry: CapabilitySummaryRegistry | undefined,
  context: TransformationContext,
): {
  argumentTypeNode: ts.TypeNode;
  argumentTypeValue: ts.Type | undefined;
} {
  if (!callback) {
    return { argumentTypeNode, argumentTypeValue };
  }

  const transformedArgumentType = applyCapabilitySummaryToArgument(
    callback,
    argumentTypeNode,
    argumentTypeValue,
    checker,
    sourceFile,
    factory,
    capabilityRegistry,
    "full",
    context,
    callback,
  );

  if (!transformedArgumentType) {
    return { argumentTypeNode, argumentTypeValue };
  }

  return {
    argumentTypeNode: transformedArgumentType,
    argumentTypeValue: transformedArgumentType === argumentTypeNode
      ? argumentTypeValue
      : undefined,
  };
}

function resolveDualSchemaBuilderTypes(
  callback: ts.ArrowFunction | ts.FunctionExpression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry: TypeRegistry | undefined,
  capabilityRegistry: CapabilitySummaryRegistry | undefined,
  context: TransformationContext,
  options?: {
    readonly fallbackArgumentType?: ts.Type;
    readonly explicitArgumentTypeNode?: ts.TypeNode;
    readonly explicitArgumentTypeValue?: ts.Type;
    readonly explicitResultTypeNode?: ts.TypeNode;
    readonly explicitResultTypeValue?: ts.Type;
    readonly fallbackArgumentNode?: ts.TypeNode;
    readonly capabilityMode?: CapabilitySummaryApplicationMode;
    readonly applyExplicitArgumentCapabilitySummary?: boolean;
  },
): ResolvedDualSchemaBuilderTypes | undefined {
  let argumentTypeNode = options?.explicitArgumentTypeNode;
  let argumentTypeValue = options?.explicitArgumentTypeValue;

  if (
    callback &&
    argumentTypeNode &&
    options?.applyExplicitArgumentCapabilitySummary !== false
  ) {
    ({
      argumentTypeNode,
      argumentTypeValue,
    } = applyCallbackBuilderArgumentCapabilitySummary(
      callback,
      argumentTypeNode,
      argumentTypeValue,
      checker,
      sourceFile,
      factory,
      capabilityRegistry,
      context,
    ));
  }

  let inferred:
    | ReturnType<typeof collectFunctionSchemaTypeNodes>
    | undefined;
  if (!argumentTypeNode || !options?.explicitResultTypeNode) {
    if (!callback) {
      return undefined;
    }
    inferred = collectFunctionSchemaTypeNodes(
      callback,
      checker,
      sourceFile,
      factory,
      options?.fallbackArgumentType,
      typeRegistry,
      capabilityRegistry,
      options?.capabilityMode ?? "full",
      context,
    );
  }

  if (!argumentTypeNode) {
    argumentTypeNode = inferred?.argument ??
      options?.fallbackArgumentNode ??
      getParameterSchemaType(factory, callback?.parameters[0]);
    argumentTypeValue = getTypeFromRegistryOrFallback(
      argumentTypeNode,
      inferred?.argumentType,
      typeRegistry,
    );
  }

  const resultTypeNode = options?.explicitResultTypeNode ??
    inferred?.result ??
    createUnknownSchemaTypeNode(factory);
  const resultTypeValue = options?.explicitResultTypeValue ??
    getTypeFromRegistryOrFallback(
      resultTypeNode,
      inferred?.resultType,
      typeRegistry,
    );

  return {
    argumentTypeNode,
    argumentTypeValue,
    resultTypeNode,
    resultTypeValue,
  };
}

function visitInjectedDualSchemaBuilderCall(
  node: ts.CallExpression,
  argumentTypeNode: ts.TypeNode,
  argumentTypeValue: ts.Type | undefined,
  resultTypeNode: ts.TypeNode,
  resultTypeValue: ts.Type | undefined,
  context: TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  transformation: ts.TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.Node {
  const updated = prependSchemaArguments(
    context,
    node,
    argumentTypeNode,
    argumentTypeValue,
    resultTypeNode,
    resultTypeValue,
    typeRegistry,
    checker,
  );
  registerInjectedCallResultType(
    node,
    updated,
    resultTypeNode,
    resultTypeValue,
    checker,
    typeRegistry,
  );
  // Visit children to catch any pattern calls created by ClosureTransformer
  // inside builder callbacks (e.g., from map transformations)
  return ts.visitEachChild(updated, visit, transformation);
}

function createRegisteredWidenedSchemaCall(
  type: ts.Type,
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.CallExpression {
  const schemaTypeNode = typeToSchemaTypeNode(
    widenLiteralType(type, checker),
    checker,
    context.sourceFile,
  ) ?? context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const schemaCall = createSchemaCallWithRegistryTransfer(
    context,
    schemaTypeNode,
    checker,
    typeRegistry,
    { widenLiterals: true },
  );

  if (typeRegistry) {
    typeRegistry.set(schemaCall, type);
  }

  return schemaCall;
}

function visitPrependedWidenedSchemaCall(
  node: ts.CallExpression,
  args: readonly ts.Expression[],
  schemaTypes: readonly ts.Type[],
  context: TransformationContext,
  visit: (node: ts.Node) => ts.Node,
  transformation: ts.TransformationContext,
  checker: ts.TypeChecker,
  typeRegistry?: TypeRegistry,
): ts.Node {
  const schemas = schemaTypes.map((type) =>
    createRegisteredWidenedSchemaCall(type, context, checker, typeRegistry)
  );

  const updated = context.factory.createCallExpression(
    node.expression,
    undefined,
    [...schemas, ...args],
  );

  return ts.visitEachChild(updated, visit, transformation);
}

function inferLiftFactoryResultType(
  node: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const valueInitializer = getVariableInitializer(node, checker);
  if (!valueInitializer || !ts.isCallExpression(valueInitializer)) {
    return undefined;
  }

  const factoryInitializer = getVariableInitializer(
    valueInitializer.expression,
    checker,
  );
  if (!factoryInitializer || !ts.isCallExpression(factoryInitializer)) {
    return undefined;
  }

  const callKind = detectCallKind(factoryInitializer, checker);
  if (callKind?.kind !== "builder" || callKind.builderName !== "lift") {
    return undefined;
  }

  const callback = factoryInitializer.arguments[0];
  if (!callback || !isFunctionLikeExpression(callback)) {
    return undefined;
  }

  let fallbackArgType: ts.Type | undefined;
  if (factoryInitializer.typeArguments?.length) {
    const [argumentType] = factoryInitializer.typeArguments;
    if (argumentType) {
      fallbackArgType = getTypeFromTypeNodeWithFallback(
        argumentType,
        checker,
        typeRegistry,
      );
    }
  }

  const inferred = collectFunctionSchemaTypeNodes(
    callback,
    checker,
    sourceFile,
    factory,
    fallbackArgType,
    typeRegistry,
    capabilityRegistry,
    "full",
    context,
  );
  const resultType = getTypeFromRegistryOrFallback(
    inferred.result,
    inferred.resultType,
    typeRegistry,
  ) ?? (inferred.result
    ? getTypeFromTypeNodeWithFallback(inferred.result, checker, typeRegistry)
    : undefined);

  if (!resultType || isAnyOrUnknownType(resultType)) {
    return undefined;
  }

  return resultType;
}

function getCallbackReturnExpression(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (ts.isExpression(fn.body)) {
    return fn.body;
  }

  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return statement.expression;
    }
  }

  return undefined;
}

function getDirectProjectionPropertyName(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): string | undefined {
  const parameter = fn.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return undefined;
  }

  const body = getCallbackReturnExpression(fn);
  if (!body) {
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === parameter.name.text
  ) {
    return body.name.text;
  }

  if (
    ts.isElementAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === parameter.name.text &&
    body.argumentExpression &&
    ts.isStringLiteralLike(body.argumentExpression)
  ) {
    return body.argumentExpression.text;
  }

  return undefined;
}

function findTypeLiteralPropertyTypeNode(
  argumentNode: ts.TypeNode,
  propertyName: string,
): ts.TypeNode | undefined {
  if (!ts.isTypeLiteralNode(argumentNode)) {
    return undefined;
  }

  const member = argumentNode.members.find((member) =>
    ts.isPropertySignature(member) &&
    member.type &&
    ((ts.isIdentifier(member.name) && member.name.text === propertyName) ||
      (ts.isStringLiteralLike(member.name) &&
        member.name.text === propertyName))
  );

  if (!member || !ts.isPropertySignature(member) || !member.type) {
    return undefined;
  }

  return member.type;
}

function recoverProjectedResultSchema(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  argumentNode: ts.TypeNode | undefined,
  argumentType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
): { result?: ts.TypeNode; resultType?: ts.Type } | undefined {
  const propertyName = getDirectProjectionPropertyName(fn);
  if (!propertyName) {
    return undefined;
  }

  if (argumentType && !isAnyOrUnknownType(argumentType)) {
    const property = argumentType.getProperty(propertyName);
    if (property) {
      const propertyType = getSymbolTypeAtSource(property, checker, sourceFile);
      if (!isAnyOrUnknownType(propertyType)) {
        const propertyTypeNode = typeToSchemaTypeNode(
          propertyType,
          checker,
          sourceFile,
        );
        if (propertyTypeNode) {
          typeRegistry?.set(propertyTypeNode, propertyType);
          return { result: propertyTypeNode, resultType: propertyType };
        }
      }
    }
  }

  if (!argumentNode) {
    return undefined;
  }

  const propertyTypeNode = findTypeLiteralPropertyTypeNode(
    argumentNode,
    propertyName,
  );
  if (propertyTypeNode) {
    return { result: propertyTypeNode };
  }

  return undefined;
}

function inferDeriveResultTypeFromInitializer(
  node: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const initializer = getVariableInitializer(node, checker);
  if (!initializer || !ts.isCallExpression(initializer)) {
    return undefined;
  }

  const callKind = detectCallKind(initializer, checker);
  if (callKind?.kind !== "derive") {
    return undefined;
  }

  const deriveArgs = getDeriveInputAndCallbackArgument(initializer, checker);
  if (!deriveArgs) {
    return undefined;
  }
  const { input: firstArg, callback } = deriveArgs;

  let argumentType =
    getTypeAtLocationWithFallback(firstArg, checker, typeRegistry) ??
      checker.getTypeAtLocation(firstArg);
  if (isAnyOrUnknownType(argumentType)) {
    const recoveredArgumentType = inferLiftFactoryResultType(
      firstArg,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      capabilityRegistry,
      context,
    );
    if (recoveredArgumentType && !isAnyOrUnknownType(recoveredArgumentType)) {
      argumentType = recoveredArgumentType;
    }
  }

  const inferred = collectFunctionSchemaTypeNodes(
    callback,
    checker,
    sourceFile,
    factory,
    argumentType,
    typeRegistry,
    capabilityRegistry,
    "full",
    context,
  );
  const resultType = getTypeFromRegistryOrFallback(
    inferred.result,
    inferred.resultType,
    typeRegistry,
  ) ?? (inferred.result
    ? getTypeFromTypeNodeWithFallback(inferred.result, checker, typeRegistry)
    : undefined);
  if (resultType && !isAnyOrUnknownType(resultType)) {
    return resultType;
  }

  return undefined;
}

function inferExpressionTypeWithInitializerFallback(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
  context?: TransformationContext,
): ts.Type | undefined {
  const type = getTypeAtLocationWithFallback(expr, checker, typeRegistry) ??
    checker.getTypeAtLocation(expr);
  if (!isAnyOrUnknownType(type)) {
    return type;
  }

  const fromLift = inferLiftFactoryResultType(
    expr,
    checker,
    sourceFile,
    factory,
    typeRegistry,
    capabilityRegistry,
    context,
  );
  if (fromLift && !isAnyOrUnknownType(fromLift)) {
    return fromLift;
  }

  const fromDerive = inferDeriveResultTypeFromInitializer(
    expr,
    checker,
    sourceFile,
    factory,
    typeRegistry,
    capabilityRegistry,
    context,
  );
  if (fromDerive && !isAnyOrUnknownType(fromDerive)) {
    return fromDerive;
  }

  return type;
}

function buildObjectLiteralReturnTypeNode(
  expr: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
  context?: TransformationContext,
): ts.TypeNode | undefined {
  const members: ts.TypeElement[] = [];

  for (const property of expr.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return undefined;
    }

    const valueExpr = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    const valueType = inferExpressionTypeWithInitializerFallback(
      valueExpr,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      capabilityRegistry,
      context,
    );
    if (!valueType || isAnyOrUnknownType(valueType)) {
      return undefined;
    }

    const valueTypeNode = typeToSchemaTypeNode(valueType, checker, sourceFile);
    if (!valueTypeNode) {
      return undefined;
    }
    typeRegistry?.set(valueTypeNode, valueType);

    members.push(
      factory.createPropertySignature(
        undefined,
        property.name,
        undefined,
        valueTypeNode,
      ),
    );
  }

  return createRegisteredTypeLiteral(
    members,
    { factory, checker, typeRegistry },
  );
}

/**
 * Determines the appropriate schema TypeNode for a function parameter based on
 * whether it exists and whether it has explicit type annotation.
 *
 * Rules:
 * - No parameter → never (schema: false)
 * - Parameter with _ prefix and no type → never (schema: false)
 * - Parameter with explicit type → use that type
 * - Parameter without type → unknown (schema: true)
 */
function getParameterSchemaType(
  factory: ts.NodeFactory,
  param: ts.ParameterDeclaration | undefined,
): ts.TypeNode {
  // No parameter at all → never
  if (!param) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type → use it
  if (param.type) {
    return param.type;
  }

  // Check if parameter name starts with _ (unused convention)
  if (isIntentionallyUnusedSchemaParameter(param)) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Parameter exists without type → unknown
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

/**
 * Infer schema type for a specific parameter, respecting underscore-prefix convention
 * and attempting type inference before falling back to never/unknown.
 */
function inferParameterSchemaType(
  factory: ts.NodeFactory,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  paramIndex: number,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.TypeNode {
  const param = fn.parameters[paramIndex];

  // Check underscore prefix first
  if (isIntentionallyUnusedSchemaParameter(param)) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type annotation - use it
  if (param?.type) {
    return param.type;
  }

  // Try to infer from signature
  if (param) {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (signature && signature.parameters.length > paramIndex) {
      const paramSymbol = signature.parameters[paramIndex];
      if (paramSymbol) {
        const paramType = checker.getTypeOfSymbol(paramSymbol);
        if (paramType && !isAnyOrUnknownType(paramType)) {
          const typeNode = typeToSchemaTypeNode(paramType, checker, sourceFile);
          if (typeNode) {
            return typeNode;
          }
        }
      }
    }
    // Inference failed - use unknown
    return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  // No parameter at all - use never
  return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
}

function isIntentionallyUnusedSchemaParameter(
  param: ts.ParameterDeclaration | undefined,
): boolean {
  if (!param || !ts.isIdentifier(param.name)) {
    return false;
  }

  const name = param.name.text;
  if (!name.startsWith("_")) {
    return false;
  }

  // Synthetic CTS parameters use internal "__ct_*" and "__param*" prefixes.
  // They still carry meaningful structural types and must not collapse to
  // never/false just because they start with underscores.
  if (name.startsWith("__ct_") || name.startsWith("__param")) {
    return false;
  }

  return true;
}

function prependSchemaArguments(
  context: Pick<TransformationContext, "factory" | "ctHelpers" | "sourceFile">,
  node: ts.CallExpression,
  argumentTypeNode: ts.TypeNode,
  argumentType: ts.Type | undefined,
  resultTypeNode: ts.TypeNode,
  resultType: ts.Type | undefined,
  typeRegistry?: TypeRegistry,
  checker?: ts.TypeChecker,
): ts.CallExpression {
  const argSchemaCall = checker
    ? createSchemaCallWithRegistryTransfer(
      context,
      argumentTypeNode,
      checker,
      typeRegistry,
    )
    : createToSchemaCall(context, argumentTypeNode);
  const resSchemaCall = checker
    ? createSchemaCallWithRegistryTransfer(
      context,
      resultTypeNode,
      checker,
      typeRegistry,
    )
    : createToSchemaCall(context, resultTypeNode);

  // Register Types if they were inferred (not from original source)
  if (typeRegistry && checker) {
    if (argumentType && !isUnresolvedSchemaType(argumentType)) {
      typeRegistry.set(argSchemaCall, argumentType);
    }
    if (resultType && !isUnresolvedSchemaType(resultType)) {
      typeRegistry.set(resSchemaCall, resultType);
    }
  }

  return context.factory.createCallExpression(
    node.expression,
    undefined,
    [argSchemaCall, resSchemaCall, ...node.arguments],
  );
}

/**
 * Helper to find the function argument in a builder call (pattern).
 * Searches from the end of the arguments array for the first function-like expression.
 */
function findFunctionArgument(
  argsArray: readonly ts.Expression[],
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = argsArray.length - 1; i >= 0; i--) {
    const arg = argsArray[i];
    if (
      arg &&
      (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg))
    ) {
      return arg;
    }
  }
  return undefined;
}

/**
 * Helper to detect and collect schema arguments (non-function, non-string expressions).
 * Returns an array of schema expressions found in the arguments.
 */
function detectSchemaArguments(
  argsArray: readonly ts.Expression[],
  functionArg: ts.Expression,
): ts.Expression[] {
  const schemas: ts.Expression[] = [];
  for (const arg of argsArray) {
    if (
      arg &&
      arg !== functionArg &&
      !ts.isStringLiteral(arg) &&
      !ts.isNoSubstitutionTemplateLiteral(arg)
    ) {
      schemas.push(arg);
    }
  }
  return schemas;
}

function unwrapParenthesizedTypeNode(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function isTopLevelAnyOrUnknownTypeNode(
  node: ts.TypeNode | undefined,
): boolean {
  if (!node) return false;
  const current = unwrapParenthesizedTypeNode(node);
  return current.kind === ts.SyntaxKind.AnyKeyword ||
    current.kind === ts.SyntaxKind.UnknownKeyword;
}

function shouldReportPermissiveInferredPatternResult(
  resultNode: ts.TypeNode | undefined,
  resultType: ts.Type | undefined,
): boolean {
  if (!resultNode) return true;
  if (isTopLevelAnyOrUnknownTypeNode(resultNode)) return true;
  return isAnyOrUnknownType(resultType);
}

/**
 * Handler for pattern schema injection.
 * Argument order is function-first: [function, inputSchema, resultSchema]
 *
 * @returns The transformed node, or undefined if no transformation was performed
 */

function reportAnyResultSchema(
  context: TransformationContext,
  node: ts.CallExpression,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern:any-result-schema",
    message:
      `pattern() inferred result schema resolves to 'any' or 'unknown'. ` +
      `CTS only allows permissive output schemas when made explicit. ` +
      `Add an explicit Output type parameter: pattern<Input, Output>(...).`,
    node: node.expression,
  });
}

function isMapWithPatternCallbackPatternCall(node: ts.CallExpression): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  if (parent.arguments[0] !== node) {
    return false;
  }
  const arrayMethodInfo = classifyArrayMethodCall(parent);
  return !!arrayMethodInfo &&
    arrayMethodInfo.lowered &&
    arrayMethodInfo.family === "map";
}

function handlePatternSchemaInjection(
  node: ts.CallExpression,
  context: TransformationContext,
  typeRegistry: TypeRegistry | undefined,
  visit: (node: ts.Node) => ts.Node,
): ts.Node | undefined {
  const { factory, checker, sourceFile, tsContext: transformation } = context;
  const typeArgs = node.typeArguments;
  const capabilityRegistry = context.options.capabilitySummaryRegistry;
  const argsArray = Array.from(node.arguments);

  // Find the function argument
  const builderFunction = findFunctionArgument(argsArray);
  if (!builderFunction) {
    return undefined; // No function found - skip transformation
  }

  const argumentCapabilityMode: CapabilitySummaryApplicationMode =
    context.isArrayMethodCallback(builderFunction) ||
      isMapWithPatternCallbackPatternCall(node)
      ? "full"
      : "defaults_only";

  // Helper to build final call with function-first argument order
  const buildCallExpression = (
    inputSchema: ts.Expression,
    resultSchema: ts.Expression,
  ): ts.CallExpression => {
    return factory.createCallExpression(node.expression, undefined, [
      builderFunction,
      inputSchema,
      resultSchema,
    ]);
  };

  // Determine input and result schema TypeNodes based on type arguments
  let inputTypeNode: ts.TypeNode;
  let inputType: ts.Type | undefined;
  let resultTypeNode: ts.TypeNode;
  let resultType: ts.Type | undefined;

  if (typeArgs && typeArgs.length >= 2) {
    // Case 1: Two or more type arguments → both schemas from type args
    inputTypeNode = typeArgs[0]!;
    resultTypeNode = typeArgs[1]!;

    // Check TypeRegistry for closure-captured types
    if (typeRegistry) {
      inputType = typeRegistry.get(inputTypeNode);
      resultType = typeRegistry.get(resultTypeNode);
    }
    inputType ??= getTypeFromTypeNodeWithFallback(
      inputTypeNode,
      checker,
      typeRegistry,
    );
    resultType ??= getTypeFromTypeNodeWithFallback(
      resultTypeNode,
      checker,
      typeRegistry,
    );
  } else if (typeArgs && typeArgs.length === 1) {
    // Case 2: One type argument → input from type arg, result inferred
    inputTypeNode = typeArgs[0]!;

    // Check TypeRegistry for input type
    if (typeRegistry) {
      inputType = typeRegistry.get(inputTypeNode);
    }
    inputType ??= getTypeFromTypeNodeWithFallback(
      inputTypeNode,
      checker,
      typeRegistry,
    );

    // Infer result type from function
    const inferred = collectFunctionSchemaTypeNodes(
      builderFunction,
      checker,
      sourceFile,
      factory,
      undefined,
      typeRegistry,
      capabilityRegistry,
      argumentCapabilityMode,
      context,
    );
    if (
      shouldReportPermissiveInferredPatternResult(
        inferred.result,
        inferred.resultType,
      )
    ) {
      reportAnyResultSchema(context, node);
    }
    resultTypeNode = inferred.result ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    resultType = getTypeFromRegistryOrFallback(
      resultTypeNode,
      inferred.resultType,
      typeRegistry,
    );
  } else {
    // Case 3: No type arguments - check for schema arguments
    const schemaArgs = detectSchemaArguments(argsArray, builderFunction);

    if (schemaArgs.length >= 2) {
      // Already has two schemas (input + result) - skip transformation
      return undefined;
    } else if (schemaArgs.length === 1) {
      // Case 3a: Has one schema argument but no type args
      // Use existing schema as input, infer result from function
      const existingInputSchema = schemaArgs[0]!;

      // Infer result type from function
      const inferred = collectFunctionSchemaTypeNodes(
        builderFunction,
        checker,
        sourceFile,
        factory,
        undefined,
        typeRegistry,
        capabilityRegistry,
        argumentCapabilityMode,
        context,
      );
      if (
        shouldReportPermissiveInferredPatternResult(
          inferred.result,
          inferred.resultType,
        )
      ) {
        reportAnyResultSchema(context, node);
      }
      resultTypeNode = inferred.result ??
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      resultType = getTypeFromRegistryOrFallback(
        resultTypeNode,
        inferred.resultType,
        typeRegistry,
      );

      // Use existing schema directly as input, create result schema from type
      const toSchemaResult = createToSchemaCall(context, resultTypeNode);
      if (resultType && typeRegistry) {
        typeRegistry.set(toSchemaResult, resultType);
      }

      const updated = buildCallExpression(existingInputSchema, toSchemaResult);
      return ts.visitEachChild(updated, visit, transformation);
    } else {
      // Case 3b: No type arguments, no schema args → infer both from function
      const inputParam = builderFunction.parameters[0];
      const inferred = collectFunctionSchemaTypeNodes(
        builderFunction,
        checker,
        sourceFile,
        factory,
        undefined,
        typeRegistry,
        capabilityRegistry,
        argumentCapabilityMode,
        context,
      );
      if (
        shouldReportPermissiveInferredPatternResult(
          inferred.result,
          inferred.resultType,
        )
      ) {
        reportAnyResultSchema(context, node);
      }

      inputTypeNode = inferred.argument ??
        getParameterSchemaType(factory, inputParam);
      inputType = getTypeFromRegistryOrFallback(
        inputTypeNode,
        inferred.argumentType,
        typeRegistry,
      );

      resultTypeNode = inferred.result ??
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      resultType = getTypeFromRegistryOrFallback(
        resultTypeNode,
        inferred.resultType,
        typeRegistry,
      );
    }
  }

  const originalInputTypeNode = inputTypeNode;
  inputTypeNode = applyCapabilitySummaryToArgument(
    builderFunction,
    inputTypeNode,
    inputType,
    checker,
    sourceFile,
    factory,
    capabilityRegistry,
    argumentCapabilityMode,
    context,
    builderFunction,
  ) ?? inputTypeNode;
  if (inputTypeNode !== originalInputTypeNode) {
    // Capability lowering produced a synthetic wrapped/shrunk node.
    // Avoid reusing stale type references from the pre-shrunk node.
    inputType = undefined;
  }

  // Create both schemas
  const inputSchemaCall = createToSchemaCall(context, inputTypeNode);
  if (inputType && typeRegistry) {
    typeRegistry.set(inputSchemaCall, inputType);
  }

  const resultSchemaCall = createToSchemaCall(context, resultTypeNode);
  if (resultType && typeRegistry) {
    typeRegistry.set(resultSchemaCall, resultType);
  }

  const updated = buildCallExpression(inputSchemaCall, resultSchemaCall);
  return ts.visitEachChild(updated, visit, transformation);
}

export class SchemaInjectionTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, tsContext: transformation, checker } = context;
    const typeRegistry = context.options.typeRegistry;
    const capabilityRegistry = context.options.capabilitySummaryRegistry;

    const visit = (node: ts.Node): ts.Node => {
      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visit, transformation);
      }

      const callKind = detectCallKind(node, checker);

      if (callKind?.kind === "builder" && callKind.builderName === "pattern") {
        const result = handlePatternSchemaInjection(
          node,
          context,
          typeRegistry,
          visit,
        );
        if (result) return result;
        return ts.visitEachChild(node, visit, transformation);
      }

      if (
        callKind?.kind === "builder" && callKind.builderName === "handler"
      ) {
        const factory = transformation.factory;

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const eventType = node.typeArguments[0];
          const stateType = node.typeArguments[1];
          if (!eventType || !stateType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          let eventTypeNode: ts.TypeNode = eventType;
          let stateTypeNode: ts.TypeNode = stateType;
          const handlerCandidate = node.arguments[0];
          if (
            handlerCandidate &&
            (ts.isFunctionExpression(handlerCandidate) ||
              ts.isArrowFunction(handlerCandidate))
          ) {
            const handlerFn = handlerCandidate;
            const eventTypeValue = getTypeFromTypeNodeWithFallback(
              eventType,
              checker,
              typeRegistry,
            );
            const stateTypeValue = getTypeFromTypeNodeWithFallback(
              stateType,
              checker,
              typeRegistry,
            );

            eventTypeNode = applyCapabilitySummaryToParameter(
              handlerFn,
              0,
              eventType,
              eventTypeValue,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
              context,
              handlerFn,
            ) ?? eventType;

            stateTypeNode = applyCapabilitySummaryToParameter(
              handlerFn,
              1,
              stateType,
              stateTypeValue,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
              context,
              handlerFn,
            ) ?? stateType;
          }

          const toSchemaEvent = createSchemaCallWithRegistryTransfer(
            context,
            eventTypeNode,
            checker,
            typeRegistry,
          );
          const toSchemaState = createSchemaCallWithRegistryTransfer(
            context,
            stateTypeNode,
            checker,
            typeRegistry,
          );

          const updated = factory.createCallExpression(
            node.expression,
            undefined,
            [toSchemaEvent, toSchemaState, ...node.arguments],
          );

          return ts.visitEachChild(updated, visit, transformation);
        }

        if (node.arguments.length === 1) {
          const handlerCandidate = node.arguments[0];
          if (
            handlerCandidate &&
            (ts.isFunctionExpression(handlerCandidate) ||
              ts.isArrowFunction(handlerCandidate))
          ) {
            const handlerFn = handlerCandidate;

            // Infer types from the handler function for both parameters
            const inferred = collectFunctionSchemaTypeNodes(
              handlerFn,
              checker,
              sourceFile,
              factory,
              undefined,
              typeRegistry,
              capabilityRegistry,
              "full",
              context,
            );

            // Event type: use inferred or fallback to never/unknown refinement.
            // Validation already ran inside collectFunctionSchemaTypeNodes (via
            // applyCapabilitySummaryToArgument), so don't pass `context` here
            // to avoid double-validation with degraded type info (the shrunk
            // node is synthetic and the recovered argumentType may be undefined).
            const eventTypeBase = inferred.argument ??
              getParameterSchemaType(factory, handlerFn.parameters[0]);
            const eventType = applyCapabilitySummaryToParameter(
              handlerFn,
              0,
              eventTypeBase,
              inferred.argumentType,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
              undefined,
              handlerFn,
            ) ?? eventTypeBase;

            // State type: use helper for second parameter
            const stateTypeBase = inferParameterSchemaType(
              factory,
              handlerFn,
              1, // second parameter
              checker,
              sourceFile,
            );
            const stateParam = handlerFn.parameters[1];
            const stateTypeValue = stateParam
              ? checker.getTypeAtLocation(stateParam)
              : undefined;
            const stateType = applyCapabilitySummaryToParameter(
              handlerFn,
              1,
              stateTypeBase,
              stateTypeValue,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
              context,
              handlerFn,
            ) ?? stateTypeBase;

            // Always transform - generate schemas regardless of parameter presence
            const toSchemaEvent = createSchemaCallWithRegistryTransfer(
              context,
              eventType,
              checker,
              typeRegistry,
            );
            const toSchemaState = createSchemaCallWithRegistryTransfer(
              context,
              stateType,
              checker,
              typeRegistry,
            );

            const updated = factory.createCallExpression(
              node.expression,
              undefined,
              [toSchemaEvent, toSchemaState, handlerFn],
            );

            return ts.visitEachChild(updated, visit, transformation);
          }
        }
      }

      if (callKind?.kind === "derive") {
        const factory = transformation.factory;
        const deriveArgs = getDeriveInputAndCallbackArgument(node, checker);

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const resolved = resolveDualSchemaBuilderTypes(
            deriveArgs?.callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            capabilityRegistry,
            context,
            {
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry?.get(argumentType),
              explicitResultTypeNode: resultType,
              explicitResultTypeValue: typeRegistry?.get(resultType),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (deriveArgs) {
          const { input: firstArg, callback } = deriveArgs;

          // Special case: detect empty object literal {} and generate specific schema
          let argNode: ts.TypeNode | undefined;
          let argType: ts.Type | undefined;
          let fallbackArgType: ts.Type | undefined;

          if (
            ts.isObjectLiteralExpression(firstArg) &&
            firstArg.properties.length === 0
          ) {
            // Empty object literal - create a specific type for it
            // This should generate {type: "unknown"}
            argNode = factory.createTypeLiteralNode([]);
            ensureTypeNodeRegistered(argNode, checker, typeRegistry);
            // Don't set argType - let schema generator handle the synthetic node
          } else {
            // Normal case - infer from the argument type
            // Apply literal widening so `const x = 5; derive(x, fn)` produces `number`, not `5`
            // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., mapWithPattern calls)
            // which have their types registered in the typeRegistry by ClosureTransformer
            fallbackArgType = widenLiteralType(
              getTypeAtLocationWithFallback(firstArg, checker, typeRegistry) ??
                checker.getTypeAtLocation(firstArg),
              checker,
            );
            if (isAnyOrUnknownType(fallbackArgType)) {
              const recoveredArgumentType = inferLiftFactoryResultType(
                firstArg,
                checker,
                sourceFile,
                factory,
                typeRegistry,
                capabilityRegistry,
                context,
              );
              if (
                recoveredArgumentType &&
                !isAnyOrUnknownType(recoveredArgumentType)
              ) {
                fallbackArgType = recoveredArgumentType;
              }
            }
          }

          const resolved = resolveDualSchemaBuilderTypes(
            callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            capabilityRegistry,
            context,
            {
              fallbackArgumentType: fallbackArgType,
              explicitArgumentTypeNode: argNode,
              explicitArgumentTypeValue: argType,
              fallbackArgumentNode: getParameterSchemaType(
                factory,
                callback.parameters[0],
              ),
              applyExplicitArgumentCapabilitySummary: false,
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }
      }

      if (callKind?.kind === "builder" && callKind.builderName === "lift") {
        const factory = transformation.factory;

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const liftCallback = isFunctionLikeExpression(node.arguments[0]!)
            ? node.arguments[0]!
            : undefined;
          const resolved = resolveDualSchemaBuilderTypes(
            liftCallback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            capabilityRegistry,
            context,
            {
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry?.get(argumentType),
              explicitResultTypeNode: resultType,
              explicitResultTypeValue: typeRegistry?.get(resultType),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (node.typeArguments && node.typeArguments.length === 1) {
          const [argumentType] = node.typeArguments;
          if (!argumentType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const liftCallback = node.arguments[0];
          if (
            !liftCallback ||
            (!ts.isArrowFunction(liftCallback) &&
              !ts.isFunctionExpression(liftCallback))
          ) {
            return ts.visitEachChild(node, visit, transformation);
          }

          const resolved = resolveDualSchemaBuilderTypes(
            liftCallback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            capabilityRegistry,
            context,
            {
              fallbackArgumentType: getTypeFromTypeNodeWithFallback(
                argumentType,
                checker,
                typeRegistry,
              ),
              explicitArgumentTypeNode: argumentType,
              explicitArgumentTypeValue: typeRegistry?.get(argumentType),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }

        if (
          node.arguments.length === 1 &&
          isFunctionLikeExpression(node.arguments[0]!)
        ) {
          const callback = node.arguments[0] as
            | ts.ArrowFunction
            | ts.FunctionExpression;
          const resolved = resolveDualSchemaBuilderTypes(
            callback,
            checker,
            sourceFile,
            factory,
            typeRegistry,
            capabilityRegistry,
            context,
            {
              fallbackArgumentNode: getParameterSchemaType(
                factory,
                callback.parameters[0],
              ),
            },
          );
          if (!resolved) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Always transform with both schemas
          return visitInjectedDualSchemaBuilderCall(
            node,
            resolved.argumentTypeNode,
            resolved.argumentTypeValue,
            resolved.resultTypeNode,
            resolved.resultTypeValue,
            context,
            visit,
            transformation,
            checker,
            typeRegistry,
          );
        }
      }

      if (callKind?.kind === "cell-factory") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        // If already has 2 arguments, assume schema is already present
        if (args.length >= 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          () => {
            const valueArg = args[0];
            if (!valueArg) {
              return undefined;
            }
            const valueType = inferExpressionTypeWithInitializerFallback(
              valueArg,
              checker,
              sourceFile,
              factory,
              typeRegistry,
              capabilityRegistry,
              context,
            );
            return valueType && !isUnresolvedSchemaType(valueType)
              ? widenLiteralType(valueType, checker)
              : valueType;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
          resolved.inferred ? { widenLiterals: true } : undefined,
        );

        if (schemaCall) {
          // Schema must always be the second argument. If no value was provided,
          // add undefined as the first argument.
          const newArgs = args.length === 0
            ? [factory.createIdentifier("undefined"), schemaCall]
            : [...args, schemaCall];

          const updated = factory.createCallExpression(
            node.expression,
            node.typeArguments,
            newArgs,
          );
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      if (callKind?.kind === "cell-for") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;

        // Check if already wrapped in asSchema
        if (
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name.text === "asSchema"
        ) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          () => {
            const contextualType = inferSchemaContextualType(node, checker);
            return contextualType
              ? unwrapOpaqueLikeType(contextualType, checker)
              : undefined;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          // Visit the original node's children first to ensure nested transformations happen
          const visitedNode = ts.visitEachChild(node, visit, transformation);

          const asSchema = factory.createPropertyAccessExpression(
            visitedNode,
            factory.createIdentifier("asSchema"),
          );
          const updated = factory.createCallExpression(
            asSchema,
            undefined,
            [schemaCall],
          );
          // Return updated directly to avoid re-visiting the inner CallExpression which would trigger infinite recursion
          return updated;
        }
      }

      if (callKind?.kind === "wish") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        if (args.length >= 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          () => inferSchemaContextualType(node, checker),
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          const updated = factory.createCallExpression(
            node.expression,
            node.typeArguments,
            [...args, schemaCall],
          );
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      if (callKind?.kind === "generate-object") {
        const factory = transformation.factory;
        const typeArgs = node.typeArguments;
        const args = node.arguments;

        // Check if schema is already present in options
        if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
          const props = (args[0] as ts.ObjectLiteralExpression).properties;
          if (
            props.some((p: ts.ObjectLiteralElementLike) =>
              p.name && ts.isIdentifier(p.name) && p.name.text === "schema"
            )
          ) {
            return ts.visitEachChild(node, visit, transformation);
          }
        }

        const resolved = resolveInjectableSchemaType(
          typeArgs?.[0],
          checker,
          sourceFile,
          factory,
          typeRegistry,
          () => {
            const contextualType = inferSchemaContextualType(node, checker);
            const objectProp = contextualType?.getProperty("object");
            return objectProp
              ? checker.getTypeOfSymbolAtLocation(objectProp, node)
              : undefined;
          },
        );

        const schemaCall = createRegisteredSchemaCallFromResolvedType(
          context,
          resolved,
          checker,
          typeRegistry,
        );

        if (schemaCall) {
          let newOptions: ts.Expression;
          if (args.length > 0 && ts.isObjectLiteralExpression(args[0]!)) {
            // Add schema property to existing object literal
            newOptions = factory.createObjectLiteralExpression(
              [
                ...(args[0] as ts.ObjectLiteralExpression).properties,
                factory.createPropertyAssignment("schema", schemaCall),
              ],
              true,
            );
          } else if (args.length > 0) {
            // Options is an expression (not literal) -> { ...opts, schema: ... }
            newOptions = factory.createObjectLiteralExpression(
              [
                factory.createSpreadAssignment(args[0]!),
                factory.createPropertyAssignment("schema", schemaCall),
              ],
              true,
            );
          } else {
            // No options -> { schema: ... }
            newOptions = factory.createObjectLiteralExpression(
              [factory.createPropertyAssignment("schema", schemaCall)],
              true,
            );
          }

          const updated = factory.createCallExpression(
            node.expression,
            node.typeArguments,
            [newOptions, ...args.slice(1)],
          );
          return ts.visitEachChild(updated, visit, transformation);
        }
      }

      // Handler for when(condition, value) - prepends 3 schemas (condition, value, result)
      if (callKind?.kind === "when") {
        const args = node.arguments;

        // Skip if already has schemas (5+ args means schemas present)
        if (args.length >= 5) {
          return ts.visitEachChild(node, visit, transformation);
        }

        // Must have exactly 2 arguments: condition, value
        if (args.length !== 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const [conditionExpr, valueExpr] = args;

        // Infer types for each argument
        // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., derive calls)
        // which have their types registered in the typeRegistry
        const conditionType = getTypeAtLocationWithFallback(
          conditionExpr!,
          checker,
          typeRegistry,
        ) ??
          checker.getTypeAtLocation(conditionExpr!);
        const valueType =
          getTypeAtLocationWithFallback(valueExpr!, checker, typeRegistry) ??
            checker.getTypeAtLocation(valueExpr!);

        // Get the result type from TypeScript's inferred return type of the call
        // This will be the union type (e.g., boolean | string for when(enabled, message))
        const resultType =
          getTypeAtLocationWithFallback(node, checker, typeRegistry) ??
            checker.getTypeAtLocation(node);

        return visitPrependedWidenedSchemaCall(
          node,
          args,
          [conditionType, valueType, resultType],
          context,
          visit,
          transformation,
          checker,
          typeRegistry,
        );
      }

      // Handler for unless(condition, fallback) - prepends 3 schemas (condition, fallback, result)
      if (callKind?.kind === "unless") {
        const args = node.arguments;

        // Skip if already has schemas (5+ args means schemas present)
        if (args.length >= 5) {
          return ts.visitEachChild(node, visit, transformation);
        }

        // Must have exactly 2 arguments: condition, fallback
        if (args.length !== 2) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const [conditionExpr, fallbackExpr] = args;

        // Infer types for each argument
        // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., derive calls)
        // which have their types registered in the typeRegistry
        const conditionType = getTypeAtLocationWithFallback(
          conditionExpr!,
          checker,
          typeRegistry,
        ) ??
          checker.getTypeAtLocation(conditionExpr!);
        const fallbackType =
          getTypeAtLocationWithFallback(fallbackExpr!, checker, typeRegistry) ??
            checker.getTypeAtLocation(fallbackExpr!);

        // Get the result type from TypeScript's inferred return type of the call
        // This will be the union type (e.g., boolean | string for unless(enabled, fallback))
        const resultType =
          getTypeAtLocationWithFallback(node, checker, typeRegistry) ??
            checker.getTypeAtLocation(node);

        return visitPrependedWidenedSchemaCall(
          node,
          args,
          [conditionType, fallbackType, resultType],
          context,
          visit,
          transformation,
          checker,
          typeRegistry,
        );
      }

      // Handler for ifElse(condition, ifTrue, ifFalse) - prepends 4 schemas (condition, ifTrue, ifFalse, result)
      if (callKind?.kind === "ifElse") {
        const args = node.arguments;

        // Skip if already has schemas (7+ args means schemas present)
        if (args.length >= 7) {
          return ts.visitEachChild(node, visit, transformation);
        }

        // Must have exactly 3 arguments: condition, ifTrue, ifFalse
        if (args.length !== 3) {
          return ts.visitEachChild(node, visit, transformation);
        }

        const [conditionExpr, ifTrueExpr, ifFalseExpr] = args;

        // Infer types for each argument
        // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., derive calls)
        // which have their types registered in the typeRegistry
        const conditionType = getTypeAtLocationWithFallback(
          conditionExpr!,
          checker,
          typeRegistry,
        ) ??
          checker.getTypeAtLocation(conditionExpr!);
        const ifTrueType =
          getTypeAtLocationWithFallback(ifTrueExpr!, checker, typeRegistry) ??
            checker.getTypeAtLocation(ifTrueExpr!);
        const ifFalseType =
          getTypeAtLocationWithFallback(ifFalseExpr!, checker, typeRegistry) ??
            checker.getTypeAtLocation(ifFalseExpr!);

        // Get the result type from TypeScript's inferred return type of the call
        // This will be the union type (e.g., string | number for ifElse(cond, str, num))
        const resultType =
          getTypeAtLocationWithFallback(node, checker, typeRegistry) ??
            checker.getTypeAtLocation(node);

        return visitPrependedWidenedSchemaCall(
          node,
          args,
          [conditionType, ifTrueType, ifFalseType, resultType],
          context,
          visit,
          transformation,
          checker,
          typeRegistry,
        );
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitEachChild(sourceFile, visit, transformation);
  }
}
