import ts from "typescript";
import { CTHelpers } from "../../core/ct-helpers.ts";

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

function getSimpleName(ref: ts.Expression): string | undefined {
  return ts.isIdentifier(ref) ? ref.text : undefined;
}

interface DeriveEntry {
  readonly ref: ts.Expression;
  readonly paramName: string;
  readonly propertyName: string;
}

export interface DeriveCallOptions {
  readonly factory: ts.NodeFactory;
  readonly tsContext: ts.TransformationContext;
  readonly ctHelpers: CTHelpers;
}

function createPropertyName(
  ref: ts.Expression,
  index: number,
): string {
  if (ts.isIdentifier(ref)) {
    return ref.text;
  }
  if (ts.isPropertyAccessExpression(ref)) {
    return ref.getText().replace(/\./g, "_");
  }
  return `ref${index + 1}`;
}

function planDeriveEntries(
  refs: readonly ts.Expression[],
): {
  readonly entries: readonly DeriveEntry[];
  readonly refToParamName: Map<ts.Expression, string>;
} {
  const entries: DeriveEntry[] = [];
  const refToParamName = new Map<ts.Expression, string>();
  const seen = new Map<string, DeriveEntry>();

  refs.forEach((ref) => {
    const key = ref.getText();
    let entry = seen.get(key);
    if (!entry) {
      const paramName = getSimpleName(ref) ?? `_v${entries.length + 1}`;
      entry = {
        ref,
        paramName,
        propertyName: createPropertyName(ref, entries.length),
      };
      seen.set(key, entry);
      entries.push(entry);
    }
    refToParamName.set(ref, entry.paramName);
  });

  return { entries, refToParamName };
}

function createParameterForEntries(
  factory: ts.NodeFactory,
  entries: readonly DeriveEntry[],
): ts.ParameterDeclaration {
  if (entries.length === 1) {
    const entry = entries[0]!;
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier(entry.paramName),
      undefined,
      undefined,
      undefined,
    );
  }

  const bindings = entries.map((entry) =>
    factory.createBindingElement(
      undefined,
      factory.createIdentifier(entry.propertyName),
      factory.createIdentifier(entry.paramName),
      undefined,
    )
  );

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
  entries: readonly DeriveEntry[],
): readonly ts.Expression[] {
  if (entries.length === 1) {
    return [entries[0]!.ref];
  }

  const properties = entries.map((entry) => {
    if (ts.isIdentifier(entry.ref)) {
      return factory.createShorthandPropertyAssignment(entry.ref, undefined);
    }
    return factory.createPropertyAssignment(
      factory.createIdentifier(entry.propertyName),
      entry.ref,
    );
  });

  return [factory.createObjectLiteralExpression(properties, false)];
}

export function createDeriveCall(
  expression: ts.Expression,
  refs: readonly ts.Expression[],
  options: DeriveCallOptions,
): ts.Expression | undefined {
  if (refs.length === 0) return undefined;

  const { factory, tsContext, ctHelpers } = options;
  const { entries, refToParamName } = planDeriveEntries(refs);
  if (entries.length === 0) return undefined;

  const lambdaBody = replaceOpaqueRefsWithParams(
    expression,
    refToParamName,
    factory,
    tsContext,
  );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [createParameterForEntries(factory, entries)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    lambdaBody,
  );

  const deriveExpr = ctHelpers.getHelperExpr("derive");
  const deriveArgs = [
    ...createDeriveArgs(factory, entries),
    arrowFunction,
  ];

  return factory.createCallExpression(
    deriveExpr,
    undefined,
    deriveArgs,
  );
}
