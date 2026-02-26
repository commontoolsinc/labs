import ts from "typescript";

import {
  detectCallKind,
  getTypeAtLocationWithFallback,
  getTypeFromTypeNodeWithFallback,
  getTypeReferenceArgument,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  isAnyOrUnknownType,
  isFunctionLikeExpression,
  typeToSchemaTypeNode,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "../ast/mod.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import {
  type CapabilityParamSummary,
  type CapabilitySummaryRegistry,
  type ReactiveCapability,
  TransformationContext,
  Transformer,
  type TypeRegistry,
} from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";

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

function uniquePaths(
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const path of paths) {
    const key = path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function groupPathsByHead(
  paths: readonly (readonly string[])[],
): Map<string, readonly (readonly string[])[]> {
  const grouped = new Map<string, (readonly string[])[]>();
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...tail] = path;
    if (!head) continue;
    const existing = grouped.get(head);
    if (existing) {
      existing.push(tail);
    } else {
      grouped.set(head, [tail]);
    }
  }
  return grouped;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const union = type as ts.UnionType;
    return union.types.some((member) => typeIncludesUndefined(member));
  }
  return false;
}

function typeNodeIncludesUndefined(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.some((member) => typeNodeIncludesUndefined(member));
  }
  return false;
}

function buildShrunkTypeNodeFromType(
  type: ts.Type,
  paths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.TypeNode | undefined {
  const normalized = uniquePaths(paths);
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.some((path) => path.length === 0)) {
    return checker.typeToTypeNode(
      type,
      sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseStructuralFallback,
    ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  const grouped = groupPathsByHead(normalized);
  const properties: ts.TypeElement[] = [];

  for (const [head, childPaths] of grouped) {
    let propType: ts.Type | undefined;
    let isOptional = false;

    const prop = type.getProperty(head);
    if (prop) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ??
        sourceFile;
      propType = checker.getTypeOfSymbolAtLocation(prop, declaration);
      isOptional = !!(prop.flags & ts.SymbolFlags.Optional) ||
        (propType ? typeIncludesUndefined(propType) : false);
    } else {
      // Numeric/unknown-key accesses can be represented via index signatures
      // rather than named properties. Use the index type when available.
      const numericIndex = Number.isFinite(Number(head));
      const indexType = checker.getIndexTypeOfType(
        type,
        numericIndex ? ts.IndexKind.Number : ts.IndexKind.String,
      ) ?? checker.getIndexTypeOfType(type, ts.IndexKind.String);
      if (!indexType) continue;
      propType = indexType;
      isOptional = typeIncludesUndefined(indexType);
    }

    if (!propType || isAnyOrUnknownType(propType)) {
      // Preserve the original node-based type when type-based fallback
      // cannot provide concrete property shape.
      continue;
    }

    const propTypeNode = buildShrunkTypeNodeFromType(
      propType,
      childPaths,
      checker,
      sourceFile,
      factory,
    ) ?? checker.typeToTypeNode(
      propType,
      sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseStructuralFallback,
    ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(head, factory),
        isOptional
          ? factory.createToken(ts.SyntaxKind.QuestionToken)
          : undefined,
        propTypeNode,
      ),
    );
  }

  if (properties.length === 0) {
    return undefined;
  }

  return factory.createTypeLiteralNode(properties);
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function buildShrunkTypeNodeFromTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
): ts.TypeNode | undefined {
  const normalized = uniquePaths(paths);
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.some((path) => path.length === 0)) {
    return node;
  }

  if (ts.isTypeLiteralNode(node)) {
    const grouped = groupPathsByHead(normalized);
    const members: ts.TypeElement[] = [];

    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name || !member.type) {
        continue;
      }

      const propertyName = getPropertyNameText(member.name);
      if (!propertyName) continue;
      const childPaths = grouped.get(propertyName);
      if (!childPaths) continue;

      const shrunkChild = buildShrunkTypeNodeFromTypeNode(
        member.type,
        childPaths,
        factory,
      ) ?? member.type;

      members.push(
        factory.updatePropertySignature(
          member,
          member.modifiers,
          member.name,
          member.questionToken ??
            (typeNodeIncludesUndefined(shrunkChild)
              ? factory.createToken(ts.SyntaxKind.QuestionToken)
              : undefined),
          shrunkChild,
        ),
      );
    }

    if (members.length === 0) {
      return undefined;
    }
    return factory.createTypeLiteralNode(members);
  }

  if (
    ts.isTypeReferenceNode(node) &&
    isCellLikeTypeNode(node) &&
    node.typeArguments &&
    node.typeArguments.length > 0
  ) {
    const [inner, ...rest] = node.typeArguments;
    if (!inner) return undefined;
    const shrunkInner = buildShrunkTypeNodeFromTypeNode(
      inner,
      normalized,
      factory,
    ) ?? inner;
    return factory.updateTypeReferenceNode(
      node,
      node.typeName,
      factory.createNodeArray([shrunkInner, ...rest]),
    );
  }

  return node;
}

