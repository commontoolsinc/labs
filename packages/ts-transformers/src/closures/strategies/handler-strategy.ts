import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { isEventHandlerJsxAttribute } from "../../ast/mod.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { unwrapArrowFunction } from "../utils/ast-helpers.ts";
import { buildCapturePropertyAssignments } from "./map-strategy.ts";
import { RecipeBuilder } from "../utils/recipe-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

export class HandlerStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    _context: TransformationContext,
  ): boolean {
    if (ts.isJsxAttribute(node)) {
      return isEventHandlerJsxAttribute(node.name);
    }
    return false;
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (ts.isJsxAttribute(node)) {
      return transformHandlerJsxAttribute(node, context, visitor);
    }
    return undefined;
  }
}

export function transformHandlerJsxAttribute(
  attribute: ts.JsxAttribute,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.JsxAttribute | undefined {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer)) {
    return undefined;
  }

  const expression = initializer.expression;
  if (!expression) {
    return undefined;
  }

  const callback = unwrapArrowFunction(expression);
  if (!callback) {
    return undefined;
  }

  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  const collector = new CaptureCollector(context.checker);
  const { captureTree } = collector.analyze(callback);

  // Initialize RecipeBuilder
  const builder = new RecipeBuilder(context);
  builder.setCaptureTree(captureTree);

  // Register capture names as used to avoid collision with event parameter
  // MOVED: This logic is now handled inside RecipeBuilder.buildHandlerCallback
  // to prevent captures from colliding with themselves.

  // Build the new callback using buildHandlerCallback
  const handlerCallback = builder.buildHandlerCallback(
    callback,
    transformedBody,
    "__ct_handler_event",
    "__ct_handler_params",
  );

  const { factory } = context;

  // Build type information for handler params using SchemaFactory
  const schemaFactory = new SchemaFactory(context);
  const eventTypeNode = schemaFactory.createHandlerEventSchema(callback);
  const stateTypeNode = schemaFactory.createHandlerStateSchema(
    captureTree,
    callback.parameters[1] as ts.ParameterDeclaration | undefined,
  );

  const handlerExpr = context.ctHelpers.getHelperExpr("handler");
  const handlerCall = factory.createCallExpression(
    handlerExpr,
    [eventTypeNode, stateTypeNode],
    [handlerCallback],
  );

  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);

  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  const finalCall = factory.createCallExpression(
    handlerCall,
    undefined,
    [paramsObject],
  );

  const newInitializer = factory.createJsxExpression(
    initializer.dotDotDotToken,
    finalCall,
  );

  return factory.createJsxAttribute(attribute.name, newInitializer);
}

/**
 * Transform explicit handler() calls.
 * This is less common than JSX attributes but supported.
 */
export function transformHandlerCall(
  _node: ts.CallExpression,
  _context: TransformationContext,
  _visitor: ts.Visitor,
): ts.CallExpression | undefined {
  // Implementation for explicit handler calls
  // Currently the transformer only handles JSX attributes explicitly
  // But we can add support here if needed.
  // For now, return undefined as the original transformer didn't have a dedicated
  // transformHandlerCall function (it was handled via JSX attribute visitor).
  return undefined;
}
