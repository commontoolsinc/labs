import ts from "typescript";
import {
  isTrustedBuilder,
  isTrustedDataHelper,
} from "@commonfabric/utils/sandbox-contract";
import {
  CF_DATA_HELPER_IDENTIFIER,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

const CT_DATA_CONSTRUCTOR_NAMES = new Set(["Map", "Set"]);

export class ModuleScopeCfDataTransformer extends Transformer {
  override filter(_context: TransformationContext): boolean {
    return true;
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const localCallableBindings = collectTopLevelCallableBindings(sourceFile);
    let changed = false;
    const transformedStatements = sourceFile.statements.map((statement) => {
      const next = transformTopLevelStatement(
        statement,
        context,
        localCallableBindings,
      );
      changed ||= next !== statement;
      return next;
    });
    if (!changed) {
      return sourceFile;
    }

    const statements = (
        context.cfHelpers.sourceHasHelpers() ||
        context.cfHelpers.sourceHasDataHelper()
      )
      ? transformedStatements
      : [createCfDataHelperImport(factory), ...transformedStatements];
    return factory.updateSourceFile(sourceFile, statements);
  }
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
  localCallableBindings: ReadonlySet<string>,
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
          !shouldWrapTopLevelExpression(
            declaration.initializer,
            context,
            localCallableBindings,
          )
        ) {
          return declaration;
        }
        changed = true;
        return factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          declaration.type,
          wrapWithCfData(declaration.initializer, context),
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
    shouldWrapTopLevelExpression(
      statement.expression,
      context,
      localCallableBindings,
    )
  ) {
    return factory.updateExportAssignment(
      statement,
      statement.modifiers,
      wrapWithCfData(statement.expression, context),
    );
  }

  return statement;
}

function wrapWithCfData(
  expression: ts.Expression,
  context: TransformationContext,
): ts.CallExpression {
  const helperExpr = context.cfHelpers.sourceHasHelpers()
    ? context.cfHelpers.getHelperExpr("__cf_data")
    : context.cfHelpers.sourceHasDataHelper()
    ? context.cfHelpers.getDataHelperExpr(expression)
    : context.factory.createIdentifier(CF_DATA_HELPER_IDENTIFIER);
  return context.factory.createCallExpression(
    helperExpr,
    undefined,
    [expression],
  );
}

function shouldWrapTopLevelExpression(
  expression: ts.Expression,
  context: TransformationContext,
  localCallableBindings: ReadonlySet<string>,
): boolean {
  if (isAnyLikeTypeAssertion(expression)) {
    return false;
  }

  const expr = unwrapExpression(expression);
  const helpersPresent = context.cfHelpers.sourceHasHelpers();

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isClassExpression(expr)
  ) {
    return false;
  }

  if (!helpersPresent) {
    return ts.isCallExpression(expr) && isPrimitiveSnapshotCall(expr, context);
  }

  if (ts.isCallExpression(expr)) {
    if (isTrustedBuilderCall(expr)) return false;
    return isTrustedDataHelperCall(expr) ||
      isImmediatelyInvokedFunction(expr) ||
      isIntrinsicCtDataCall(expr) ||
      isTopLevelLocalHelperCall(expr, localCallableBindings) ||
      isPrimitiveSnapshotCall(expr, context) ||
      ts.isPropertyAccessExpression(unwrapExpression(expr.expression));
  }

  if (ts.isNewExpression(expr)) {
    return hasNamedTarget(expr.expression, CT_DATA_CONSTRUCTOR_NAMES);
  }

  if (
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr)
  ) {
    return true;
  }

  return false;
}

function createCfDataHelperImport(
  factory: ts.NodeFactory,
): ts.ImportDeclaration {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports([
        factory.createImportSpecifier(
          false,
          factory.createIdentifier("__cf_data"),
          factory.createIdentifier(CF_DATA_HELPER_IDENTIFIER),
        ),
      ]),
    ),
    factory.createStringLiteral("commonfabric"),
    undefined,
  );
}

function isTrustedBuilderCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, isTrustedBuilder);
}

function isTrustedDataHelperCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, isTrustedDataHelper);
}

function isImmediatelyInvokedFunction(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
}

function isIntrinsicCtDataCall(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    (
      target.expression.text === "Array" && target.name.text === "from" ||
      target.expression.text === "Object" &&
        target.name.text === "fromEntries"
    );
}

function isTopLevelLocalHelperCall(
  expression: ts.CallExpression,
  localCallableBindings: ReadonlySet<string>,
): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isIdentifier(target) && localCallableBindings.has(target.text);
}

function isPrimitiveSnapshotCall(
  expression: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression.expression);
  if (!ts.isIdentifier(target)) {
    return false;
  }

  const type = context.checker.getTypeAtLocation(expression);
  return isPrimitiveLikeType(type);
}

function isPrimitiveLikeType(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => isPrimitiveLikeType(member));
  }

  if (type.isIntersection()) {
    return type.types.every((member) => isPrimitiveLikeType(member));
  }

  return !!(
    type.flags &
    (
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void
    )
  );
}

function hasNamedTarget(
  expression: ts.Expression,
  namesOrMatcher: ReadonlySet<string> | ((name: string) => boolean),
): boolean {
  const matchesName = typeof namesOrMatcher === "function"
    ? namesOrMatcher
    : (name: string) => namesOrMatcher.has(name);
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return matchesName(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    return matchesName(target.name.text);
  }
  return false;
}

function collectTopLevelCallableBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
      ) {
        continue;
      }

      const initializer = unwrapExpression(declaration.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        names.add(declaration.name.text);
      }
    }
  }

  return names;
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
