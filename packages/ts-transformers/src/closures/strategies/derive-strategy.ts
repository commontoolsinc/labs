import ts from "typescript";
import type {
  CapabilityParamDefault,
  CapabilityParamSummary,
  TransformationContext,
} from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  detectCallKind,
  getTypeAtLocationWithFallback,
  getTypeReferenceArgument,
  isFunctionLikeExpression,
  unwrapOpaqueLikeType,
} from "../../ast/mod.ts";
import { registerDeriveCallType } from "../../ast/type-inference.ts";
import { setParentPointers } from "../../ast/utils.ts";
import { analyzeFunctionCapabilities } from "../../policy/mod.ts";
import { getCellKind } from "../../transformers/opaque-ref/opaque-ref.ts";
import {
  applyShrinkAndWrap,
  isCellLikeTypeNode,
} from "../../transformers/type-shrinking.ts";
import { expressionToTypeNode } from "../../ast/type-building.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

function getPropertySignatureName(
  name: ts.PropertyName,
): string | undefined {
  if (
    ts.isIdentifier(name) || ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function findDescendantCaptureExpression(
  node: CaptureTreeNode,
): ts.Expression | undefined {
  if (node.expression) {
    return node.expression;
  }
  for (const child of node.properties.values()) {
    const expression = findDescendantCaptureExpression(child);
    if (expression) {
      return expression;
    }
  }
  return undefined;
}

function findCaptureRootExpression(
  rootName: string,
  node: CaptureTreeNode,
): ts.Expression | undefined {
  const expression = findDescendantCaptureExpression(node);
  if (!expression) {
    return undefined;
  }

  let current: ts.Expression = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }

  if (ts.isIdentifier(current) && current.text === rootName) {
    return current;
  }

  return expression;
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

function recoverPrintableTypeNode(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): { type: ts.Type; typeNode: ts.TypeNode } | undefined {
  if (!type) return undefined;

  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };

  let current: ts.Type | undefined = type;
  const seen = new Set<ts.Type>();
  while (current && !seen.has(current)) {
    seen.add(current);

    const typeNode = checker.typeToTypeNode(
      current,
      sourceFile,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseStructuralFallback,
    );
    if (typeNode) {
      return { type: current, typeNode };
    }

    if (
      typeChecker.isArrayType?.(current) || typeChecker.isTupleType?.(current)
    ) {
      break;
    }

    const opaqueUnwrapped = unwrapOpaqueLikeType(current, checker);
    if (opaqueUnwrapped && opaqueUnwrapped !== current) {
      current = opaqueUnwrapped;
      continue;
    }

    const next = getTypeReferenceArgument(current);
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return undefined;
}

function sliceCapabilityDefaultsForRoot(
  defaults: readonly CapabilityParamDefault[] | undefined,
  rootName: string,
): readonly CapabilityParamDefault[] | undefined {
  if (!defaults || defaults.length === 0) {
    return undefined;
  }

  const next = defaults.flatMap((entry) => {
    if (entry.path[0] !== rootName) {
      return [];
    }
    return [{
      path: entry.path.slice(1),
      defaultType: entry.defaultType,
    }];
  });

  return next.length > 0 ? next : undefined;
}

function sliceCapabilitySummaryForRoot(
  paramSummary: CapabilityParamSummary,
  rootName: string,
): CapabilityParamSummary | undefined {
  const readPaths = paramSummary.readPaths
    .filter((path) => path[0] === rootName)
    .map((path) => path.slice(1));
  const writePaths = paramSummary.writePaths
    .filter((path) => path[0] === rootName)
    .map((path) => path.slice(1));
  const defaults = sliceCapabilityDefaultsForRoot(
    paramSummary.defaults,
    rootName,
  );

  if (
    readPaths.length === 0 &&
    writePaths.length === 0 &&
    (!defaults || defaults.length === 0)
  ) {
    return undefined;
  }

  return {
    name: rootName,
    capability: paramSummary.capability,
    readPaths,
    writePaths,
    passthrough: false,
    wildcard: false,
    defaults,
  };
}

function tryGetTypeAtLocation(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
): ts.Type | undefined {
  if (!expression) {
    return undefined;
  }
  try {
    return checker.getTypeAtLocation(expression);
  } catch {
    return undefined;
  }
}

function tryShrinkMergedInputTypeLiteralMembers(
  inputTypeNode: ts.TypeNode,
  paramSummary: CapabilityParamSummary,
  originalInputParamName: string,
  originalInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  hadZeroParameters: boolean,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.TypeNode | undefined {
  if (!ts.isTypeLiteralNode(inputTypeNode)) {
    return undefined;
  }

  if (paramSummary.wildcard || paramSummary.passthrough) {
    return undefined;
  }

  if (
    paramSummary.readPaths.some((path) => path.length === 0) ||
    paramSummary.writePaths.some((path) => path.length === 0)
  ) {
    return undefined;
  }

  const rootTypes = new Map<string, ts.Type | undefined>();
  if (!hadZeroParameters) {
    rootTypes.set(
      originalInputParamName,
      tryGetTypeAtLocation(checker, originalInput),
    );
  }

  for (const [originalName, node] of captureTree) {
    const renamedName = captureNameMap.get(originalName) ?? originalName;
    rootTypes.set(
      renamedName,
      tryGetTypeAtLocation(
        checker,
        findCaptureRootExpression(originalName, node),
      ),
    );
  }

  const nextMembers = inputTypeNode.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type) {
      return member;
    }

    const propertyName = getPropertySignatureName(member.name);
    if (!propertyName) {
      return member;
    }

    const propertySummary = sliceCapabilitySummaryForRoot(
      paramSummary,
      propertyName,
    );
    if (!propertySummary) {
      return member;
    }

    const rootType = rootTypes.get(propertyName);
    const rootCellKind = rootType ? getCellKind(rootType, checker) : undefined;
    const cellLikeRoot = rootCellKind === "cell" || rootCellKind === "stream";
    const recoveredType = cellLikeRoot &&
        (member.type.kind === ts.SyntaxKind.UnknownKeyword ||
          member.type.kind === ts.SyntaxKind.AnyKeyword) &&
        rootType
      ? recoverPrintableTypeNode(rootType, checker, sourceFile)
      : undefined;
    const resolvedMemberType = recoveredType?.typeNode ?? member.type;
    const innerTypeNode = recoveredType
      ? undefined
      : extractCellLikeInnerTypeNode(resolvedMemberType);
    const shouldWrap = cellLikeRoot || !!innerTypeNode;
    const baseTypeNode = recoveredType?.typeNode ?? innerTypeNode ??
      resolvedMemberType;
    const baseType = recoveredType?.type ?? (
      shouldWrap
        ? (unwrapCellLikeType(rootType, checker) ?? rootType)
        : rootType
    );

    const nextType = applyShrinkAndWrap(
      propertySummary,
      baseTypeNode,
      baseType,
      shouldWrap,
      checker,
      sourceFile,
      factory,
    );

    return factory.updatePropertySignature(
      member,
      member.modifiers,
      member.name,
      member.questionToken,
      nextType,
    );
  });

  return factory.updateTypeLiteralNode(
    inputTypeNode,
    factory.createNodeArray(nextMembers),
  );
}

