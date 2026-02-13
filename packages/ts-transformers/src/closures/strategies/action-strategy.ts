import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { detectCallKind, registerSyntheticCallType } from "../../ast/mod.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { PatternBuilder } from "../utils/pattern-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";
import { buildCapturePropertyAssignments } from "./map-strategy.ts";
import { unwrapArrowFunction } from "../utils/ast-helpers.ts";

/**
 * ActionStrategy transforms action() calls to handler() calls with explicit closures.
 *
 * This is to handler as computed is to lift/derive:
 * - Input: action(() => count.set(count.get() + 1))
 * - Output: handler((_, { count }) => count.set(count.get() + 1))({ count })
 *
 * The action callback takes zero or one parameters (optional event) and closes
 * over scope variables. The transformer extracts these closures and makes them
 * explicit as handler params.
 *
 * Examples:
 * - action(() => doSomething())           → no event, schema is false
 * - action((e) => doSomething(e.target))  → has event, schema is inferred
 *
 * ## Limitation: Arrow Functions Only
 *
 * Currently only arrow functions are supported, not function expressions.
 * This matches the behavior of HandlerStrategy for JSX event handlers.
 *
 * Supported:     action(() => count.set(count.get() + 1))
 * NOT supported: action(function() { count.set(count.get() + 1) })
 *
 * To support function expressions in the future:
 * 1. Update PatternBuilder.buildHandlerCallback to accept FunctionExpression
 *    (currently typed as ArrowFunction only)
 * 2. Update this strategy to use isFunctionLikeExpression instead of unwrapArrowFunction
 * 3. Potentially update HandlerStrategy for consistency
 * 4. Add test cases for function expression callbacks
 */
export class ActionStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) && isActionCall(node, context);
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformActionCall(node, context, visitor);
  }
}

/**
 * Check if a call expression is an action() call from commontools
 */
function isActionCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "builder" && callKind.builderName === "action";
}

/**
 * Extract the callback function from an action call.
 * Action has one signature: action(callback)
 *
 * Note: Only arrow functions are supported (see class doc for limitation details).
 */
function extractActionCallback(
  actionCall: ts.CallExpression,
): ts.ArrowFunction | undefined {
  const args = actionCall.arguments;

  if (args.length === 1) {
    const callback = args[0];
    if (callback) {
      return unwrapArrowFunction(callback);
    }
  }

  return undefined;
}

/**
 * Transform an action call to a handler call with explicit closures.
 * Converts: action(() => count.set(count.get() + 1))
 * To: handler((_, { count }) => count.set(count.get() + 1))({ count })
 */
function transformActionCall(
  actionCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker } = context;

  // Extract callback
  const callback = extractActionCallback(actionCall);
  if (!callback) {
    return undefined;
  }

  // Recursively transform the callback body first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Collect captures
  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyze(callback);

  // Initialize PatternBuilder
  const builder = new PatternBuilder(context);
  builder.setCaptureTree(captureTree);

  // Determine event parameter name:
  // - If callback has an event param, preserve its name
  // - Otherwise use "_" to indicate unused
  const eventParam = callback.parameters[0];
  const eventParamName = eventParam && ts.isIdentifier(eventParam.name)
    ? eventParam.name.text
    : "_";

  // Build the handler callback with (event, params) signature
  const handlerCallback = builder.buildHandlerCallback(
    callback,
    transformedBody,
    eventParamName,
    "__ct_action_params",
  );

  // Build type information for handler params using SchemaFactory
  const schemaFactory = new SchemaFactory(context);

  // For action, event parameter is optional:
  // - action(() => ...) → event schema is `false` (never type)
  // - action((e) => ...) → event schema is inferred from the parameter
  const eventTypeNode = callback.parameters.length > 0
    ? schemaFactory.createHandlerEventSchema(callback)
    : schemaFactory.createActionEventSchema();

  // State schema is based on captures
  const stateTypeNode = schemaFactory.createHandlerStateSchema(
    captureTree,
    undefined, // no explicit state parameter in action
  );

  // Build the handler call: handler<void, StateType>(callback)
  const handlerExpr = context.ctHelpers.getHelperExpr("handler");
  const handlerCall = factory.createCallExpression(
    handlerExpr,
    [eventTypeNode, stateTypeNode],
    [handlerCallback],
  );

  // Build the params object: { count, ... }
  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);
  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  // Build the final call: handler(...)({ captures })
  const finalCall = factory.createCallExpression(
    handlerCall,
    undefined,
    [paramsObject],
  );

  // Register the return type in the TypeRegistry for schema inference.
  // This enables SchemaInjectionTransformer to correctly infer the pattern's result type
  // when an action is returned as a property (e.g., return { inc: action(...) }).
  // Without this registration, the synthetic handler call has no type information,
  // resulting in an empty result schema for the pattern.
  //
  // Note: The action call has type `ModuleFactory<T, Stream<void>>`, but the finalCall
  // is `handler(...)({...})` which CALLS the factory. We need the return type of that call,
  // which is `OpaqueRef<Stream<void>>`.
  const typeRegistry = context.options.typeRegistry;
  if (typeRegistry) {
    // Get the type of the original action call (ModuleFactory<T, Stream<void>>)
    const actionType = checker.getTypeAtLocation(actionCall);
    // Get the call signature to find what type is returned when calling the factory
    const callSignatures = actionType.getCallSignatures();
    if (callSignatures.length > 0) {
      const callReturnType = callSignatures[0]!.getReturnType();
      // This should be OpaqueRef<Stream<void>> - the type of calling handler(...)({...})
      registerSyntheticCallType(finalCall, callReturnType, typeRegistry);
    }
  }

  return finalCall;
}
