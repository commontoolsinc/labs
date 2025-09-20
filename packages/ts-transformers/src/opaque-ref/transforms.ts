import ts from "typescript";
import {
  getCommonToolsImportIdentifier,
  getCommonToolsModuleAlias,
} from "../core/common-tools.ts";
import { assertDefined } from "../core/assert.ts";
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

function getHelperIdentifier(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  helperName: OpaqueRefHelperName,
  recordHelperReference?: (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => void,
): ts.Identifier {
  const existing = getCommonToolsImportIdentifier(
    sourceFile,
    factory,
    helperName,
  );
  if (existing) return existing;

  const identifier = factory.createIdentifier(helperName);
  recordHelperReference?.(helperName, identifier);
  return identifier;
}

export function createIfElseCall(
  ternary: ts.ConditionalExpression,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  overrides: IfElseOverrides = {},
  recordHelperReference?: (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => void,
): ts.CallExpression {
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);
  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : getHelperIdentifier(
      sourceFile,
      factory,
      "ifElse",
      recordHelperReference,
    );

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

export function transformExpressionWithOpaqueRef(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
  registerHelper?: (helper: OpaqueRefHelperName) => void,
  analyzer?: (expression: ts.Expression) => DataFlowAnalysis,
  recordHelperReference?: (
    helper: OpaqueRefHelperName,
    identifier: ts.Identifier,
  ) => void,
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
  const analyzeDataFlows = (
    expr: ts.Expression,
  ): {
    analysis: DataFlowAnalysis;
    dataFlows: ts.Expression[];
  } => {
    const analysis = dataFlowAnalyzer(expr);
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
          recordHelperReference,
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
      return createIfElseCall(
        updated,
        factory,
        sourceFile,
        {},
        recordHelperReference,
      );
    }

    return updated;
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const { dataFlows: opaqueRefs } = analyzeDataFlows(expression);
    if (opaqueRefs.length === 0) return expression;

    if (opaqueRefs.length === 1) {
      const ref = opaqueRefs[0]!;
      const paramName = getSimpleName(ref) ?? "_v1";
      const lambdaBody = replaceOpaqueRefWithParam(
        expression,
        ref,
        paramName,
        factory,
        context,
      );
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : getHelperIdentifier(
          sourceFile,
          factory,
          "derive",
          recordHelperReference,
        );
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }

    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        const firstRef = assertDefined(
          uniqueRefs.get(refText),
          "Expected ref to be tracked",
        );
        const existing = refToParamName.get(firstRef) ?? `_v${uniqueRefs.size}`;
        refToParamName.set(ref, existing);
      }
    });
    const uniqueRefArray: ts.Expression[] = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    const refProperties = uniqueRefArray.map((ref, index) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      }
      if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
      const propName = `ref${index + 1}`;
      return factory.createPropertyAssignment(
        factory.createIdentifier(propName),
        ref,
      );
    });
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = refToParamName.get(ref) ?? `_v${index + 1}`;
      let propName = `ref${index + 1}`;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      }
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });
    const paramObjectPattern = factory.createObjectBindingPattern(
      paramProperties,
    );
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramObjectPattern,
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : getHelperIdentifier(
        sourceFile,
        factory,
        "derive",
        recordHelperReference,
      );
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [
        factory.createObjectLiteralExpression(refProperties, false),
        arrowFunction,
      ],
    );
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const { dataFlows: opaqueRefs } = analyzeDataFlows(expression);
    if (opaqueRefs.length === 0) return expression;
    if (opaqueRefs.length === 1) {
      const ref = opaqueRefs[0]!;
      const paramName = getSimpleName(ref) ?? "_v1";
      const lambdaBody = replaceOpaqueRefWithParam(
        expression,
        ref,
        paramName,
        factory,
        context,
      );
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : getHelperIdentifier(
          sourceFile,
          factory,
          "derive",
          recordHelperReference,
        );
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        const firstRef = assertDefined(
          uniqueRefs.get(refText),
          "Expected ref to be tracked",
        );
        const existing = refToParamName.get(firstRef) ?? `_v${uniqueRefs.size}`;
        refToParamName.set(ref, existing);
      }
    });
    const uniqueRefArray: ts.Expression[] = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    const refProperties = uniqueRefArray.map((ref) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      }
      if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
      const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
      return factory.createPropertyAssignment(
        factory.createIdentifier(propName),
        ref,
      );
    });
    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = refToParamName.get(ref) ?? `_v${index + 1}`;
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });
    const paramObjectPattern = factory.createObjectBindingPattern(
      paramProperties,
    );
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramObjectPattern,
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : getHelperIdentifier(
        sourceFile,
        factory,
        "derive",
        recordHelperReference,
      );
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isCallExpression(expression)) {
    const { analysis, dataFlows: opaqueRefs } = analyzeDataFlows(
      expression,
    );
    if (analysis.rewriteHint?.kind === "call-if-else") {
      return expression;
    }
    if (opaqueRefs.length === 0) return expression;
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    opaqueRefs.forEach((ref, idx) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        const firstRef = assertDefined(
          uniqueRefs.get(refText),
          "Expected ref to be tracked",
        );
        const existing = refToParamName.get(firstRef) ?? `_v${idx + 1}`;
        refToParamName.set(ref, existing);
      }
    });
    const uniqueRefArray: ts.Expression[] = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    if (uniqueRefArray.length === 1) {
      const ref = assertDefined(
        uniqueRefArray[0],
        "Expected at least one opaque ref",
      );
      const paramName = refToParamName.get(ref) ?? `_v1`;
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : getHelperIdentifier(
          sourceFile,
          factory,
          "derive",
          recordHelperReference,
        );
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const refProperties = uniqueRefArray.map((ref, index) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      }
      if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
      const propName = `ref${index + 1}`;
      return factory.createPropertyAssignment(
        factory.createIdentifier(propName),
        ref,
      );
    });
    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = refToParamName.get(ref) ?? `_v${index + 1}`;
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });
    const paramObjectPattern = factory.createObjectBindingPattern(
      paramProperties,
    );
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramObjectPattern,
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : getHelperIdentifier(
        sourceFile,
        factory,
        "derive",
        recordHelperReference,
      );
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isTemplateExpression(expression)) {
    const { dataFlows: opaqueRefs } = analyzeDataFlows(expression);
    if (opaqueRefs.length === 0) return expression;
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    opaqueRefs.forEach((ref, idx) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        const firstRef = assertDefined(
          uniqueRefs.get(refText),
          "Expected ref to be tracked",
        );
        let existing = refToParamName.get(firstRef);
        if (existing === undefined) {
          existing = `_v${idx + 1}`;
          refToParamName.set(firstRef, existing);
        }
        refToParamName.set(ref, existing);
      }
    });
    const uniqueRefArray: ts.Expression[] = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    if (uniqueRefArray.length === 1) {
      const ref = assertDefined(
        uniqueRefArray[0],
        "Expected at least one opaque ref",
      );
      const paramName = refToParamName.get(ref) ?? `_v1`;
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : getHelperIdentifier(
          sourceFile,
          factory,
          "derive",
          recordHelperReference,
        );
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const paramNames = uniqueRefArray.map((ref) =>
      assertDefined(refToParamName.get(ref), "Expected param name")
    );
    const refProperties = uniqueRefArray.map((ref) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      }
      if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
      const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
      return factory.createPropertyAssignment(
        factory.createIdentifier(propName),
        ref,
      );
    });
    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = assertDefined(
        paramNames[index],
        "Expected param name",
      );
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });
    const paramPattern = factory.createObjectBindingPattern(paramProperties);
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramPattern,
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : getHelperIdentifier(
        sourceFile,
        factory,
        "derive",
        recordHelperReference,
      );
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isBinaryExpression(expression)) {
    const { dataFlows: opaqueRefs } = analyzeDataFlows(expression);
    if (opaqueRefs.length === 0) return expression;
    const uniqueRefs = new Map<string, ts.Expression>();
    const refToParamName = new Map<ts.Expression, string>();
    opaqueRefs.forEach((ref) => {
      const refText = ref.getText();
      if (!uniqueRefs.has(refText)) {
        const paramName = getSimpleName(ref) ?? `_v${uniqueRefs.size + 1}`;
        uniqueRefs.set(refText, ref);
        refToParamName.set(ref, paramName);
      } else {
        const firstRef = uniqueRefs.get(refText)!;
        refToParamName.set(ref, refToParamName.get(firstRef)!);
      }
    });
    const uniqueRefArray: ts.Expression[] = Array.from(uniqueRefs.values());
    if (uniqueRefArray.length === 1) {
      const ref = assertDefined(
        uniqueRefArray[0],
        "Expected at least one opaque ref",
      );
      const paramName = assertDefined(
        refToParamName.get(ref),
        "Expected param name",
      );
      const lambdaBody = replaceOpaqueRefsWithParams(
        expression,
        refToParamName,
        factory,
        context,
      );
      const arrowFunction = factory.createArrowFunction(
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier(paramName),
          undefined,
          undefined,
          undefined,
        )],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        lambdaBody,
      );
      const moduleAlias = getCommonToolsModuleAlias(sourceFile);
      const deriveIdentifier = moduleAlias
        ? factory.createPropertyAccessExpression(
          factory.createIdentifier(moduleAlias),
          factory.createIdentifier("derive"),
        )
        : getHelperIdentifier(
          sourceFile,
          factory,
          "derive",
          recordHelperReference,
        );
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const paramNames = uniqueRefArray.map((ref) =>
      assertDefined(refToParamName.get(ref), "Expected param name")
    );
    const refProperties = uniqueRefArray.map((ref) => {
      if (ts.isIdentifier(ref)) {
        return factory.createShorthandPropertyAssignment(ref, undefined);
      }
      if (ts.isPropertyAccessExpression(ref)) {
        const propName = ref.getText().replace(/\./g, "_");
        return factory.createPropertyAssignment(
          factory.createIdentifier(propName),
          ref,
        );
      }
      const propName = `ref${uniqueRefArray.indexOf(ref) + 1}`;
      return factory.createPropertyAssignment(
        factory.createIdentifier(propName),
        ref,
      );
    });
    const refObject = factory.createObjectLiteralExpression(
      refProperties,
      false,
    );
    const paramProperties = uniqueRefArray.map((ref, index) => {
      const paramName = assertDefined(
        paramNames[index],
        "Expected param name",
      );
      let propName: string;
      if (ts.isIdentifier(ref)) {
        propName = ref.text;
      } else if (ts.isPropertyAccessExpression(ref)) {
        propName = ref.getText().replace(/\./g, "_");
      } else {
        propName = `ref${index + 1}`;
      }
      return factory.createBindingElement(
        undefined,
        factory.createIdentifier(propName),
        factory.createIdentifier(paramName),
        undefined,
      );
    });
    const paramPattern = factory.createObjectBindingPattern(paramProperties);
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    const arrowFunction = factory.createArrowFunction(
      undefined,
      undefined,
      [factory.createParameterDeclaration(
        undefined,
        undefined,
        paramPattern,
        undefined,
        undefined,
        undefined,
      )],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      lambdaBody,
    );
    const moduleAlias = getCommonToolsModuleAlias(sourceFile);
    const deriveIdentifier = moduleAlias
      ? factory.createPropertyAccessExpression(
        factory.createIdentifier(moduleAlias),
        factory.createIdentifier("derive"),
      )
      : getHelperIdentifier(
        sourceFile,
        factory,
        "derive",
        recordHelperReference,
      );
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  return expression;
}
