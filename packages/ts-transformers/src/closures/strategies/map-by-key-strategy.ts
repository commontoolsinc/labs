import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import {
  detectCallKind,
  getTypeAtLocationWithFallback,
  isFunctionLikeExpression,
} from "../../ast/mod.ts";
import { buildHierarchicalParamsValue } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  normalizeBindingName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { RecipeBuilder } from "../utils/recipe-builder.ts";
import { SchemaFactory } from "../utils/schema-factory.ts";

export class MapByKeyStrategy implements ClosureTransformationStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) && isMapByKeyCall(node, context);
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) return undefined;
    return transformMapByKeyCall(node, context, visitor);
  }
}

/**
 * Check if a call expression is a mapByKey() call from commontools
 */
export function isMapByKeyCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "mapByKey";
}

/**
 * Extract the callback function from a mapByKey call.
 * mapByKey has two signatures:
 * - 2-arg: mapByKey(list, callback) - identity key
 * - 3-arg: mapByKey(list, keyPath, callback) - property path key
 */
function extractMapByKeyCallback(
  mapByKeyCall: ts.CallExpression,
): { callback: ts.ArrowFunction | ts.FunctionExpression; callbackIndex: number; keyPath: ts.Expression | undefined } | undefined {
  const args = mapByKeyCall.arguments;

  // 2-arg form: callback is at index 1
  if (args.length === 2) {
    const callback = args[1];
    if (callback && isFunctionLikeExpression(callback)) {
      return { callback, callbackIndex: 1, keyPath: undefined };
    }
  }

  // 3-arg form: callback is at index 2, keyPath is at index 1
  if (args.length >= 3) {
    const callback = args[2];
    if (callback && isFunctionLikeExpression(callback)) {
      return { callback, callbackIndex: 2, keyPath: args[1] };
    }
  }

  return undefined;
}

/**
 * Build property assignments for captured variables from a capture tree.
 */
function buildCapturePropertyAssignments(
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): ts.PropertyAssignment[] {
  const properties: ts.PropertyAssignment[] = [];
  for (const [rootName, node] of captureTree) {
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName(rootName, factory),
        buildHierarchicalParamsValue(node, rootName, factory),
      ),
    );
  }
  return properties;
}

/**
 * Transform a mapByKey call that has closures in its callback.
 *
 * Converts: mapByKey(list, (item) => item * multiplier)
 * To: mapByKey(list, recipe(({element, params: {multiplier}}) => element * multiplier), {multiplier})
 *
 * Or with keyPath:
 * mapByKey(list, "id", (item) => item * multiplier)
 * To: mapByKey(list, "id", recipe(...), {multiplier})
 */