function refineUnknownInputMembersFromMergedInput(
  inputTypeNode: ts.TypeNode,
  mergedInput: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  if (
    !ts.isTypeLiteralNode(inputTypeNode) ||
    !ts.isObjectLiteralExpression(mergedInput)
  ) {
    return inputTypeNode;
  }

  const initializerByName = new Map<string, ts.Expression>();
  for (const property of mergedInput.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      initializerByName.set(property.name.text, property.name);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertySignatureName(property.name);
    if (name) {
      initializerByName.set(name, property.initializer);
    }
  }

  const nextMembers = inputTypeNode.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type) {
      return member;
    }

    if (ts.isTypeLiteralNode(member.type)) {
      return member;
    }

    const propertyName = getPropertySignatureName(member.name);
    if (!propertyName) {
      return member;
    }

    const initializer = initializerByName.get(propertyName);
    if (!initializer) {
      return member;
    }

    const initializerType = getTypeAtLocationWithFallback(
      initializer,
      context.checker,
      context.options.typeRegistry,
    );
    const memberType = getTypeAtLocationWithFallback(
      member.type,
      context.checker,
      context.options.typeRegistry,
    );
    if (
      ts.isIdentifier(initializer) &&
      initializerType &&
      (initializerType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ===
        0 &&
      !ts.isTypeLiteralNode(member.type)
    ) {
      return context.factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken,
        expressionToTypeNode(initializer, context),
      );
    }

    if (
      member.type.kind !== ts.SyntaxKind.UnknownKeyword &&
      member.type.kind !== ts.SyntaxKind.AnyKeyword &&
      (!memberType ||
        (memberType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0)
    ) {
      return member;
    }

    return context.factory.updatePropertySignature(
      member,
      member.modifiers,
      member.name,
      member.questionToken,
      expressionToTypeNode(initializer, context),
    );
  });

  return context.factory.updateTypeLiteralNode(
    inputTypeNode,
    context.factory.createNodeArray(nextMembers),
  );
}

