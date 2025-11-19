import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  detectCallKind,
  isFunctionLikeExpression,
  isOptionalPropertyAccess,
} from "../../ast/mod.ts";
import { registerDeriveCallType } from "../../ast/type-inference.ts";
import {
  buildTypeElementsFromCaptureTree,
  expressionToTypeNode,
} from "../../ast/type-building.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  createPropertyName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import { normalizeBindingName } from "../computed-aliases.ts";
import { CaptureCollector } from "../capture-collector.ts";

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
    // Use shorthand if the original input is a simple identifier matching the param name
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
 * Create the derive callback with parameter aliasing to preserve user's parameter name.
 * Example: ({value: v, multiplier}) => v * multiplier
 *
 * When hadZeroParameters is true, build a parameter from just the captures (no original input).
 * This handles the case where user wrote derive({}, () => ...) with captures.
 */
function createDeriveCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  originalInputParamName: string,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  context: TransformationContext,
  hadZeroParameters: boolean,
): ts.ArrowFunction | ts.FunctionExpression {
  const { factory } = context;
  const usedBindingNames = new Set<string>();

  // Get the original parameter
  const originalParam = callback.parameters[0];
  if (!originalParam) {
    // No parameter - if there are captures, build parameter from captures only
    if (hadZeroParameters && captureTree.size > 0) {
      // Build binding elements from just the captures (no original input)
      const createBindingIdentifier = (name: string): ts.Identifier => {
        return reserveIdentifier(name, usedBindingNames, factory);
      };

      const bindingElements = createBindingElementsFromNames(
        captureTree.keys(),
        factory,
        createBindingIdentifier,
      );

      const destructuredParam = factory.createParameterDeclaration(
        undefined, // modifiers
        undefined, // dotDotDotToken
        factory.createObjectBindingPattern(bindingElements),
        undefined, // questionToken
        undefined, // type
        undefined, // initializer
      );

      return ts.isArrowFunction(callback)
        ? factory.createArrowFunction(
          callback.modifiers,
          callback.typeParameters,
          [destructuredParam],
          undefined, // No return type - rely on inference
          callback.equalsGreaterThanToken,
          transformedBody,
        )
        : factory.createFunctionExpression(
          callback.modifiers,
          callback.asteriskToken,
          callback.name,
          callback.typeParameters,
          [destructuredParam],
          undefined, // No return type - rely on inference
          transformedBody as ts.Block,
        );
    }

    // No parameter and no captures (or not hadZeroParameters) - shouldn't happen, but handle gracefully
    return ts.isArrowFunction(callback)
      ? factory.createArrowFunction(
        callback.modifiers,
        callback.typeParameters,
        [],
        callback.type,
        callback.equalsGreaterThanToken,
        transformedBody,
      )
      : factory.createFunctionExpression(
        callback.modifiers,
        callback.asteriskToken,
        callback.name,
        callback.typeParameters,
        [],
        callback.type,
        transformedBody as ts.Block,
      );
  }

  // Build the binding elements for the destructured parameter
  const bindingElements: ts.BindingElement[] = [];

  // Create binding for original input with alias to preserve user's parameter name
  const originalParamBinding = normalizeBindingName(
    originalParam.name,
    factory,
    usedBindingNames,
  );

  bindingElements.push(
    factory.createBindingElement(
      undefined,
      factory.createIdentifier(originalInputParamName), // Property name
      originalParamBinding, // Binding name (what it's called in the function body)
      originalParam.initializer, // Preserve default value if present
    ),
  );

  // Add bindings for captures using the potentially renamed property names
  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  // Create binding elements using the renamed capture names
  const renamedCaptureNames = Array.from(captureTree.keys()).map(
    (originalName) => captureNameMap.get(originalName) ?? originalName,
  );

  bindingElements.push(
    ...createBindingElementsFromNames(
      renamedCaptureNames,
      factory,
      createBindingIdentifier,
    ),
  );

  // Create the parameter with object binding pattern
  const parameter = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(bindingElements),
    undefined,
    undefined, // No type annotation - rely on inference
    undefined,
  );

  // Rewrite the body to use renamed capture identifiers
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    factory,
  );

  // Create the new callback
  if (ts.isArrowFunction(callback)) {
    return factory.createArrowFunction(
      callback.modifiers,
      callback.typeParameters,
      [parameter],
      undefined, // No return type - rely on inference
      callback.equalsGreaterThanToken,
      rewrittenBody,
    );
  } else {
    return factory.createFunctionExpression(
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      [parameter],
      undefined, // No return type - rely on inference
      rewrittenBody as ts.Block,
    );
  }
}

/**
 * Build schema TypeNode for the merged input object.
 * Creates an object schema with properties for input and all captures.
 *
 * When hadZeroParameters is true, skip the input and only include captures.
 */
