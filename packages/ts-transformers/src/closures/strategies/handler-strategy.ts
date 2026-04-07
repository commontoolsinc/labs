import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { isEventHandlerJsxAttribute } from "../../ast/mod.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { unwrapArrowFunction } from "../utils/ast-helpers.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";
import { buildCapturedHandlerClosureCall } from "../utils/capture-scaffold.ts";

export class HandlerStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    if (ts.isJsxAttribute(node)) {
      return isEventHandlerJsxAttribute(node.name, context.checker);
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
  const { factory } = context;

  // Build type information for handler params using SchemaFactory
  const schemaFactory = new SchemaFactory(context);
  const eventTypeNode = schemaFactory.createHandlerEventSchema(callback);
  const stateTypeNode = schemaFactory.createHandlerStateSchema(
    captureTree,
    callback.parameters[1] as ts.ParameterDeclaration | undefined,
  );

  const finalCall = buildCapturedHandlerClosureCall(
    expression,
    callback,
    transformedBody,
    captureTree,
    eventTypeNode,
    stateTypeNode,
    context,
    {
      eventParamName: "__cf_handler_event",
      paramsParamName: "__cf_handler_params",
    },
  );

  const newInitializer = factory.createJsxExpression(
    initializer.dotDotDotToken,
    finalCall,
  );

  return factory.createJsxAttribute(attribute.name, newInitializer);
}