function registerMergedInputIdentifierTypes(
  mergedInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): void {
  if (!typeRegistry || !ts.isObjectLiteralExpression(mergedInput)) {
    return;
  }

  const originalNameByProperty = new Map<string, string>();
  for (const [originalName] of captureTree) {
    originalNameByProperty.set(
      captureNameMap.get(originalName) ?? originalName,
      originalName,
    );
  }

  for (const property of mergedInput.properties) {
    let propertyName: string | undefined;
    let initializer: ts.Expression | undefined;

    if (ts.isShorthandPropertyAssignment(property)) {
      propertyName = property.name.text;
      initializer = property.name;
    } else if (ts.isPropertyAssignment(property)) {
      propertyName = getPropertySignatureName(property.name);
      initializer = property.initializer;
    }

    if (!propertyName || !initializer || !ts.isIdentifier(initializer)) {
      continue;
    }

    const originalName = originalNameByProperty.get(propertyName);
    const captureNode = originalName
      ? captureTree.get(originalName)
      : undefined;
    if (!originalName || !captureNode) {
      continue;
    }

    const captureRoot = findCaptureRootExpression(originalName, captureNode);
    const captureType = tryGetTypeAtLocation(checker, captureRoot);
    if (captureType) {
      typeRegistry.set(initializer, captureType);
    }
  }
}

/**
 * Pre-register unwrapped types for captured identifiers in a callback body.
 * This allows nested transformations (like map -> mapWithPattern decisions)
 * to see the correct unwrapped types for captured variables.
 *
 * Inside a derive callback:
 * - OpaqueRef<T> captures become T parameters (unwrapped)
 * - Cell<T> captures remain Cell<T> (NOT unwrapped)
 *
 * We register this before the visitor runs so decisions are made correctly.
 */
function preRegisterCaptureTypes(
  body: ts.ConciseBody,
  captureExpressions: Set<ts.Expression>,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): void {
  if (!typeRegistry) return;

  // Build map: capture name -> type to register
  // Only unwrap OpaqueRef types (kind === "opaque"), not Cell types
  const captureTypes = new Map<string, ts.Type>();
  for (const expr of captureExpressions) {
    if (ts.isIdentifier(expr)) {
      const exprType = checker.getTypeAtLocation(expr);
      if (exprType) {
        const kind = getCellKind(exprType, checker);

        // Only unwrap if it's an OpaqueRef (kind === "opaque")
        // Cell and Stream types should NOT be unwrapped
        if (kind === "opaque") {
          const unwrapped = unwrapOpaqueLikeType(exprType, checker);
          if (unwrapped && unwrapped !== exprType) {
            captureTypes.set(expr.text, unwrapped);
          }
        }
        // For Cell/Stream types, we don't register anything - let TypeScript's natural type be used
      }
    }
    // NOTE: Property access captures like state.items are handled separately
  }

  if (captureTypes.size === 0) return;

  // Walk the body and register unwrapped types for all matching identifiers
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const unwrappedType = captureTypes.get(node.text);
      if (unwrappedType) {
        typeRegistry.set(node, unwrappedType);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
}

export class DeriveStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) && isDeriveCall(node, context);
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformDeriveCall(node, context, visitor);
  }
}

/**
 * Check if a call expression is a derive() call from commontools
 */
export function isDeriveCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "derive";
}

/**
 * Extract the callback function from a derive call.
 * Derive has two signatures:
 * - 2-arg: derive(input, callback)
 * - 4-arg: derive(inputSchema, resultSchema, input, callback)
 */
