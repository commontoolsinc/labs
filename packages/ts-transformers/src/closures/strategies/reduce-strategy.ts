import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { detectCallKind, isFunctionLikeExpression } from "../../ast/mod.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { RecipeBuilder } from "../utils/recipe-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

export class ReduceStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) && isReduceCall(node, context);
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformReduceCall(node, context, visitor);
  }
}

/**
 * Check if a call expression is a reduce() call from commontools
 */
export function isReduceCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "reduce";
}

/**
 * Extract the reducer callback function from a reduce call.
 * Reduce has two signatures:
 * - 3-arg: reduce(list, initial, reducer)
 * - 5-arg: reduce(listSchema, resultSchema, list, initial, reducer)
 */
function extractReduceCallback(
  reduceCall: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const args = reduceCall.arguments;

  // 3-arg form: reducer is at index 2
  if (args.length === 3) {
    const callback = args[2];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  // 5-arg form: reducer is at index 4
  if (args.length === 5) {
    const callback = args[4];
    if (callback && isFunctionLikeExpression(callback)) {
      return callback;
    }
  }

  return undefined;
}

/**
 * Resolve capture name collisions with the reducer parameter names.
 * Returns a mapping from original capture names to their potentially renamed versions.
 */
function resolveReduceCaptureNameCollisions(
  usedNames: Set<string>,
  captureTree: Map<string, CaptureTreeNode>,
): Map<string, string> {
  const captureNameMap = new Map<string, string>();
  const allUsedNames = new Set(usedNames);

  for (const [captureName] of captureTree) {
    if (allUsedNames.has(captureName)) {
      // Collision detected - rename the capture
      let renamed = `${captureName}_1`;
      let suffix = 1;
      while (allUsedNames.has(renamed) || captureTree.has(renamed)) {
        suffix++;
        renamed = `${captureName}_${suffix}`;
      }
      captureNameMap.set(captureName, renamed);
      allUsedNames.add(renamed);
    } else {
      // No collision - use original name
      captureNameMap.set(captureName, captureName);
      allUsedNames.add(captureName);
    }
  }

  return captureNameMap;
}

/**
 * Build the merged input object containing list, initial value, and captures.
 * Example: {list, initial, multiplier} where multiplier is a capture.
 */
function buildReduceInputObject(
  listExpr: ts.Expression,
  initialExpr: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];

  // Add list as a property
  if (ts.isIdentifier(listExpr) && listExpr.text === "list") {
    properties.push(
      factory.createShorthandPropertyAssignment(listExpr, undefined),
    );
  } else {
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName("list", factory),
        listExpr,
      ),
    );
  }

  // Add initial as a property
  if (ts.isIdentifier(initialExpr) && initialExpr.text === "initial") {
    properties.push(
      factory.createShorthandPropertyAssignment(initialExpr, undefined),
    );
  } else {
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName("initial", factory),
        initialExpr,
      ),
    );
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
 */
