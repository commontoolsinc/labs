import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  detectCallKind,
  ensureTypeNodeRegistered,
  isCellLikeType,
  isFunctionLikeExpression,
} from "../../ast/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { buildCapturePropertyAssignments } from "../utils/capture-scaffold.ts";

/**
 * PatternToolStrategy transforms patternTool() calls to capture closed-over variables.
 *
 * This strategy allows standalone functions passed to patternTool() to close over
 * reactive values, which are then automatically added to the extraParams object.
 *
 * Input:
 * ```ts
 * const content = cell("Hello");
 * const grepTool = patternTool(
 *   ({ query }: { query: string }) => {
 *     return derive({ query }, ({ query }) => {
 *       return content.split("\n").filter((c) => c.includes(query));
 *     });
 *   }
 * );
 * ```
 *
 * Output:
 * ```ts
 * const content = cell("Hello");
 * const grepTool = patternTool(
 *   ({ query, content }: { query: string; content: string }) => {
 *     return derive({ query }, ({ query }) => {
 *       return content.split("\n").filter((c) => c.includes(query));
 *     });
 *   },
 *   { content }
 * );
 * ```
 *
 * The strategy:
 * 1. Detects patternTool(fn) or patternTool(fn, extraParams) calls
 * 2. Collects captures from the function body
 * 3. Merges captures into the extraParams object
 * 4. Updates the function's parameter type to include captured variables
 */
export class PatternToolStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callKind = detectCallKind(node, context.checker);
    return callKind?.kind === "pattern-tool";
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformPatternToolCall(node, context, visitor);
  }
}

/**
 * Transform a patternTool call to include captured variables in extraParams.
 */
function transformPatternToolCall(
  patternToolCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory } = context;

  // Get the callback function (first argument)
  const callback = patternToolCall.arguments[0];
  if (!callback || !isFunctionLikeExpression(callback)) {
    return undefined;
  }

  // Collect module-scoped reactive captures from the callback
  // Unlike the default closure strategies, patternTool only wants
  // module-scoped reactive identifier captures in extraParams.
  const collector = new CaptureCollector(context.checker, {
    captureNonModuleExternalIdentifiers: false,
    captureNonModuleExternalPropertyAccesses: false,
    captureModuleScopedIdentifierWhen: (_identifier, type, checker) =>
      isCellLikeType(type, checker),
  });
  const { captures: captureExpressions, captureTree } = collector.analyze(
    callback,
  );

  // If no captures, no transformation needed
  if (captureExpressions.size === 0) {
    return undefined;
  }

  // Transform the callback body (recursively handle nested closures)
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Get existing extraParams (second argument) if present
  const existingExtraParams = patternToolCall.arguments[1];

  // Build the merged extraParams object
  const captureProperties = buildCapturePropertyAssignments(
    captureTree,
    factory,
  );

  // Merge with existing extraParams if present
  let mergedExtraParams: ts.Expression;
  if (
    existingExtraParams && ts.isObjectLiteralExpression(existingExtraParams)
  ) {
    // Merge: captures take precedence over existing properties with the same name
    const existingProperties = existingExtraParams.properties.filter((prop) => {
      // Skip properties that are being captured (captures win)
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        return !captureTree.has(prop.name.text);
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        return !captureTree.has(prop.name.text);
      }
      return true;
    });

    mergedExtraParams = factory.createObjectLiteralExpression(
      [...captureProperties, ...existingProperties],
      captureProperties.length + existingProperties.length > 1,
    );
  } else if (existingExtraParams) {
    // Existing extraParams is a reference or complex expression
    // Use spread to merge: { ...captures, ...existingExtraParams }
    mergedExtraParams = factory.createObjectLiteralExpression(
      [
        ...captureProperties,
        factory.createSpreadAssignment(existingExtraParams),
      ],
      true,
    );
  } else {
    // No existing extraParams, just use captures
    mergedExtraParams = factory.createObjectLiteralExpression(
      captureProperties,
      captureProperties.length > 1,
    );
  }

  // Build the new callback with updated parameter type
  // We need to add the captured variables to the parameter's type
  const newCallback = buildCallbackWithCaptures(
    callback,
    transformedBody,
    captureTree,
    context,
  );

  // Build the new patternTool call with the transformed callback and merged extraParams
  const newArgs: ts.Expression[] = [newCallback, mergedExtraParams];

  return factory.createCallExpression(
    patternToolCall.expression,
    patternToolCall.typeArguments,
    newArgs,
  );
}