function printTypeNode(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
): string {
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

function normalizeTypeNodeText(text: string): string {
  return text.replace(/\s+/g, "");
}

function wrapTypeNodeWithCapability(
  node: ts.TypeNode,
  capability: ReactiveCapability,
  factory: ts.NodeFactory,
): ts.TypeNode {
  const wrapperName = capability === "readonly"
    ? "ReadonlyCell"
    : capability === "writeonly"
    ? "WriteonlyCell"
    : capability === "writable"
    ? "Writable"
    : "OpaqueCell";

  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__ctHelpers"),
      factory.createIdentifier(wrapperName),
    ),
    [node],
  );
}

function isCellLikeTypeNode(node: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(node)) return false;
  const name = ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : ts.isQualifiedName(node.typeName)
    ? node.typeName.right.text
    : undefined;
  if (!name) return false;
  return name === "Cell" ||
    name === "Writable" ||
    name === "OpaqueCell" ||
    name === "OpaqueRef" ||
    name === "ReadonlyCell" ||
    name === "WriteonlyCell" ||
    name === "Stream";
}

function extractCellLikeInnerTypeNode(
  node: ts.TypeNode,
): ts.TypeNode | undefined {
  if (!isCellLikeTypeNode(node)) return undefined;
  if (!ts.isTypeReferenceNode(node)) return undefined;
  if (!node.typeArguments || node.typeArguments.length === 0) return undefined;
  return node.typeArguments[0];
}

function unwrapCellLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!type) return undefined;
  const opaqueUnwrapped = unwrapOpaqueLikeType(type, checker);
  if (opaqueUnwrapped && opaqueUnwrapped !== type) {
    return opaqueUnwrapped;
  }
  return getTypeReferenceArgument(type) ?? type;
}

function findCapabilitySummaryForParameter(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  index: number,
  capabilityRegistry?: CapabilitySummaryRegistry,
): CapabilityParamSummary | undefined {
  if (!capabilityRegistry) return undefined;
  const summary = capabilityRegistry?.get(fn) ??
    analyzeFunctionCapabilities(fn);
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
): ts.TypeNode | undefined {
  if (!argumentNode) return argumentNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    0,
    capabilityRegistry,
  );
  if (!paramSummary) {
    return argumentNode;
  }

  const innerTypeNode = extractCellLikeInnerTypeNode(argumentNode);
  const shouldWrap = !!innerTypeNode;
  const baseTypeNode = innerTypeNode ?? argumentNode;
  const baseType = shouldWrap && argumentType
    ? (unwrapCellLikeType(argumentType, checker) ?? argumentType)
    : argumentType;

  const paths = uniquePaths([
    ...paramSummary.readPaths,
    ...paramSummary.writePaths,
  ]);

  let next = baseTypeNode;
  if (!paramSummary.wildcard && paths.length > 0) {
    // Prefer type-driven shrinking when possible because synthetic type nodes
    // can lose wrapper/property precision for object-literal shorthand values.
    let shrunk = baseType
      ? buildShrunkTypeNodeFromType(
        baseType,
        paths,
        checker,
        sourceFile,
        factory,
      )
      : undefined;
    if (!shrunk) {
      shrunk = buildShrunkTypeNodeFromTypeNode(baseTypeNode, paths, factory);
    }
    if (shrunk) {
      next = shrunk;
    }
  }

  if (!shouldWrap) {
    return next;
  }
  return wrapTypeNodeWithCapability(next, paramSummary.capability, factory);
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
): ts.TypeNode | undefined {
  if (!parameterNode) return parameterNode;

  const paramSummary = findCapabilitySummaryForParameter(
    fn,
    parameterIndex,
    capabilityRegistry,
  );
  if (!paramSummary) {
    return parameterNode;
  }

  const innerTypeNode = extractCellLikeInnerTypeNode(parameterNode);
  const shouldWrap = !!innerTypeNode;
  const baseTypeNode = innerTypeNode ?? parameterNode;
  const baseType = shouldWrap && parameterType
    ? (unwrapCellLikeType(parameterType, checker) ?? parameterType)
    : parameterType;

  const paths = uniquePaths([
    ...paramSummary.readPaths,
    ...paramSummary.writePaths,
  ]);

  let next = baseTypeNode;
  if (!paramSummary.wildcard && paths.length > 0) {
    // Prefer type-driven shrinking when possible because synthetic type nodes
    // can lose wrapper/property precision for object-literal shorthand values.
    let shrunk = baseType
      ? buildShrunkTypeNodeFromType(
        baseType,
        paths,
        checker,
        sourceFile,
        factory,
      )
      : undefined;
    if (!shrunk) {
      shrunk = buildShrunkTypeNodeFromTypeNode(baseTypeNode, paths, factory);
    }
    if (shrunk) {
      next = shrunk;
    }
  }

  if (!shouldWrap) {
    return next;
  }
  return wrapTypeNodeWithCapability(next, paramSummary.capability, factory);
}

