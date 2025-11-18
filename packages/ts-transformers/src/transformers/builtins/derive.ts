import ts from "typescript";
import { CTHelpers } from "../../core/ct-helpers.ts";
import { getExpressionText } from "../../ast/mod.ts";
import {
  buildHierarchicalParamsValue,
  groupCapturesByRoot,
  parseCaptureExpression,
} from "../../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  createParameterFromBindings,
  createPropertyName,
  createPropertyParamNames,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import {
  buildTypeElementsFromCaptureTree,
  expressionToTypeNode,
} from "../../ast/type-building.ts";
import { registerDeriveCallType } from "../../ast/type-inference.ts";
import type { TransformationContext } from "../../core/mod.ts";

function replaceOpaqueRefsWithParams(
  expression: ts.Expression,
  refToParamName: Map<ts.Expression, string>,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    for (const [ref, paramName] of refToParamName) {
      if (node === ref) {
        return factory.createIdentifier(paramName);
      }
    }
    return ts.visitEachChild(node, visit, context);
  };
  return visit(expression) as ts.Expression;
}

interface FallbackEntry {
  readonly ref: ts.Expression;
  readonly paramName: string;
  readonly propertyName: string;
}

export interface DeriveCallOptions {
  readonly factory: ts.NodeFactory;
  readonly tsContext: ts.TransformationContext;
  readonly ctHelpers: CTHelpers;
  readonly context: TransformationContext;
}

function planDeriveEntries(
  refs: readonly ts.Expression[],
): {
  readonly captureTree: ReturnType<typeof groupCapturesByRoot>;
  readonly fallbackEntries: readonly FallbackEntry[];
  readonly refToParamName: Map<ts.Expression, string>;
} {
  const structured: ts.Expression[] = [];
  const fallback: ts.Expression[] = [];

  refs.forEach((ref) => {
    if (parseCaptureExpression(ref)) {
      structured.push(ref);
    } else {
      fallback.push(ref);
    }
  });

  const captureTree = groupCapturesByRoot(structured);
  const fallbackEntries: FallbackEntry[] = [];
  const refToParamName = new Map<ts.Expression, string>();

  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();

  fallback.forEach((ref, index) => {
    const { propertyName, paramName } = createPropertyParamNames(
      getExpressionText(ref),
      ts.isIdentifier(ref),
      index,
      usedPropertyNames,
      usedParamNames,
    );

    fallbackEntries.push({ ref, propertyName, paramName });
    refToParamName.set(ref, paramName);
  });

  return { captureTree, fallbackEntries, refToParamName };
}

function createParameterForPlan(
  factory: ts.NodeFactory,
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
  refToParamName: Map<ts.Expression, string>,
): ts.ParameterDeclaration {
  const bindings: ts.BindingElement[] = [];
  const usedNames = new Set<string>();

  const register = (candidate: string): ts.Identifier => {
    return reserveIdentifier(candidate, usedNames, factory);
  };

  bindings.push(
    ...createBindingElementsFromNames(captureTree.keys(), factory, register),
  );

  for (const entry of fallbackEntries) {
    const bindingIdentifier = register(entry.paramName);
    const currentName = refToParamName.get(entry.ref);
    if (currentName !== bindingIdentifier.text) {
      refToParamName.set(entry.ref, bindingIdentifier.text);
    }
    bindings.push(
      factory.createBindingElement(
        undefined,
        factory.createIdentifier(entry.propertyName),
        bindingIdentifier,
        undefined,
      ),
    );
  }

  return createParameterFromBindings(bindings, factory);
}

function createDeriveArgs(
  factory: ts.NodeFactory,
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
): readonly ts.Expression[] {
  const properties: ts.ObjectLiteralElementLike[] = [];

  for (const [rootName, node] of captureTree) {
    properties.push(
      factory.createPropertyAssignment(
        createPropertyName(rootName, factory),
        buildHierarchicalParamsValue(node, rootName, factory),
      ),
    );
  }

  for (const entry of fallbackEntries) {
    if (ts.isIdentifier(entry.ref) && entry.propertyName === entry.ref.text) {
      properties.push(
        factory.createShorthandPropertyAssignment(entry.ref, undefined),
      );
    } else {
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier(entry.propertyName),
          entry.ref,
        ),
      );
    }
  }

  return [
    factory.createObjectLiteralExpression(properties, properties.length > 1),
  ];
}

export function createDeriveCall(
  expression: ts.Expression,
  refs: readonly ts.Expression[],
  options: DeriveCallOptions,
): ts.Expression | undefined {
  if (refs.length === 0) return undefined;

  const { factory, tsContext, ctHelpers, context } = options;
  const { captureTree, fallbackEntries, refToParamName } = planDeriveEntries(
    refs,
  );
  if (captureTree.size === 0 && fallbackEntries.length === 0) {
    return undefined;
  }

  const parameter = createParameterForPlan(
    factory,
    captureTree,
    fallbackEntries,
    refToParamName,
  );

  const lambdaBody = replaceOpaqueRefsWithParams(
    expression,
    refToParamName,
    factory,
    tsContext,
  );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [parameter],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    lambdaBody,
  );

  const deriveExpr = ctHelpers.getHelperExpr("derive");
  const deriveArgs = [
    ...createDeriveArgs(factory, captureTree, fallbackEntries),
    arrowFunction,
  ];

  // Build input type node that preserves Cell<T> types
  const inputTypeNode = buildInputTypeNode(
    captureTree,
    fallbackEntries,
    context,
  );

  // Build result type node from expression type
  const resultTypeNode = buildResultTypeNode(expression, context);

  // Create derive call with type arguments for SchemaInjectionTransformer
  const deriveCall = factory.createCallExpression(
    deriveExpr,
    [inputTypeNode, resultTypeNode],
    deriveArgs,
  );

  // Register the type of the derive call expression itself in the typeRegistry
  // so that type inference works correctly for synthetic nodes
  if (context.options.typeRegistry && context.checker) {
    registerDeriveCallType(
      deriveCall,
      resultTypeNode,
      undefined, // resultType not available in this code path
      context.checker,
      context.options.typeRegistry,
    );
  }

  return deriveCall;
}

function buildInputTypeNode(
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
  context: TransformationContext,
): ts.TypeNode {
  const { factory } = context;
  const typeElements: ts.TypeElement[] = [];

  // Add type elements from capture tree (preserves Cell<T>)
  const captureTypeElements = buildTypeElementsFromCaptureTree(
    captureTree,
    context,
  );
  typeElements.push(...captureTypeElements);

  // Add type elements for fallback entries
  for (const entry of fallbackEntries) {
    const typeNode = expressionToTypeNode(entry.ref, context);
    typeElements.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(entry.propertyName),
        undefined,
        typeNode,
      ),
    );
  }

  const typeLiteral = factory.createTypeLiteralNode(typeElements);

  return typeLiteral;
}

function buildResultTypeNode(
  expression: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  const { factory, checker } = context;

  // Try to get the type of the result expression
  const resultType = checker.getTypeAtLocation(expression);

  // Convert to TypeNode, preserving Cell<T> if present
  const resultTypeNode = checker.typeToTypeNode(
    resultType,
    context.sourceFile,
    ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseStructuralFallback,
  );

  if (resultTypeNode) {
    // Register the type in typeRegistry for SchemaGeneratorTransformer
    if (context.options.typeRegistry) {
      context.options.typeRegistry.set(resultTypeNode, resultType);
    }
    return resultTypeNode;
  }

  // Fallback to unknown if we can't infer
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}