function rewriteCaptureReferences(
  body: ts.ConciseBody,
  captureNameMap: Map<string, string>,
  factory: ts.NodeFactory,
): ts.ConciseBody {
  const substitutions = new Map<string, string>();
  for (const [originalName, renamedName] of captureNameMap) {
    if (originalName !== renamedName) {
      substitutions.set(originalName, renamedName);
    }
  }

  if (substitutions.size === 0) {
    return body;
  }

  const visitor = (node: ts.Node, parent?: ts.Node): ts.Node => {
    if (ts.isShorthandPropertyAssignment(node)) {
      const substituteName = substitutions.get(node.name.text);
      if (substituteName) {
        return factory.createPropertyAssignment(
          node.name,
          factory.createIdentifier(substituteName),
        );
      }
      return node;
    }

    if (ts.isIdentifier(node)) {
      if (
        parent && ts.isPropertyAccessExpression(parent) && parent.name === node
      ) {
        return node;
      }
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
 * Transform a reduce call that has closures in its reducer.
 *
 * The key insight is that reduce() internally uses lift(), so we need to
 * transform the reduce call to pass captures as additional inputs that
 * get woven into the lift's input object.
 *
 * Converts: reduce(list, 0, (acc, item) => acc + item * multiplier.get())
 * To: reduce({list, initial: 0, multiplier}, ({ list, initial, multiplier }) =>
 *       list.reduce((acc, item) => acc + item * multiplier, initial))
 *
 * Note: The runtime reduce() function is designed to receive the merged input
 * object and reconstruct the reduce operation.
 */
export function transformReduceCall(
  reduceCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker } = context;

  // Extract reducer callback
  const callback = extractReduceCallback(reduceCall);
  if (!callback) {
    return undefined;
  }

  // Collect captures from the reducer
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

  // Determine list and initial expressions
  const args = reduceCall.arguments;
  let listExpr: ts.Expression | undefined;
  let initialExpr: ts.Expression | undefined;

  if (args.length === 3) {
    // 3-arg form: reduce(list, initial, reducer)
    listExpr = args[0];
    initialExpr = args[1];
  } else if (args.length === 5) {
    // 5-arg form: reduce(listSchema, resultSchema, list, initial, reducer)
    listExpr = args[2];
    initialExpr = args[3];
  } else {
    return undefined;
  }

  if (!listExpr || !initialExpr) {
    return undefined;
  }

  // Collect parameter names from the reducer callback
  const usedNames = new Set<string>(["list", "initial"]);
  for (const param of callback.parameters) {
    if (ts.isIdentifier(param.name)) {
      usedNames.add(param.name.text);
    }
  }

  // Resolve capture name collisions
  const captureNameMap = resolveReduceCaptureNameCollisions(
    usedNames,
    captureTree,
  );

  // Rewrite the body to use renamed capture identifiers
  const rewrittenBody = rewriteCaptureReferences(
    transformedBody,
    captureNameMap,
    factory,
  );

  // Build merged input object
  const mergedInput = buildReduceInputObject(
    listExpr,
    initialExpr,
    captureTree,
    captureNameMap,
    factory,
  );

  // Build the new reducer callback with captures available
  // The reducer callback stays mostly the same, but captures are now available
  // as local variables that will be extracted from the merged input
  const newReducerParams: ts.ParameterDeclaration[] = [];

  // Preserve original reducer parameters (acc, item, index)
  for (const param of callback.parameters) {
    newReducerParams.push(param);
  }

  const equalsGreaterThanToken = ts.isArrowFunction(callback)
    ? callback.equalsGreaterThanToken
    : factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken);

  const newReducer = factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    newReducerParams,
    callback.type,
    equalsGreaterThanToken,
    rewrittenBody,
  );

  // Build the new reduce call with captures
  // We need to wrap the reducer in a way that captures are available
  // This is done by creating a lift-based wrapper

  // Build the wrapper function that receives the merged input
  const wrapperParamBindings: ts.BindingElement[] = [];

  // Add list and initial bindings
  wrapperParamBindings.push(
    factory.createBindingElement(undefined, undefined, factory.createIdentifier("list"), undefined),
  );
  wrapperParamBindings.push(
    factory.createBindingElement(undefined, undefined, factory.createIdentifier("initial"), undefined),
  );

  // Add capture bindings
  for (const [originalName] of captureTree) {
    const renamedName = captureNameMap.get(originalName) ?? originalName;
    if (originalName !== renamedName) {
      wrapperParamBindings.push(
        factory.createBindingElement(
          undefined,
          factory.createIdentifier(originalName),
          factory.createIdentifier(renamedName),
          undefined,
        ),
      );
    } else {
      wrapperParamBindings.push(
        factory.createBindingElement(undefined, undefined, factory.createIdentifier(originalName), undefined),
      );
    }
  }

  const wrapperParam = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(wrapperParamBindings),
    undefined,
    undefined,
    undefined,
  );

  // Build the wrapper body with null check:
  // (!list || !Array.isArray(list)) ? initial : list.reduce(reducer, initial)
  const reduceMethodCall = factory.createConditionalExpression(
    factory.createBinaryExpression(
      factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        factory.createIdentifier("list"),
      ),
      ts.SyntaxKind.BarBarToken,
      factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("Array"),
            "isArray",
          ),
          undefined,
          [factory.createIdentifier("list")],
        ),
      ),
    ),
    factory.createToken(ts.SyntaxKind.QuestionToken),
    factory.createIdentifier("initial"),
    factory.createToken(ts.SyntaxKind.ColonToken),
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier("list"),
        "reduce",
      ),
      undefined,
      [newReducer, factory.createIdentifier("initial")],
    ),
  );

  // Build the full wrapper arrow function
  const wrapperFn = factory.createArrowFunction(
    undefined,
    undefined,
    [wrapperParam],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    reduceMethodCall,
  );

  // Build the lift call: lift(wrapperFn)(mergedInput)
  const liftExpr = context.ctHelpers.getHelperExpr("lift");

  const liftCall = factory.createCallExpression(
    liftExpr,
    undefined,
    [wrapperFn],
  );

  const newReduceCall = factory.createCallExpression(
    liftCall,
    undefined,
    [mergedInput],
  );

  return newReduceCall;
}
