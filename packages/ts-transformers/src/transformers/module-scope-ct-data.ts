import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

const TRUSTED_BUILDER_NAMES = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
  "patternTool",
]);
const TRUSTED_DATA_HELPER_NAMES = new Set(["schema", "__ct_data"]);
const CT_DATA_CONSTRUCTOR_NAMES = new Set(["Map", "Set", "Proxy"]);

export class ModuleScopeCtDataTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const statements = sourceFile.statements.map((statement) =>
      transformTopLevelStatement(statement, context)
    );
    return factory.updateSourceFile(sourceFile, statements);
  }
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
): ts.Statement {
  const { factory } = context;

  if (ts.isVariableStatement(statement)) {
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
      return statement;
    }

    let changed = false;
    const declarations = statement.declarationList.declarations.map(
      (declaration) => {
        if (
          !declaration.initializer ||
          !shouldWrapTopLevelExpression(declaration.initializer)
        ) {
          return declaration;
        }
        changed = true;
        return factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          declaration.type,
          wrapWithCtData(declaration.initializer, context),
        );
      },
    );

    if (!changed) return statement;
    return factory.updateVariableStatement(
      statement,
      statement.modifiers,
      factory.updateVariableDeclarationList(
        statement.declarationList,
        declarations,
      ),
    );
  }

  if (
    ts.isExportAssignment(statement) &&
    shouldWrapTopLevelExpression(statement.expression)
  ) {
    return factory.updateExportAssignment(
      statement,
      statement.modifiers,
      wrapWithCtData(statement.expression, context),
    );
  }

  return statement;
}

function wrapWithCtData(
  expression: ts.Expression,
  context: TransformationContext,
): ts.CallExpression {
  return context.factory.createCallExpression(
    context.ctHelpers.getHelperExpr("__ct_data"),
    undefined,
    [expression],
  );
}

function shouldWrapTopLevelExpression(
  expression: ts.Expression,
): boolean {
  if (isAnyLikeTypeAssertion(expression)) {
    return false;
  }

  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isClassExpression(expr)
  ) {
    return false;
  }

  if (ts.isCallExpression(expr)) {
    if (isTrustedBuilderCall(expr)) return false;
    return isTrustedDataHelperCall(expr) || isImmediatelyInvokedFunction(expr);
  }

  if (ts.isNewExpression(expr)) {
    return hasNamedTarget(expr.expression, CT_DATA_CONSTRUCTOR_NAMES);
  }

  if (
    ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr)
  ) {
    return true;
  }

  return false;
}

function isTrustedBuilderCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, TRUSTED_BUILDER_NAMES);
}

function isTrustedDataHelperCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, TRUSTED_DATA_HELPER_NAMES);
}

function isImmediatelyInvokedFunction(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
}

function hasNamedTarget(
  expression: ts.Expression,
  names: ReadonlySet<string>,
): boolean {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return names.has(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    return names.has(target.name.text);
  }
  return false;
}

function isAnyLikeTypeAssertion(expression: ts.Expression): boolean {
  if (
    ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
  ) {
    return expression.type.kind === ts.SyntaxKind.AnyKeyword ||
      expression.type.kind === ts.SyntaxKind.UnknownKeyword;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isAnyLikeTypeAssertion(expression.expression);
  }
  return false;
}
