import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import type { ClosureTransformationStrategy } from "./strategy.ts";
import { isEventHandlerJsxAttribute } from "../../ast/mod.ts";
import {
  registerTypeForNode,
  tryExplicitParameterType,
} from "../../ast/type-inference.ts";
import { buildTypeElementsFromCaptureTree } from "../../ast/type-building.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  getUniqueIdentifier,
  isSafeIdentifierText,
} from "../../utils/identifiers.ts";
import { normalizeBindingName } from "../computed-aliases.ts";
import { CaptureCollector } from "../capture-collector.ts";
import {
  normalizeParameter,
  unwrapArrowFunction,
} from "../utils/ast-helpers.ts";
import { buildCapturePropertyAssignments } from "./map-strategy.ts";

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

/**
 * Build a TypeNode for the handler event parameter and register it in TypeRegistry.
 * If the callback has an explicit event type annotation, use it.
 * If there's no event parameter, use never (generates false schema).
 * Otherwise, infer from the parameter location (could be enhanced to infer from JSX context).
 */
function buildHandlerEventTypeNode(
  callback: ts.ArrowFunction,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const typeRegistry = context.options.typeRegistry;
  const eventParam = callback.parameters[0];

  // If no event parameter exists, use never type (will generate false schema)
  if (!eventParam) {
    const neverTypeNode = factory.createKeywordTypeNode(
      ts.SyntaxKind.NeverKeyword,
    );

    // Don't register a Type - the synthetic NeverKeyword TypeNode will be handled
    // by generateSchemaFromSyntheticTypeNode in the schema generator
    return neverTypeNode;
  }

  // Try explicit annotation
  const explicit = tryExplicitParameterType(eventParam, checker, typeRegistry);
  if (explicit) return explicit.typeNode;

  // Infer from parameter location
  const type = checker.getTypeAtLocation(eventParam);

  // Try to convert Type to TypeNode
  const typeNode = checker.typeToTypeNode(
    type,
    context.sourceFile,
    ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  return registerTypeForNode(typeNode, type, typeRegistry);
}

/**
 * Build a TypeNode for the handler state/params parameter and register it in TypeRegistry.
 * Reuses the same capture tree utilities as map closures.
 */
function buildHandlerStateTypeNode(
  captureTree: Map<string, CaptureTreeNode>,
  callback: ts.ArrowFunction,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;
  const typeRegistry = context.options.typeRegistry;
  const stateParam = callback.parameters[1];

  // Try explicit annotation
  const explicit = tryExplicitParameterType(stateParam, checker, typeRegistry);
  if (explicit) return explicit.typeNode;

  // Fallback: build from captures (buildTypeElementsFromCaptureTree handles its own registration)
  const paramsProperties = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );
  return factory.createTypeLiteralNode(paramsProperties);
}

function createHandlerCallback(
  callback: ts.ArrowFunction,
  transformedBody: ts.ConciseBody,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
): ts.ArrowFunction {
  const { factory } = context;
  const usedBindingNames = new Set<string>();
  const rootNames = new Set<string>();
  for (const [rootName] of captureTree) {
    rootNames.add(rootName);
  }

  const eventParam = callback.parameters[0];
  const stateParam = callback.parameters[1];
  const extraParams = callback.parameters.slice(2);

  const eventParameter = eventParam
    ? normalizeParameter(
      eventParam,
      normalizeBindingName(eventParam.name, factory, usedBindingNames),
    )
    : (() => {
      const baseName = "__ct_handler_event";
      let candidate = baseName;
      let index = 1;
      while (rootNames.has(candidate)) {
        candidate = `${baseName}_${index++}`;
      }
      return factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(
          getUniqueIdentifier(candidate, usedBindingNames, {
            fallback: baseName,
          }),
        ),
        undefined,
        undefined,
        undefined,
      );
    })();

  const createBindingIdentifier = (name: string): ts.Identifier => {
    if (isSafeIdentifierText(name) && !usedBindingNames.has(name)) {
      usedBindingNames.add(name);
      return factory.createIdentifier(name);
    }
    const fallback = name.length > 0 ? name : "ref";
    const unique = getUniqueIdentifier(fallback, usedBindingNames, {
      fallback: "ref",
    });
    return factory.createIdentifier(unique);
  };

  const paramsBindings = createBindingElementsFromNames(
    captureTree.keys(),
    factory,
    createBindingIdentifier,
  );

  const paramsBindingPattern = factory.createObjectBindingPattern(
    paramsBindings,
  );

  let paramsBindingName: ts.BindingName;
  if (stateParam) {
    paramsBindingName = normalizeBindingName(
      stateParam.name,
      factory,
      usedBindingNames,
    );
  } else if (captureTree.size > 0) {
    paramsBindingName = paramsBindingPattern;
  } else {
    paramsBindingName = factory.createIdentifier(
      getUniqueIdentifier("__ct_handler_params", usedBindingNames, {
        fallback: "__ct_handler_params",
      }),
    );
  }

  const paramsParameter = stateParam
    ? normalizeParameter(stateParam, paramsBindingName)
    : factory.createParameterDeclaration(
      undefined,
      undefined,
      paramsBindingName,
      undefined,
      undefined,
      undefined,
    );

  const additionalParameters = extraParams.map((
    param: ts.ParameterDeclaration,
  ) =>
    normalizeParameter(
      param,
      normalizeBindingName(param.name, factory, usedBindingNames),
    )
  );

  return factory.createArrowFunction(
    callback.modifiers,
    callback.typeParameters,
    [eventParameter, paramsParameter, ...additionalParameters],
    callback.type,
    callback.equalsGreaterThanToken,
    transformedBody,
  );
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

  const handlerCallback = createHandlerCallback(
    callback,
    transformedBody,
    captureTree,
    context,
  );

  const { factory } = context;

  // Build type information for handler params
  const eventTypeNode = buildHandlerEventTypeNode(callback, context);
  const stateTypeNode = buildHandlerStateTypeNode(
    captureTree,
    callback,
    context,
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
