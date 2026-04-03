import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import {
  buildCapturePropertyAssignments,
  type CaptureTreeNode,
} from "../../utils/capture-tree.ts";
import { PatternBuilder } from "./pattern-builder.ts";

export function buildCaptureParamsObject(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);
  return factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );
}

export function buildCapturedHandlerClosureCall(
  originalNode: ts.Node,
  callback: ts.ArrowFunction,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, CaptureTreeNode>,
  eventTypeNode: ts.TypeNode,
  stateTypeNode: ts.TypeNode,
  context: TransformationContext,
  options?: {
    readonly eventParamName?: string;
    readonly paramsParamName?: string;
  },
): ts.CallExpression {
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);

  const handlerCallback = builder.buildHandlerCallback(
    callback,
    transformedBody,
    options?.eventParamName ?? "event",
    options?.paramsParamName ?? "params",
  );

  const handlerCall = context.cfHelpers.createHelperCall(
    "handler",
    originalNode,
    [eventTypeNode, stateTypeNode],
    [handlerCallback],
  );

  return context.factory.createCallExpression(
    handlerCall,
    undefined,
    [buildCaptureParamsObject(captureTree, context.factory)],
  );
}