/**
 * Build a new callback function with captured variables added to its parameter type.
 *
 * Original: ({ query }: { query: string }) => { ... }
 * With captures: ({ query, content }: { query: string; content: string }) => { ... }
 */
function buildCallbackWithCaptures(
  originalCallback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.ArrowFunction | ts.FunctionExpression {
  const { factory } = context;

  // Get the original parameter (patternTool callbacks take a single parameter)
  const originalParam = originalCallback.parameters[0];

  // Build new parameter with captures added
  let newParam: ts.ParameterDeclaration;

  if (originalParam) {
    // Get the existing parameter binding pattern
    const existingBinding = originalParam.name;

    if (ts.isObjectBindingPattern(existingBinding)) {
      // Add capture bindings to the existing object pattern
      const newBindingElements = [...existingBinding.elements];

      for (const captureName of captureTree.keys()) {
        // Check if this capture is already in the binding
        const alreadyExists = existingBinding.elements.some((element) => {
          if (ts.isIdentifier(element.name)) {
            return element.name.text === captureName;
          }
          return false;
        });

        if (!alreadyExists) {
          newBindingElements.push(
            factory.createBindingElement(
              undefined,
              undefined,
              factory.createIdentifier(captureName),
              undefined,
            ),
          );
        }
      }

      const newBindingPattern = factory.createObjectBindingPattern(
        newBindingElements,
      );

      // Update the type annotation if present
      let newTypeNode = originalParam.type;
      if (newTypeNode && ts.isTypeLiteralNode(newTypeNode)) {
        newTypeNode = addCapturesToTypeLiteral(
          newTypeNode,
          captureTree,
          context,
        );
      }

      newParam = factory.createParameterDeclaration(
        originalParam.modifiers,
        originalParam.dotDotDotToken,
        newBindingPattern,
        originalParam.questionToken,
        newTypeNode,
        originalParam.initializer,
      );
    } else {
      // Parameter is a simple identifier or other binding, keep as-is
      newParam = originalParam;
    }
  } else {
    // No original parameter, create one with just captures
    const bindingElements = Array.from(captureTree.keys()).map((captureName) =>
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier(captureName),
        undefined,
      )
    );

    const bindingPattern = factory.createObjectBindingPattern(bindingElements);

    // Build type literal for captures
    const typeElements = Array.from(captureTree.keys()).map((captureName) => {
      return factory.createPropertySignature(
        undefined,
        factory.createIdentifier(captureName),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
    });

    const captureTypeNode = factory.createTypeLiteralNode(typeElements);
    ensureTypeNodeRegistered(
      captureTypeNode,
      context.checker,
      context.options.typeRegistry,
    );

    newParam = factory.createParameterDeclaration(
      undefined,
      undefined,
      bindingPattern,
      undefined,
      captureTypeNode,
      undefined,
    );
  }

  // Create the new callback
  if (ts.isArrowFunction(originalCallback)) {
    return factory.createArrowFunction(
      originalCallback.modifiers,
      originalCallback.typeParameters,
      [newParam],
      originalCallback.type,
      originalCallback.equalsGreaterThanToken,
      transformedBody,
    );
  } else {
    return factory.createFunctionExpression(
      originalCallback.modifiers,
      originalCallback.asteriskToken,
      originalCallback.name,
      originalCallback.typeParameters,
      [newParam],
      originalCallback.type,
      ts.isBlock(transformedBody)
        ? transformedBody
        : factory.createBlock([factory.createReturnStatement(transformedBody)]),
    );
  }
}

/**
 * Add captured variable types to a type literal node.
 */
function addCapturesToTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.TypeLiteralNode {
  const { factory } = context;

  // Get existing members
  const existingMembers = [...typeLiteral.members];

  // Add type for each capture
  for (const [captureName] of captureTree) {
    // Check if this property already exists
    const alreadyExists = existingMembers.some((member) => {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
        return member.name.text === captureName;
      }
      return false;
    });

    if (!alreadyExists) {
      // Add a property signature for the capture
      // We use 'unknown' as a placeholder type since we don't have precise type info
      existingMembers.push(
        factory.createPropertySignature(
          undefined,
          factory.createIdentifier(captureName),
          undefined,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
      );
    }
  }

  const typeNode = factory.createTypeLiteralNode(existingMembers);
  ensureTypeNodeRegistered(
    typeNode,
    context.checker,
    context.options.typeRegistry,
  );
  return typeNode;
}
