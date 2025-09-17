import ts from "typescript";
import { getCommonToolsModuleAlias } from "../core/common-tools.ts";
import {
  containsOpaqueRef,
  isOpaqueRefType,
  isSimpleOpaqueRefAccess,
} from "./types.ts";
import {
  createDependencyAnalyzer,
  dedupeExpressions,
  type OpaqueExpressionAnalysis,
} from "./dependency.ts";

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
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);
  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : factory.createIdentifier("ifElse");

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
  analyzer?: (expression: ts.Expression) => OpaqueExpressionAnalysis,
): ts.Expression {
  if (
    ts.isJsxExpression(expression) &&
    expression.parent &&
    ts.isJsxAttribute(expression.parent)
  ) {
    const attrName = expression.parent.name.getText();
    if (attrName.startsWith("on")) return expression;
  }

  const dependencyAnalyzer = analyzer ?? createDependencyAnalyzer(checker);
  const analyzeDependencies = (
    expr: ts.Expression,
  ): {
    analysis: OpaqueExpressionAnalysis;
    dependencies: ts.Expression[];
  } => {
    const analysis = dependencyAnalyzer(expr);
    const deduped = dedupeExpressions(analysis.dependencies, sourceFile);
    const texts = deduped.map((dep) => dep.getText(sourceFile));
    const filtered = deduped.filter((dep, index) => {
      if (!ts.isIdentifier(dep)) return true;
      const text = texts[index];
      return !texts.some((other, otherIndex) =>
        otherIndex !== index && other.startsWith(`${text}.`)
      );
    });
    return { analysis, dependencies: filtered };
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
          dependencyAnalyzer,
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

  if (ts.isPropertyAccessExpression(expression)) {
    const { dependencies: opaqueRefs } = analyzeDependencies(expression);
    if (opaqueRefs.length === 0) return expression;
    if (opaqueRefs.length === 1) {
      const ref = opaqueRefs[0];
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
        : factory.createIdentifier("derive");
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
        const firstRef = uniqueRefs.get(refText)!;
        refToParamName.set(ref, refToParamName.get(firstRef)!);
      }
    });
    const uniqueRefArray = Array.from(uniqueRefs.values());
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
      const paramName = refToParamName.get(ref)!;
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
      : factory.createIdentifier("derive");
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isCallExpression(expression)) {
    const { analysis, dependencies: opaqueRefs } = analyzeDependencies(
      expression,
    );
    if (analysis.rewriteHint?.kind === "call-if-else") {
      return expression;
    }
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
    const uniqueRefArray = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    if (uniqueRefArray.length === 1) {
      const ref = uniqueRefArray[0];
      const paramName = refToParamName.get(ref)!;
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
        : factory.createIdentifier("derive");
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
      const paramName = refToParamName.get(ref)!;
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
      : factory.createIdentifier("derive");
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isTemplateExpression(expression)) {
    const { dependencies: opaqueRefs } = analyzeDependencies(expression);
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
    const uniqueRefArray = Array.from(uniqueRefs.values());
    const lambdaBody = replaceOpaqueRefsWithParams(
      expression,
      refToParamName,
      factory,
      context,
    );
    if (uniqueRefArray.length === 1) {
      const ref = uniqueRefArray[0];
      const paramName = refToParamName.get(ref)!;
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
        : factory.createIdentifier("derive");
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const paramNames = uniqueRefArray.map((ref) => refToParamName.get(ref)!);
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
      const paramName = paramNames[index];
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
      : factory.createIdentifier("derive");
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isBinaryExpression(expression)) {
    const { dependencies: opaqueRefs } = analyzeDependencies(expression);
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
    const uniqueRefArray = Array.from(uniqueRefs.values());
    if (uniqueRefArray.length === 1) {
      const ref = uniqueRefArray[0];
      const paramName = refToParamName.get(ref)!;
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
        : factory.createIdentifier("derive");
      registerHelper?.("derive");
      return factory.createCallExpression(
        deriveIdentifier,
        undefined,
        [ref, arrowFunction],
      );
    }
    const paramNames = uniqueRefArray.map((ref) => refToParamName.get(ref)!);
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
      const paramName = paramNames[index];
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
      : factory.createIdentifier("derive");
    registerHelper?.("derive");
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  return expression;
}