function extractDeriveCallback(
  deriveCall: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const args = deriveCall.arguments;

  // 2-arg form: callback is at index 1
  if (args.length === 2) {
    const callback = args[1];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  // 4-arg form: callback is at index 3
  if (args.length === 4) {
    const callback = args[3];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  return undefined;
}

/**
 * Resolve capture name collisions with the original input parameter name.
 * If a capture has the same name as originalInputParamName, rename it (e.g., multiplier -> multiplier_1).
 * Returns a mapping from original capture names to their potentially renamed versions.
 */
function resolveDeriveCaptureNameCollisions(
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
): Map<string, string> {
  const captureNameMap = new Map<string, string>();
  const usedNames = new Set<string>([originalInputParamName]);

  for (const [captureName] of captureTree) {
    if (captureName === originalInputParamName) {
      // Collision detected - rename the capture
      let renamed = `${captureName}_1`;
      let suffix = 1;
      while (usedNames.has(renamed) || captureTree.has(renamed)) {
        suffix++;
        renamed = `${captureName}_${suffix}`;
      }
      captureNameMap.set(captureName, renamed);
      usedNames.add(renamed);
    } else {
      // No collision - use original name
      captureNameMap.set(captureName, captureName);
      usedNames.add(captureName);
    }
  }

  return captureNameMap;
}

/**
 * Build the merged input object containing both the original input and captures.
 * Example: {value, multiplier} where value is the original input and multiplier is a capture.
 *
 * When hadZeroParameters is true, skip the original input and only include captures.
 * This handles the case where user wrote derive({}, () => ...) and we only need captures.
 */
function buildDeriveInputObject(
  originalInput: ts.Expression,
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
  hadZeroParameters: boolean,
): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];

  // Add the original input as a property UNLESS callback had zero parameters
  // When hadZeroParameters, we only include captures
  if (!hadZeroParameters) {
    if (
      ts.isIdentifier(originalInput) &&
      originalInput.text === originalInputParamName
    ) {
      properties.push(
        factory.createShorthandPropertyAssignment(originalInput, undefined),
      );
    } else {
      properties.push(
        factory.createPropertyAssignment(
          createPropertyName(originalInputParamName, factory),
          originalInput,
        ),
      );
    }
  }

  // Add captures with potentially renamed property names
  for (const [originalName, node] of captureTree) {
    const propertyName = captureNameMap.get(originalName) ?? originalName;
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName(propertyName, factory),
        buildHierarchicalParamsValue(node, originalName, factory),
      ),
    );
  }

  return factory.createObjectLiteralExpression(
    properties,
    properties.length > 1,
  );
}

/**
 * Rewrite the callback body to use renamed capture identifiers.
 * For example, if `multiplier` was renamed to `multiplier_1`, replace all
 * references to the captured `multiplier` with `multiplier_1`.
 *
 * Also registers the new identifiers with their UNWRAPPED types in typeRegistry,
 * so type-based checks inside the derive callback see the correct types.
 */