function collectFunctionSchemaTypeNodes(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  fallbackArgType?: ts.Type,
  typeRegistry?: TypeRegistry,
  capabilityRegistry?: CapabilitySummaryRegistry,
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
  if (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text.startsWith("_")
  ) {
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
    } catch {
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
    if (returnType && !isAnyOrUnknownType(returnType)) {
      resultType = returnType; // Store for registry
      resultNode = typeToSchemaTypeNode(returnType, checker, sourceFile);
    }
    // If inference failed, leave resultNode undefined - we'll use unknown below
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
  typeRegistry?: TypeRegistry,
  options?: { widenLiterals?: boolean },
): ts.CallExpression {
  const schemaCall = createToSchemaCall(context, typeNode, options);

  // Transfer TypeRegistry entry from source typeNode to schema call
  // This preserves type information for closure-captured variables
  if (typeRegistry) {
    const typeFromRegistry = typeRegistry.get(typeNode);
    if (typeFromRegistry) {
      typeRegistry.set(schemaCall, typeFromRegistry);
    }
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
  if (ts.isIdentifier(param.name) && param.name.text.startsWith("_")) {
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
  if (param && ts.isIdentifier(param.name) && param.name.text.startsWith("_")) {
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
  const argSchemaCall = createToSchemaCall(
    context,
    argumentTypeNode,
  );
  const resSchemaCall = createToSchemaCall(
    context,
    resultTypeNode,
  );

  // Register Types if they were inferred (not from original source)
  if (typeRegistry && checker) {
    if (argumentType) {
      typeRegistry.set(argSchemaCall, argumentType);
    }
    if (resultType) {
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

/**
 * Handler for pattern schema injection.
 * Argument order is function-first: [function, inputSchema, resultSchema]
 *
 * @returns The transformed node, or undefined if no transformation was performed
 */

/**
 * Reports a diagnostic error when a pattern()'s return type resolves to `any`
 * or `unknown`, meaning CTS cannot generate a structural result schema.
 *
 * This produces `resultSchema: true` at runtime (schema-less), which can cause
 * proxy depth crashes. The fix is to add an explicit Output type parameter:
 * `pattern<Input, Output>(...)`.
 */
function reportAnyResultSchema(
  context: TransformationContext,
  node: ts.CallExpression,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern:any-result-schema",
    message: `pattern() return type resolves to 'any' or 'unknown'. ` +
      `This produces a schema-less result cell (resultSchema: true) which can cause runtime crashes. ` +
      `Add an explicit Output type parameter: pattern<Input, Output>(...).`,
    node: node.expression,
  });
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
  } else if (typeArgs && typeArgs.length === 1) {
    // Case 2: One type argument → input from type arg, result inferred
    inputTypeNode = typeArgs[0]!;

    // Check TypeRegistry for input type
    if (typeRegistry) {
      inputType = typeRegistry.get(inputTypeNode);
    }

    // Infer result type from function
    const inferred = collectFunctionSchemaTypeNodes(
      builderFunction,
      checker,
      sourceFile,
      factory,
      undefined,
      typeRegistry,
      capabilityRegistry,
    );
    if (!inferred.result) {
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
      );
      if (!inferred.result) {
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
      );

      inputTypeNode = inferred.argument ??
        getParameterSchemaType(factory, inputParam);
      inputType = getTypeFromRegistryOrFallback(
        inputTypeNode,
        inferred.argumentType,
        typeRegistry,
      );

      if (!inferred.result) {
        reportAnyResultSchema(context, node);
      }
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

export class SchemaInjectionTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, tsContext: transformation, checker } = context;
    const typeRegistry = context.options.typeRegistry;
    const capabilityRegistry = context.options.useLegacyOpaqueRefSemantics
      ? undefined
      : context.options.capabilitySummaryRegistry;

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
            ) ?? stateType;
          }

          const toSchemaEvent = createSchemaCallWithRegistryTransfer(
            context,
            eventTypeNode,
            typeRegistry,
          );
          const toSchemaState = createSchemaCallWithRegistryTransfer(
            context,
            stateTypeNode,
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
            );

            // Event type: use inferred or fallback to never/unknown refinement
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
            ) ?? stateTypeBase;

            // Always transform - generate schemas regardless of parameter presence
            const toSchemaEvent = createSchemaCallWithRegistryTransfer(
              context,
              eventType,
              typeRegistry,
            );
            const toSchemaState = createSchemaCallWithRegistryTransfer(
              context,
              stateType,
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
        const updateWithSchemas = (
          argumentType: ts.TypeNode,
          argumentTypeValue: ts.Type | undefined,
          resultType: ts.TypeNode,
          resultTypeValue: ts.Type | undefined,
        ): ts.Node => {
          const updated = prependSchemaArguments(
            context,
            node,
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
            typeRegistry,
            checker,
          );
          // Visit children to catch any pattern calls created by ClosureTransformer
          // inside the derive callback (e.g., from map transformations)
          return ts.visitEachChild(updated, visit, transformation);
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Check if ClosureTransformer registered Types for these TypeNodes
          // This preserves type information for shorthand properties with captured variables
          let argumentTypeValue: ts.Type | undefined;
          let resultTypeValue: ts.Type | undefined;

          if (typeRegistry) {
            if (typeRegistry.has(argumentType)) {
              argumentTypeValue = typeRegistry.get(argumentType);
            }
            if (typeRegistry.has(resultType)) {
              resultTypeValue = typeRegistry.get(resultType);
            }
          }

          let argumentTypeNode: ts.TypeNode = argumentType;
          const deriveCallback = node.arguments[1];
          if (
            deriveCallback &&
            (ts.isArrowFunction(deriveCallback) ||
              ts.isFunctionExpression(deriveCallback))
          ) {
            const transformedArgumentType = applyCapabilitySummaryToArgument(
              deriveCallback,
              argumentType,
              argumentTypeValue,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
            );
            if (transformedArgumentType) {
              argumentTypeNode = transformedArgumentType;
              if (argumentTypeNode !== argumentType) {
                argumentTypeValue = undefined;
              }
            }
          }

          return updateWithSchemas(
            argumentTypeNode,
            argumentTypeValue,
            resultType,
            resultTypeValue,
          );
        }

        if (
          node.arguments.length >= 2 &&
          isFunctionLikeExpression(node.arguments[1]!)
        ) {
          const firstArg = node.arguments[0]!;
          const callback = node.arguments[1] as
            | ts.ArrowFunction
            | ts.FunctionExpression;

          // Special case: detect empty object literal {} and generate specific schema
          let argNode: ts.TypeNode | undefined;
          let argType: ts.Type | undefined;

          if (
            ts.isObjectLiteralExpression(firstArg) &&
            firstArg.properties.length === 0
          ) {
            // Empty object literal - create a specific type for it
            // This should generate {type: "unknown"}
            argNode = factory.createTypeLiteralNode([]);
            // Don't set argType - let schema generator handle the synthetic node
          } else {
            // Normal case - infer from the argument type
            // Apply literal widening so `const x = 5; derive(x, fn)` produces `number`, not `5`
            // Use getTypeAtLocationWithFallback to handle synthetic nodes (e.g., mapWithPattern calls)
            // which have their types registered in the typeRegistry by ClosureTransformer
            const argumentType = widenLiteralType(
              getTypeAtLocationWithFallback(firstArg, checker, typeRegistry) ??
                checker.getTypeAtLocation(firstArg),
              checker,
            );
            const inferred = collectFunctionSchemaTypeNodes(
              callback,
              checker,
              sourceFile,
              factory,
              argumentType,
              typeRegistry,
              capabilityRegistry,
            );
            // Use inferred type or fallback to never/unknown refinement
            argNode = inferred.argument ??
              getParameterSchemaType(factory, callback.parameters[0]);
            argType = inferred.argumentType;
          }

          // Always infer return type
          const inferred = collectFunctionSchemaTypeNodes(
            callback,
            checker,
            sourceFile,
            factory,
            undefined,
            typeRegistry,
            capabilityRegistry,
          );

          // Always transform - use unknown for missing types
          const finalArgNode = argNode ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          const resNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          return updateWithSchemas(
            finalArgNode,
            argType,
            resNode,
            inferred.resultType,
          );
        }
      }

      if (callKind?.kind === "builder" && callKind.builderName === "lift") {
        const factory = transformation.factory;
        const updateWithSchemas = (
          argumentType: ts.TypeNode,
          argumentTypeValue: ts.Type | undefined,
          resultType: ts.TypeNode,
          resultTypeValue: ts.Type | undefined,
        ): ts.Node => {
          const updated = prependSchemaArguments(
            context,
            node,
            argumentType,
            argumentTypeValue,
            resultType,
            resultTypeValue,
            typeRegistry,
            checker,
          );
          // Visit children to catch any pattern calls created by ClosureTransformer
          // inside the derive callback (e.g., from map transformations)
          return ts.visitEachChild(updated, visit, transformation);
        };

        if (node.typeArguments && node.typeArguments.length >= 2) {
          const [argumentType, resultType] = node.typeArguments;
          if (!argumentType || !resultType) {
            return ts.visitEachChild(node, visit, transformation);
          }

          // Check TypeRegistry for closure-captured types (like Handler does)
          // This allows SchemaGeneratorTransformer to find Types for synthetic TypeNodes
          // created by ClosureTransformer
          let argumentTypeValue: ts.Type | undefined;
          let resultTypeValue: ts.Type | undefined;

          if (typeRegistry) {
            argumentTypeValue = typeRegistry.get(argumentType);
            resultTypeValue = typeRegistry.get(resultType);
          }

          let argumentTypeNode: ts.TypeNode = argumentType;
          const liftCallback = node.arguments[0];
          if (
            liftCallback &&
            (ts.isArrowFunction(liftCallback) ||
              ts.isFunctionExpression(liftCallback))
          ) {
            const transformedArgumentType = applyCapabilitySummaryToArgument(
              liftCallback,
              argumentType,
              argumentTypeValue,
              checker,
              sourceFile,
              factory,
              capabilityRegistry,
            );
            if (transformedArgumentType) {
              argumentTypeNode = transformedArgumentType;
              if (argumentTypeNode !== argumentType) {
                argumentTypeValue = undefined;
              }
            }
          }

          return updateWithSchemas(
            argumentTypeNode,
            argumentTypeValue,
            resultType,
            resultTypeValue,
          );
        }

        if (
          node.arguments.length === 1 &&
          isFunctionLikeExpression(node.arguments[0]!)
        ) {
          const callback = node.arguments[0] as
            | ts.ArrowFunction
            | ts.FunctionExpression;
          const inferred = collectFunctionSchemaTypeNodes(
            callback,
            checker,
            sourceFile,
            factory,
            undefined,
            typeRegistry,
            capabilityRegistry,
          );

          // For argument: use inferred type or apply never/unknown refinement
          const argNode = inferred.argument ??
            getParameterSchemaType(factory, callback.parameters[0]);

          // For result: use inferred type or default to unknown
          const resNode = inferred.result ??
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

          // Check TypeRegistry for inferred types (may be synthetic from ClosureTransformer)
          const argType = getTypeFromRegistryOrFallback(
            argNode,
            inferred.argumentType,
            typeRegistry,
          );
          const resType = getTypeFromRegistryOrFallback(
            resNode,
            inferred.resultType,
            typeRegistry,
          );

          // Always transform with both schemas
          return updateWithSchemas(
            argNode,
            argType,
            resNode,
            resType,
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

        let typeNode: ts.TypeNode | undefined;
        let type: ts.Type | undefined;

        // Track whether we're using value inference (vs explicit type arg)
        const isValueInference = !typeArgs || typeArgs.length === 0;

        if (typeArgs && typeArgs.length > 0) {
          // Use explicit type argument - preserve literal types
          typeNode = typeArgs[0];
          if (typeNode && typeRegistry) {
            type = typeRegistry.get(typeNode);
          }
        } else if (args.length > 0) {
          // Infer from value argument - widen literal types
          const valueArg = args[0];
          if (valueArg) {
            const valueType = checker.getTypeAtLocation(valueArg);
            if (valueType && !isAnyOrUnknownType(valueType)) {
              // Widen literal types (e.g., 10 → number) for more flexible schemas
              type = widenLiteralType(valueType, checker);
              typeNode = typeToSchemaTypeNode(type, checker, sourceFile);
            }
          }
        }

        if (typeNode) {
          const schemaCall = createSchemaCallWithRegistryTransfer(
            context,
            typeNode,
            typeRegistry,
            isValueInference ? { widenLiterals: true } : undefined,
          );

          // If we inferred the type (no explicit type arg), register it
          if (isValueInference && type && typeRegistry) {
            typeRegistry.set(schemaCall, type);
          }

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

        let typeNode: ts.TypeNode | undefined;
        let type: ts.Type | undefined;

        if (typeArgs && typeArgs.length > 0) {
          typeNode = typeArgs[0];
          if (typeNode && typeRegistry) {
            type = typeRegistry.get(typeNode);
          }
        } else {
          // Infer from contextual type (variable assignment)
          const contextualType = inferContextualType(node, checker);
          if (contextualType) {
            // We need to unwrap Cell<T> to get T
            const unwrapped = unwrapOpaqueLikeType(contextualType, checker);
            if (unwrapped) {
              type = unwrapped;
              typeNode = typeToSchemaTypeNode(unwrapped, checker, sourceFile);
            }
          }
        }

        if (typeNode) {
          const schemaCall = createSchemaCallWithRegistryTransfer(
            context,
            typeNode,
            typeRegistry,
          );
          if ((!typeArgs || typeArgs.length === 0) && type && typeRegistry) {
            typeRegistry.set(schemaCall, type);
          }

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

        let typeNode: ts.TypeNode | undefined;
        let type: ts.Type | undefined;

        if (typeArgs && typeArgs.length > 0) {
          typeNode = typeArgs[0];
          if (typeNode && typeRegistry) {
            type = typeRegistry.get(typeNode);
          }
        } else {
          // Infer from contextual type
          const contextualType = inferContextualType(node, checker);
          if (contextualType) {
            type = contextualType;
            typeNode = typeToSchemaTypeNode(
              contextualType,
              checker,
              sourceFile,
            );
          }
        }

        if (typeNode) {
          const schemaCall = createSchemaCallWithRegistryTransfer(
            context,
            typeNode,
            typeRegistry,
          );
          if ((!typeArgs || typeArgs.length === 0) && type && typeRegistry) {
            typeRegistry.set(schemaCall, type);
          }

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

        let typeNode: ts.TypeNode | undefined;
        let type: ts.Type | undefined;

        if (typeArgs && typeArgs.length > 0) {
          typeNode = typeArgs[0];
          if (typeNode && typeRegistry) {
            type = typeRegistry.get(typeNode);
          }
        } else {
          // Infer from contextual type
          const contextualType = inferContextualType(node, checker);
          if (contextualType) {
            const objectProp = contextualType.getProperty("object");
            if (objectProp) {
              const objectType = checker.getTypeOfSymbolAtLocation(
                objectProp,
                node,
              );
              if (objectType) {
                type = objectType;
                typeNode = typeToSchemaTypeNode(
                  objectType,
                  checker,
                  sourceFile,
                );
              }
            }
          }
        }

        if (typeNode) {
          const schemaCall = createSchemaCallWithRegistryTransfer(
            context,
            typeNode,
            typeRegistry,
          );
          if ((!typeArgs || typeArgs.length === 0) && type && typeRegistry) {
            typeRegistry.set(schemaCall, type);
          }

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
        const factory = transformation.factory;
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

        // Create schema TypeNodes (with literal widening for consistency)
        const conditionTypeNode = typeToSchemaTypeNode(
          widenLiteralType(conditionType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const valueTypeNode = typeToSchemaTypeNode(
          widenLiteralType(valueType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const resultTypeNode = typeToSchemaTypeNode(
          widenLiteralType(resultType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        // Create toSchema<T>() calls
        const conditionSchema = createSchemaCallWithRegistryTransfer(
          context,
          conditionTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const valueSchema = createSchemaCallWithRegistryTransfer(
          context,
          valueTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const resultSchema = createSchemaCallWithRegistryTransfer(
          context,
          resultTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );

        // Register in TypeRegistry for SchemaGeneratorTransformer
        if (typeRegistry) {
          typeRegistry.set(conditionSchema, conditionType);
          typeRegistry.set(valueSchema, valueType);
          typeRegistry.set(resultSchema, resultType);
        }

        // Create new call with schemas prepended: when(condSchema, valueSchema, resultSchema, cond, value)
        const updated = factory.createCallExpression(
          node.expression,
          undefined,
          [conditionSchema, valueSchema, resultSchema, ...args],
        );

        return ts.visitEachChild(updated, visit, transformation);
      }

      // Handler for unless(condition, fallback) - prepends 3 schemas (condition, fallback, result)
      if (callKind?.kind === "unless") {
        const factory = transformation.factory;
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

        // Create schema TypeNodes (with literal widening for consistency)
        const conditionTypeNode = typeToSchemaTypeNode(
          widenLiteralType(conditionType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const fallbackTypeNode = typeToSchemaTypeNode(
          widenLiteralType(fallbackType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const resultTypeNode = typeToSchemaTypeNode(
          widenLiteralType(resultType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        // Create toSchema<T>() calls
        const conditionSchema = createSchemaCallWithRegistryTransfer(
          context,
          conditionTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const fallbackSchema = createSchemaCallWithRegistryTransfer(
          context,
          fallbackTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const resultSchema = createSchemaCallWithRegistryTransfer(
          context,
          resultTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );

        // Register in TypeRegistry for SchemaGeneratorTransformer
        if (typeRegistry) {
          typeRegistry.set(conditionSchema, conditionType);
          typeRegistry.set(fallbackSchema, fallbackType);
          typeRegistry.set(resultSchema, resultType);
        }

        // Create new call with schemas prepended: unless(condSchema, fallbackSchema, resultSchema, cond, fallback)
        const updated = factory.createCallExpression(
          node.expression,
          undefined,
          [conditionSchema, fallbackSchema, resultSchema, ...args],
        );

        return ts.visitEachChild(updated, visit, transformation);
      }

      // Handler for ifElse(condition, ifTrue, ifFalse) - prepends 4 schemas (condition, ifTrue, ifFalse, result)
      if (callKind?.kind === "ifElse") {
        const factory = transformation.factory;
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

        // Create schema TypeNodes (with literal widening for consistency)
        const conditionTypeNode = typeToSchemaTypeNode(
          widenLiteralType(conditionType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const ifTrueTypeNode = typeToSchemaTypeNode(
          widenLiteralType(ifTrueType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const ifFalseTypeNode = typeToSchemaTypeNode(
          widenLiteralType(ifFalseType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        const resultTypeNode = typeToSchemaTypeNode(
          widenLiteralType(resultType, checker),
          checker,
          sourceFile,
        ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

        // Create toSchema<T>() calls
        const conditionSchema = createSchemaCallWithRegistryTransfer(
          context,
          conditionTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const ifTrueSchema = createSchemaCallWithRegistryTransfer(
          context,
          ifTrueTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const ifFalseSchema = createSchemaCallWithRegistryTransfer(
          context,
          ifFalseTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );
        const resultSchema = createSchemaCallWithRegistryTransfer(
          context,
          resultTypeNode,
          typeRegistry,
          { widenLiterals: true },
        );

        // Register in TypeRegistry for SchemaGeneratorTransformer
        if (typeRegistry) {
          typeRegistry.set(conditionSchema, conditionType);
          typeRegistry.set(ifTrueSchema, ifTrueType);
          typeRegistry.set(ifFalseSchema, ifFalseType);
          typeRegistry.set(resultSchema, resultType);
        }

        // Create new call with schemas prepended: ifElse(condSchema, trueSchema, falseSchema, resultSchema, cond, ifTrue, ifFalse)
        const updated = factory.createCallExpression(
          node.expression,
          undefined,
          [conditionSchema, ifTrueSchema, ifFalseSchema, resultSchema, ...args],
        );

        return ts.visitEachChild(updated, visit, transformation);
      }

      return ts.visitEachChild(node, visit, transformation);
    };

    return ts.visitEachChild(sourceFile, visit, transformation);
  }
}
