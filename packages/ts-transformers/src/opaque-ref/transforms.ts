import ts from "typescript";
import {
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./types.ts";
import {
  createDataFlowAnalyzer,
  type DataFlowAnalysis,
  dedupeExpressions,
} from "./dataflow.ts";
import { getHelperIdentifier } from "./rewrite/import-resolver.ts";

export type OpaqueRefHelperName = "derive" | "ifElse" | "toSchema";

export function replaceOpaqueRefWithParam(
  expression: ts.Expression,
  opaqueRef: ts.Expression,
  paramName: string,
  factory: ts.NodeFactory,
  context: ts.TransformationContext,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    if (node === opaqueRef) {
      return factory.createIdentifier(paramName);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return visit(expression) as ts.Expression;
}

export function replaceOpaqueRefsWithParams(
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

export interface IfElseOverrides {
  readonly predicate?: ts.Expression;
  readonly whenTrue?: ts.Expression;
  readonly whenFalse?: ts.Expression;
}

export function createIfElseCall(
  ternary: ts.ConditionalExpression,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  overrides: IfElseOverrides = {},
): ts.CallExpression {
  const ifElseIdentifier = getHelperIdentifier(factory, sourceFile, "ifElse");

  let predicate = overrides.predicate ?? ternary.condition;
  let whenTrue = overrides.whenTrue ?? ternary.whenTrue;
  let whenFalse = overrides.whenFalse ?? ternary.whenFalse;
  while (ts.isParenthesizedExpression(predicate)) {
    predicate = predicate.expression;
  }
  while (ts.isParenthesizedExpression(whenTrue)) whenTrue = whenTrue.expression;
  while (ts.isParenthesizedExpression(whenFalse)) {
    whenFalse = whenFalse.expression;
  }

  return factory.createCallExpression(
    ifElseIdentifier,
    undefined,
    [predicate, whenTrue, whenFalse],
  );
}

function getSimpleName(ref: ts.Expression): string | undefined {
  return ts.isIdentifier(ref) ? ref.text : undefined;
}

interface DeriveEntry {
  readonly ref: ts.Expression;
  readonly paramName: string;
  readonly propertyName: string;
}

interface DeriveCallOptions {
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly context: ts.TransformationContext;
  readonly registerHelper?: (helper: OpaqueRefHelperName) => void;
}

function createDeriveCallOptions(
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
  registerHelper?: (helper: OpaqueRefHelperName) => void,
): DeriveCallOptions {
  return registerHelper
    ? { factory, sourceFile, context, registerHelper }
    : { factory, sourceFile, context };
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

  const { factory, sourceFile, context, registerHelper } = options;
  const { entries, refToParamName } = planDeriveEntries(refs);
  if (entries.length === 0) return undefined;

  const lambdaBody = replaceOpaqueRefsWithParams(
    expression,
    refToParamName,
    factory,
    context,
  );

  const arrowFunction = factory.createArrowFunction(
    undefined,
    undefined,
    [createParameterForEntries(factory, entries)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    lambdaBody,
  );

  registerHelper?.("derive");
  const deriveIdentifier = getHelperIdentifier(factory, sourceFile, "derive");
  const deriveArgs = [
    ...createDeriveArgs(factory, entries),
    arrowFunction,
  ];

  return factory.createCallExpression(
    deriveIdentifier,
    undefined,
    deriveArgs,
  );
}

function deriveWhenNecessary(
  expression: ts.Expression,
  analyzeDataFlows: (expr: ts.Expression) => {
    analysis: DataFlowAnalysis;
    dataFlows: ts.Expression[];
  },
  options: DeriveCallOptions,
  precomputed?: {
    analysis: DataFlowAnalysis;
    dataFlows: ts.Expression[];
  },
): ts.Expression | undefined {
  const { dataFlows: opaqueRefs } = precomputed ?? analyzeDataFlows(expression);
  if (opaqueRefs.length === 0) return undefined;
  return createDeriveCall(expression, opaqueRefs, options);
}

function createDataFlowResolver(
  analyzer: (expr: ts.Expression) => DataFlowAnalysis,
  sourceFile: ts.SourceFile,
): (expr: ts.Expression) => {
  analysis: DataFlowAnalysis;
  dataFlows: ts.Expression[];
} {
  return (expr) => {
    const analysis = analyzer(expr);
    const deduped = dedupeExpressions(analysis.dataFlows, sourceFile);
    const texts = deduped.map((dep) => dep.getText(sourceFile));
    const filtered = deduped.filter((dep, index) => {
      if (!ts.isIdentifier(dep)) return true;
      const text = texts[index];
      return !texts.some((other, otherIndex) =>
        otherIndex !== index && other.startsWith(`${text}.`)
      );
    });
    return { analysis, dataFlows: filtered };
  };
}

export function transformExpressionWithOpaqueRef(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
  registerHelper?: (helper: OpaqueRefHelperName) => void,
  analyzer?: (expression: ts.Expression) => DataFlowAnalysis,
): ts.Expression {
  if (
    ts.isJsxExpression(expression) &&
    expression.parent &&
    ts.isJsxAttribute(expression.parent)
  ) {
    const attrName = expression.parent.name.getText();
    if (attrName.startsWith("on")) return expression;
  }

  const dataFlowAnalyzer = analyzer ?? createDataFlowAnalyzer(checker);
  const resolveDataFlows = createDataFlowResolver(
    dataFlowAnalyzer,
    sourceFile,
  );

  const deriveOptions = createDeriveCallOptions(
    factory,
    sourceFile,
    context,
    registerHelper,
  );

  if (ts.isConditionalExpression(expression)) {
    const conditionType = checker.getTypeAtLocation(expression.condition);
    const conditionContainsOpaqueRef = containsOpaqueRef(
      expression.condition,
      checker,
    );
    const conditionIsOpaqueRef = isOpaqueRefType(conditionType, checker);

    const transformBranch = (expr: ts.Expression): ts.Expression => {
      if (ts.isConditionalExpression(expr)) {
        return expr;
      }
      if (
        !isSimpleOpaqueRefAccess(expr, checker) &&
        containsOpaqueRef(expr, checker)
      ) {
        return transformExpressionWithOpaqueRef(
          expr,
          checker,
          factory,
          sourceFile,
          context,
          registerHelper,
          dataFlowAnalyzer,
        );
      }
      return expr;
    };

    const visitedCondition = transformBranch(expression.condition);
    const visitedWhenTrue = transformBranch(expression.whenTrue);
    const visitedWhenFalse = transformBranch(expression.whenFalse);

    const updated = factory.updateConditionalExpression(
      expression,
      visitedCondition,
      expression.questionToken,
      visitedWhenTrue,
      expression.colonToken,
      visitedWhenFalse,
    );

    if (
      conditionIsOpaqueRef ||
      conditionContainsOpaqueRef ||
      visitedCondition !== expression.condition
    ) {
      registerHelper?.("ifElse");
      return createIfElseCall(updated, factory, sourceFile);
    }

    return updated;
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const deriveCall = deriveWhenNecessary(
      expression,
      resolveDataFlows,
      deriveOptions,
    );
    return deriveCall ?? expression;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const deriveCall = deriveWhenNecessary(
      expression,
      resolveDataFlows,
      deriveOptions,
    );
    return deriveCall ?? expression;
  }

  if (ts.isCallExpression(expression)) {
    const analysisResult = resolveDataFlows(expression);
    if (analysisResult.analysis.rewriteHint?.kind === "call-if-else") {
      return expression;
    }
    const deriveCall = deriveWhenNecessary(
      expression,
      resolveDataFlows,
      deriveOptions,
      analysisResult,
    );
    return deriveCall ?? expression;
  }

  if (ts.isTemplateExpression(expression)) {
    const deriveCall = deriveWhenNecessary(
      expression,
      resolveDataFlows,
      deriveOptions,
    );
    return deriveCall ?? expression;
  }

  if (ts.isBinaryExpression(expression)) {
    const deriveCall = deriveWhenNecessary(
      expression,
      resolveDataFlows,
      deriveOptions,
    );
    return deriveCall ?? expression;
  }

  return expression;
}
