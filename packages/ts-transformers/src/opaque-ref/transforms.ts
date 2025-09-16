import ts from "typescript";
import { getCommonToolsModuleAlias } from "../core/common-tools.ts";
import { collectOpaqueRefs } from "./types.ts";

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

export function createIfElseCall(
  ternary: ts.ConditionalExpression,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
): ts.CallExpression {
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);
  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : factory.createIdentifier("ifElse");

  let whenTrue = ternary.whenTrue;
  let whenFalse = ternary.whenFalse;
  while (ts.isParenthesizedExpression(whenTrue)) whenTrue = whenTrue.expression;
  while (ts.isParenthesizedExpression(whenFalse)) {
    whenFalse = whenFalse.expression;
  }

  return factory.createCallExpression(
    ifElseIdentifier,
    undefined,
    [ternary.condition, whenTrue, whenFalse],
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
): ts.Expression {
  if (
    ts.isJsxExpression(expression) &&
    expression.parent &&
    ts.isJsxAttribute(expression.parent)
  ) {
    const attrName = expression.parent.name.getText();
    if (attrName.startsWith("on")) return expression;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const opaqueRefs = collectOpaqueRefs(expression, checker);
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
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  if (ts.isCallExpression(expression)) {
    const opaqueRefs = collectOpaqueRefs(expression, checker);
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
    return factory.createCallExpression(
      deriveIdentifier,
      undefined,
      [refObject, arrowFunction],
    );
  }

  return expression;
}
