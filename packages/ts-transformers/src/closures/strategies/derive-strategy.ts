import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { detectCallKind, isFunctionLikeExpression } from "../../ast/mod.ts";
import { registerDeriveCallType } from "../../ast/type-inference.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { RecipeBuilder } from "../utils/recipe-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

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
 */
function rewriteCaptureReferences(
  body: ts.ConciseBody,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
): ts.ConciseBody {
  // Build a reverse map: original capture name -> list of renamed names that should be substituted
  const substitutions = new Map<string, string>();
  for (const [originalName, renamedName] of captureNameMap) {
    if (originalName !== renamedName) {
      substitutions.set(originalName, renamedName);
    }
  }

  if (substitutions.size === 0) {
    return body; // No substitutions needed
  }

  const visitor = (node: ts.Node, parent?: ts.Node): ts.Node => {
    // Handle shorthand property assignments specially
    // { multiplier } needs to become { multiplier: multiplier_1 } if multiplier is renamed
    if (ts.isShorthandPropertyAssignment(node)) {
      const substituteName = substitutions.get(node.name.text);
      if (substituteName) {
        // Expand shorthand into full property assignment
        return factory.createPropertyAssignment(
          node.name, // Property name stays the same
          factory.createIdentifier(substituteName), // Value uses renamed identifier
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
        return factory.createIdentifier(substituteName);
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
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    factory,
  );

  // Initialize RecipeBuilder
  const builder = new RecipeBuilder(context);
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

  // Build TypeNodes for schema generation
  const schemaFactory = new SchemaFactory(context);
  const inputTypeNode = schemaFactory.createDeriveInputSchema(
    originalInputParamName,
    originalInput,
    captureTree,
    captureNameMap,
    hadZeroParameters,
  );

  // Build the derive call expression
  const deriveExpr = context.ctHelpers.getHelperExpr("derive");

  const newDeriveCall = factory.createCallExpression(
    deriveExpr,
    hasTypeParameter
      ? undefined
      : (resultTypeNode ? [inputTypeNode, resultTypeNode] : [inputTypeNode]),
    [mergedInput, newCallback],
  );

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
