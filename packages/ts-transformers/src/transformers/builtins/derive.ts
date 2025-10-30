import ts from "typescript";
import { CTHelpers } from "../../core/ct-helpers.ts";
import { getExpressionText } from "../../ast/mod.ts";
import {
  buildHierarchicalParamsValue,
  groupCapturesByRoot,
  parseCaptureExpression,
} from "../../utils/capture-tree.ts";
import {
  getUniqueIdentifier,
  isSafeIdentifierText,
} from "../../utils/identifiers.ts";

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
    const baseName = getExpressionText(ref).replace(/\./g, "_");
    const propertyName = getUniqueIdentifier(baseName, usedPropertyNames, {
      fallback: `ref${index + 1}`,
      trimLeadingUnderscores: true,
    });

    const paramName = ts.isIdentifier(ref)
      ? getUniqueIdentifier(ref.text, usedParamNames)
      : getUniqueIdentifier(`_v${index + 1}`, usedParamNames, {
        fallback: `_v${index + 1}`,
      });

    fallbackEntries.push({ ref, propertyName, paramName });
    refToParamName.set(ref, paramName);
  });

  return { captureTree, fallbackEntries, refToParamName };
}

function createPropertyName(
  factory: ts.NodeFactory,
  name: string,
): ts.PropertyName {
  return isSafeIdentifierText(name)
    ? factory.createIdentifier(name)
    : factory.createStringLiteral(name);
}

function createParameterForPlan(
  factory: ts.NodeFactory,
  captureTree: ReturnType<typeof groupCapturesByRoot>,
  fallbackEntries: readonly FallbackEntry[],
): ts.ParameterDeclaration {
  const bindings: ts.BindingElement[] = [];
  const usedNames = new Set<string>();

  const register = (candidate: string): ts.Identifier => {
    if (isSafeIdentifierText(candidate) && !usedNames.has(candidate)) {
      usedNames.add(candidate);
      return factory.createIdentifier(candidate);
    }
    const unique = getUniqueIdentifier(candidate, usedNames, {
      fallback: candidate.length > 0 ? candidate : "ref",
    });
    return factory.createIdentifier(unique);
  };

  for (const [rootName] of captureTree) {
    const bindingIdentifier = register(rootName);
    const propertyName = isSafeIdentifierText(rootName)
      ? undefined
      : createPropertyName(factory, rootName);
    bindings.push(
      factory.createBindingElement(
        undefined,
        propertyName,
        bindingIdentifier,
        undefined,
      ),
    );
  }

  for (const entry of fallbackEntries) {
    const bindingIdentifier = register(entry.paramName);
    bindings.push(
      factory.createBindingElement(
        undefined,
        factory.createIdentifier(entry.propertyName),
        bindingIdentifier,
        undefined,
      ),
    );
  }

  const shouldInlineSoleBinding = bindings.length === 1 &&
    captureTree.size === 0 &&
    fallbackEntries.length === 1 &&
    !bindings[0]!.propertyName &&
    !bindings[0]!.dotDotDotToken &&
    !bindings[0]!.initializer;

  if (shouldInlineSoleBinding) {
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      bindings[0]!.name,
      undefined,
      undefined,
      undefined,
    );
  }

  return factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(bindings),
    undefined,
    undefined,
    undefined,
  );
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
        createPropertyName(factory, rootName),
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

  if (properties.length === 1 && fallbackEntries.length === 0) {
    const first = captureTree.values().next();
    if (!first.done) {
      const node = first.value;
      if (node.expression && node.properties.size === 0) {
        return [node.expression];
      }
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

  const { factory, tsContext, ctHelpers } = options;
  const { captureTree, fallbackEntries, refToParamName } = planDeriveEntries(
    refs,
  );
  if (captureTree.size === 0 && fallbackEntries.length === 0) {
    return undefined;
  }

  const lambdaBody = replaceOpaqueRefsWithParams(
    expression,
    refToParamName,
    factory,
    tsContext,
  );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [createParameterForPlan(factory, captureTree, fallbackEntries)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    lambdaBody,
  );

  const deriveExpr = ctHelpers.getHelperExpr("derive");
  const deriveArgs = [
    ...createDeriveArgs(factory, captureTree, fallbackEntries),
    arrowFunction,
  ];

  return factory.createCallExpression(
    deriveExpr,
    undefined,
    deriveArgs,
  );
}
