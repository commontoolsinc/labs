import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { buildCapturePropertyAssignments } from "../../utils/capture-tree.ts";
import {
  detectCallKind,
  isCellLikeType,
  isFunctionLikeExpression,
} from "../../ast/mod.ts";
import { createModuleScopedReactiveCaptureCollector } from "../capture-collector.ts";
import { buildCallbackWithTopLevelCaptures } from "../utils/pattern-builder.ts";

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
  const collector = createModuleScopedReactiveCaptureCollector(
    context.checker,
    (_identifier, type, checker) => isCellLikeType(type, checker),
  );
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
  const newCallback = buildCallbackWithTopLevelCaptures(
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