export function transformMapByKeyCall(
  mapByKeyCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  const { factory, checker } = context;

  // Extract callback
  const extracted = extractMapByKeyCallback(mapByKeyCall);
  if (!extracted) {
    return undefined;
  }
  const { callback, callbackIndex, keyPath } = extracted;

  // Collect captured variables from the callback
  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyze(callback);

  // Even if no captures, we still want to transform to ensure callback parameters
  // become opaque (element, key, index, array from the builtin)

  // Get callback parameters
  const originalParams = callback.parameters;
  const elemParam = originalParams[0];
  const keyParam = originalParams[1]; // May be undefined
  const indexParam = originalParams[2]; // May be undefined
  const arrayParam = originalParams[3]; // May be undefined

  // Recursively transform any nested callbacks first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Create the recipe callback using RecipeBuilder
  const usedBindingNames = new Set<string>();
  const createBindingIdentifier = (name: string): ts.Identifier => {
    return reserveIdentifier(name, usedBindingNames, factory);
  };

  // Initialize RecipeBuilder
  const builder = new RecipeBuilder(context);
  builder.registerUsedNames(usedBindingNames);
  builder.setCaptureTree(captureTree);

  // Get element binding name
  let elementBindingName: ts.BindingName;
  if (elemParam) {
    elementBindingName = normalizeBindingName(elemParam.name, factory, usedBindingNames);
  } else {
    elementBindingName = createBindingIdentifier("element");
  }

  // Add element parameter
  builder.addParameter(
    "element",
    elementBindingName,
    ts.isIdentifier(elementBindingName) && elementBindingName.text === "element"
      ? undefined
      : "element",
  );

  // Add key parameter if present in original callback
  if (keyParam) {
    builder.addParameter(
      "key",
      normalizeBindingName(keyParam.name, factory, usedBindingNames),
    );
  }

  // Add index parameter if present
  if (indexParam) {
    builder.addParameter(
      "index",
      normalizeBindingName(indexParam.name, factory, usedBindingNames),
    );
  }

  // Add array parameter if present
  if (arrayParam) {
    builder.addParameter(
      "array",
      normalizeBindingName(arrayParam.name, factory, usedBindingNames),
    );
  }

  // Build the new callback
  const newCallback = builder.buildCallback(callback, transformedBody, "params");
  context.markAsMapCallback(newCallback);

  // Build schema using SchemaFactory
  const schemaFactory = new SchemaFactory(context);
  const callbackParamTypeNode = schemaFactory.createMapByKeyCallbackSchema(
    mapByKeyCall,
    elemParam,
    keyParam,
    indexParam,
    arrayParam,
    captureTree,
  );

  // Infer result type from callback
  const typeRegistry = context.options.typeRegistry;
  let resultTypeNode: ts.TypeNode | undefined;

  if (callback.type) {
    resultTypeNode = callback.type;
    if (typeRegistry) {
      const type = getTypeAtLocationWithFallback(
        callback.type,
        checker,
        typeRegistry,
      );
      if (type) {
        typeRegistry.set(callback.type, type);
      }
    }
  } else {
    const signature = checker.getSignatureFromDeclaration(callback);
    if (signature) {
      const resultType = signature.getReturnType();
      const isTypeParam = (resultType.flags & ts.TypeFlags.TypeParameter) !== 0;

      if (!isTypeParam) {
        resultTypeNode = checker.typeToTypeNode(
          resultType,
          context.sourceFile,
          ts.NodeBuilderFlags.NoTruncation |
            ts.NodeBuilderFlags.UseStructuralFallback,
        );

        if (resultTypeNode && typeRegistry) {
          typeRegistry.set(resultTypeNode, resultType);
        }
      }
    }
  }

  // Create recipe call
  const recipeExpr = context.ctHelpers.getHelperExpr("recipe");
  const typeArgs = [callbackParamTypeNode];
  if (resultTypeNode) {
    typeArgs.push(resultTypeNode);
  }

  const recipeCall = factory.createCallExpression(
    recipeExpr,
    typeArgs,
    [newCallback],
  );

  // Create params object
  const paramProperties = buildCapturePropertyAssignments(captureTree, factory);
  const paramsObject = factory.createObjectLiteralExpression(
    paramProperties,
    paramProperties.length > 0,
  );

  // Visit the list expression
  const listArg = mapByKeyCall.arguments[0];
  if (!listArg) {
    return undefined;
  }
  const visitedListExpr = ts.visitNode(listArg, visitor, ts.isExpression) ?? listArg;

  // Build the new mapByKey call with recipe and params
  const mapByKeyExpr = context.ctHelpers.getHelperExpr("mapByKey");

  // Construct arguments based on original call structure
  const newArgs: ts.Expression[] = [visitedListExpr];

  if (keyPath) {
    // 3-arg form: mapByKey(list, keyPath, recipe, params)
    const visitedKeyPath = ts.visitNode(keyPath, visitor, ts.isExpression) ?? keyPath;
    newArgs.push(visitedKeyPath);
  }

  newArgs.push(recipeCall);
  newArgs.push(paramsObject);

  return factory.createCallExpression(
    mapByKeyExpr,
    mapByKeyCall.typeArguments,
    newArgs,
  );
}