function rewriteCaptureReferences(
  body: ts.ConciseBody,
  captureNameMap: Map<string, string>,
  captureExpressions: Set<ts.Expression>,
  factory: ts.NodeFactory,
  checker: ts.TypeChecker | undefined,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ts.ConciseBody {
  // Build a map: identifier name -> unwrapped type
  // We need to register all capture references (not just renamed ones) with unwrapped types
  const captureTypes = new Map<string, ts.Type>();
  if (checker) {
    for (const expr of captureExpressions) {
      // Get the root identifier name from the expression
      let rootName: string | undefined;
      if (ts.isIdentifier(expr)) {
        rootName = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        // For property access like `state.items`, we want to register `items`
        // but the capture tree uses the full path
        // For now, skip these - they get handled separately
        continue;
      }

      if (rootName) {
        const exprType = checker.getTypeAtLocation(expr);
        if (exprType) {
          const unwrapped = unwrapOpaqueLikeType(exprType, checker);
          if (unwrapped) {
            captureTypes.set(rootName, unwrapped);
          }
        }
      }
    }
  }

  // Build a map: original name -> renamed name (for all captures, not just renamed)
  const substitutions = new Map<string, string>();
  for (const [originalName, renamedName] of captureNameMap) {
    substitutions.set(originalName, renamedName);
  }

  if (substitutions.size === 0) {
    return body; // No captures to substitute
  }

  const visitor = (node: ts.Node, parent?: ts.Node): ts.Node => {
    // Handle shorthand property assignments specially
    // { multiplier } needs to become { multiplier: multiplier_1 } if multiplier is renamed
    if (ts.isShorthandPropertyAssignment(node)) {
      const substituteName = substitutions.get(node.name.text);
      if (substituteName) {
        const newIdentifier = factory.createIdentifier(substituteName);
        // Register with unwrapped type
        const unwrappedType = captureTypes.get(node.name.text);
        if (unwrappedType && typeRegistry) {
          typeRegistry.set(newIdentifier, unwrappedType);
        }
        // Expand shorthand into full property assignment
        return factory.createPropertyAssignment(
          node.name, // Property name stays the same
          newIdentifier, // Value uses renamed identifier
        );
      }
      // No substitution needed, keep as shorthand
      return node;
    }

    // Don't substitute identifiers that are property names
    if (ts.isIdentifier(node)) {
      // Skip if this identifier is the property name in a property access (e.g., '.get' in 'obj.get')
      if (
        parent && ts.isPropertyAccessExpression(parent) && parent.name === node
      ) {
        return node;
      }

      // Skip if this identifier is a property name in an object literal (e.g., 'foo' in '{ foo: value }')
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
        return node;
      }

      const substituteName = substitutions.get(node.text);
      if (substituteName) {
        const newIdentifier = factory.createIdentifier(substituteName);
        // Register with unwrapped type
        const unwrappedType = captureTypes.get(node.text);
        if (unwrappedType && typeRegistry) {
          typeRegistry.set(newIdentifier, unwrappedType);
        }
        return newIdentifier;
      }
    }

    return ts.visitEachChild(
      node,
      (child: ts.Node) => visitor(child, node),
      undefined,
    );
  };

  return ts.visitNode(
    body,
    (node: ts.Node) => visitor(node, undefined),
  ) as ts.ConciseBody;
}

/**
 * Transform a derive call that has closures in its callback.
 * Converts: derive(value, (v) => v * multiplier.get())
 * To: derive(inputSchema, resultSchema, {value, multiplier}, ({value: v, multiplier}) => v * multiplier)
 */