function buildDeriveInputSchema(
  originalInputParamName: string,
  originalInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  context: TransformationContext,
  hadZeroParameters: boolean,
): ts.TypeNode {
  const { factory, checker } = context;

  // Build type elements for the object schema
  const typeElements: ts.TypeElement[] = [];

  // Add type element for original input UNLESS callback had zero parameters
  if (!hadZeroParameters) {
    // Add type element for original input using the helper function
    const inputTypeNode = expressionToTypeNode(originalInput, context);

    // Check if the original input is an optional property access (e.g., config.multiplier where multiplier?: number)
    let questionToken: ts.QuestionToken | undefined = undefined;
    if (ts.isPropertyAccessExpression(originalInput)) {
      if (isOptionalPropertyAccess(originalInput, checker)) {
        questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
      }
    }

    typeElements.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(originalInputParamName),
        questionToken,
        inputTypeNode,
      ),
    );
  }

  // Add type elements for captures using the existing helper
  const captureTypeElements = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );

  // Rename the property signatures if there are collisions
  for (const typeElement of captureTypeElements) {
    if (
      ts.isPropertySignature(typeElement) && ts.isIdentifier(typeElement.name)
    ) {
      const originalName = typeElement.name.text;
      const renamedName = captureNameMap.get(originalName) ?? originalName;

      if (renamedName !== originalName) {
        // Create a new property signature with the renamed identifier
        typeElements.push(
          factory.createPropertySignature(
            typeElement.modifiers,
            factory.createIdentifier(renamedName),
            typeElement.questionToken,
            typeElement.type,
          ),
        );
      } else {
        // No renaming needed
        typeElements.push(typeElement);
      }
    } else {
      // Not a simple property signature, keep as-is
      typeElements.push(typeElement);
    }
  }

  // Create object type literal
  return factory.createTypeLiteralNode(typeElements);
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
  const { factory } = context;

  // Extract callback
  const callback = extractDeriveCallback(deriveCall);
  if (!callback) {
    return undefined;
  }

  // Collect captures
  const collector = new CaptureCollector(context.checker);
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
  // Extract the identifier name from the input expression (e.g., "value" from `value`)
  // This becomes the property name in the merged object
  let originalInputParamName = "input"; // Fallback for complex expressions

  if (ts.isIdentifier(originalInput)) {
    // Simple identifier input like `value` - use its name
    originalInputParamName = originalInput.text;
  } else if (ts.isPropertyAccessExpression(originalInput)) {
    // Property access like `state.value` - use the property name
    originalInputParamName = originalInput.name.text;
  }
  // For other expressions (object literals, etc.), use "input" fallback

  // Check if callback originally had zero parameters
  // In this case, we don't need to preserve the input - just use captures
  const hadZeroParameters = callback.parameters.length === 0;

  // Resolve capture name collisions with the original input parameter name
  const captureNameMap = resolveDeriveCaptureNameCollisions(
    originalInputParamName,
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

  // Create new callback with parameter aliasing
  const newCallback = createDeriveCallback(
    callback,
    transformedBody,
    originalInputParamName,
    captureTree,
    captureNameMap,
    context,
    hadZeroParameters,
  );

  // Build TypeNodes for schema generation (similar to handlers/maps pattern)
  // These will be registered in typeRegistry for SchemaInjectionTransformer to use
  const inputTypeNode = buildDeriveInputSchema(
    originalInputParamName,
    originalInput,
    captureTree,
    captureNameMap,
    context,
    hadZeroParameters,
  );

  // Infer result type from callback
  // SchemaInjectionTransformer will use this to generate the result schema
  const signature = context.checker.getSignatureFromDeclaration(callback);
  let resultTypeNode: ts.TypeNode | undefined;
  let resultType: ts.Type | undefined;
  let hasTypeParameter = false;

  if (callback.type) {
    // Explicit return type annotation - use it directly (no need to register in typeRegistry)
    resultTypeNode = callback.type;
  } else if (signature) {
    // Infer from callback signature
    resultType = signature.getReturnType();

    // Check if this is an uninstantiated type parameter
    // When inside a generic function, the return type may be the generic parameter itself (e.g., "T")
    const resultFlags = resultType.flags;
    const isTypeParam = (resultFlags & ts.TypeFlags.TypeParameter) !== 0;

    if (isTypeParam) {
      // Mark that we have a type parameter - we'll omit ALL type arguments
      // This lets SchemaInjectionTransformer's expression-based inference handle it
      hasTypeParameter = true;
    } else {
      resultTypeNode = context.checker.typeToTypeNode(
        resultType,
        context.sourceFile,
        ts.NodeBuilderFlags.NoTruncation |
          ts.NodeBuilderFlags.UseStructuralFallback,
      );

      // Register the result Type in typeRegistry for the synthetic TypeNode
      // This fixes schema generation for shorthand properties referencing captured variables
      if (resultTypeNode && context.options.typeRegistry) {
        context.options.typeRegistry.set(resultTypeNode, resultType);
      }
    }
  }

  // Build the derive call expression
  // If we have a type parameter, omit type arguments entirely to let SchemaInjectionTransformer infer from expressions
  // Otherwise, use the 2-arg type argument form which SchemaInjectionTransformer will convert to 4-arg schema form
  const deriveExpr = context.ctHelpers.getHelperExpr("derive");

  const newDeriveCall = factory.createCallExpression(
    deriveExpr,
    hasTypeParameter
      ? undefined
      : (resultTypeNode ? [inputTypeNode, resultTypeNode] : [inputTypeNode]), // Type arguments
    [mergedInput, newCallback], // Runtime arguments
  );

  // Register the type of the derive call expression itself in the typeRegistry
  // so that type inference works correctly for synthetic nodes
  if (context.options.typeRegistry) {
    registerDeriveCallType(
      newDeriveCall,
      resultTypeNode,
      resultType,
      context.checker,
      context.options.typeRegistry,
    );
  }

  return newDeriveCall;
}