export function transformDeriveCall(
  deriveCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker, options } = context;

  // Extract callback
  const callback = extractDeriveCallback(deriveCall);
  if (!callback) {
    return undefined;
  }

  // Collect captures
  const collector = new CaptureCollector(checker);
  const { captures: captureExpressions, captureTree } = collector.analyze(
    callback,
  );
  if (captureExpressions.size === 0) {
    // No captures - no transformation needed
    return undefined;
  }

  // Pre-register unwrapped types for captured identifiers BEFORE the visitor runs.
  // This allows nested transformations (like map -> mapWithPattern) to see the
  // correct unwrapped types for captured variables inside this derive callback.
  preRegisterCaptureTypes(
    callback.body,
    captureExpressions,
    checker,
    options.typeRegistry,
  );

  // Recursively transform the callback body first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Determine original input and parameter name
  const args = deriveCall.arguments;
  let originalInput: ts.Expression | undefined;

  if (args.length === 2) {
    // 2-arg form: derive(input, callback)
    originalInput = args[0];
  } else if (args.length === 4) {
    // 4-arg form: derive(inputSchema, resultSchema, input, callback)
    originalInput = args[2];
  } else {
    // Invalid number of arguments
    return undefined;
  }

  // Ensure we have a valid input expression
  if (!originalInput) {
    return undefined;
  }

  // Determine parameter name for the original input
  let originalInputParamName = "input"; // Fallback for complex expressions

  if (ts.isIdentifier(originalInput)) {
    originalInputParamName = originalInput.text;
  } else if (ts.isPropertyAccessExpression(originalInput)) {
    originalInputParamName = originalInput.name.text;
  }

  // Check if callback originally had zero parameters
  const hadZeroParameters = callback.parameters.length === 0;

  // Resolve capture name collisions with the original input parameter name
  const captureNameMap = resolveDeriveCaptureNameCollisions(
    hadZeroParameters ? "" : originalInputParamName,
    captureTree,
  );

  // Build merged input object
  const mergedInput = buildDeriveInputObject(
    originalInput,
    originalInputParamName,
    captureTree,
    captureNameMap,
    factory,
    hadZeroParameters,
  );

  // Rewrite the body to use renamed capture identifiers
  // Also registers new identifiers with unwrapped types for correct type inference
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    captureExpressions,
    factory,
    checker,
    options.typeRegistry,
  );

  // Initialize PatternBuilder
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);
  builder.setCaptureRenames(captureNameMap);

  // Register used names (original input param name)
  builder.registerUsedNames([originalInputParamName]);

  // Infer result type from callback
  const signature = checker.getSignatureFromDeclaration(callback);
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;
  let hasTypeParameter = false;

  if (callback.type) {
    // Explicit return type annotation
    resultTypeNode = callback.type;
  } else if (signature) {
    // Infer from callback signature
    resultType = signature.getReturnType();

    // Check if this is an uninstantiated type parameter
    const resultFlags = resultType.flags;
    const isTypeParam = (resultFlags & ts.TypeFlags.TypeParameter) !== 0;

    if (isTypeParam) {
      hasTypeParameter = true;
    } else {
      resultTypeNode = checker.typeToTypeNode(
        resultType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      );

      // Register the result Type in typeRegistry
      if (resultTypeNode && options.typeRegistry) {
        options.typeRegistry.set(resultTypeNode, resultType);
      }
    }
  }

  // Add original input parameter if needed
  if (!hadZeroParameters) {
    const originalParam = callback.parameters[0];
    if (originalParam) {
      builder.addParameter(
        originalInputParamName,
        normalizeBindingName(originalParam.name, factory, new Set()),
        originalInputParamName,
        originalParam.initializer,
      );
    }
  }

  // Build the new callback
  const originalCallback = ts.getOriginalNode(callback) as
    | ts.ArrowFunction
    | ts.FunctionExpression;
  const hasExplicitReturnType = originalCallback.type &&
    originalCallback.type.pos >= 0;

  const newCallback = builder.buildCallback(
    callback,
    rewrittenBody,
    null, // derive merges captures into top-level object
    hasExplicitReturnType ? resultTypeNode : null,
  );
  setParentPointers(newCallback);

  // Build TypeNodes for schema generation
  const schemaFactory = new SchemaFactory(context);
  registerMergedInputIdentifierTypes(
    mergedInput,
    captureTree,
    captureNameMap,
    checker,
    context.options.typeRegistry,
  );
  let inputTypeNode = schemaFactory.createDeriveInputSchema(
    originalInputParamName,
    originalInput,
    captureTree,
    captureNameMap,
    hadZeroParameters,
  );
  inputTypeNode = refineUnknownInputMembersFromMergedInput(
    inputTypeNode,
    mergedInput,
    context,
  );

  let inputType: ts.Type | undefined;
  try {
    inputType = checker.getTypeAtLocation(mergedInput);
  } catch {
    inputType = undefined;
  }

  const capabilitySummary = analyzeFunctionCapabilities(newCallback);
  const inputParamSummary = capabilitySummary.params[0];
  if (inputParamSummary) {
    inputTypeNode = tryShrinkMergedInputTypeLiteralMembers(
      inputTypeNode,
      inputParamSummary,
      originalInputParamName,
      originalInput,
      captureTree,
      captureNameMap,
      hadZeroParameters,
      checker,
      context.sourceFile,
      factory,
    ) ??
      applyShrinkAndWrap(
        inputParamSummary,
        inputTypeNode,
        inputType,
        false,
        checker,
        context.sourceFile,
        factory,
      );
  }

  // Build the derive call expression
  const deriveExpr = context.ctHelpers.getHelperExpr("derive");

  const newDeriveCall = factory.createCallExpression(
    deriveExpr,
    hasTypeParameter
      ? undefined
      : (resultTypeNode ? [inputTypeNode, resultTypeNode] : [inputTypeNode]),
    [mergedInput, newCallback],
  );
  setParentPointers(newDeriveCall, deriveCall.parent);

  // Register the type of the derive call expression itself
  if (options.typeRegistry) {
    registerDeriveCallType(
      newDeriveCall,
      resultTypeNode,
      resultType,
      checker,
      options.typeRegistry,
    );
  }

  return newDeriveCall;
}
