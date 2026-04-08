import ts from "typescript";
import { FUNCTION_HARDENING_HELPER_NAME } from "@commonfabric/utils/sandbox-contract";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class ModuleScopeFunctionHardeningTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const helperName = factory.createUniqueName(FUNCTION_HARDENING_HELPER_NAME);
    let helperNeeded = false;

    const statements = sourceFile.statements.flatMap((statement) =>
      transformTopLevelStatement(statement, context, {
        helperName: helperName.text,
        useHelper: () => {
          helperNeeded = true;
        },
      })
    );

    return factory.updateSourceFile(
      sourceFile,
      helperNeeded
        ? [
          createFunctionHardeningHelper(helperName.text),
          ...statements,
        ]
        : statements,
    );
  }
}

interface HardeningState {
  readonly helperName: string;
  readonly useHelper: () => void;
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
  state: HardeningState,
): ts.Statement[] {
  const { factory, sourceFile } = context;

  if (ts.isFunctionDeclaration(statement)) {
    return transformFunctionDeclaration(statement, sourceFile, factory, state);
  }

  if (ts.isVariableStatement(statement)) {
    return [transformVariableStatement(statement, sourceFile, factory, state)];
  }

  if (
    ts.isExportAssignment(statement) &&
    isDirectFunctionExpression(statement.expression)
  ) {
    state.useHelper();
    return [
      factory.updateExportAssignment(
        statement,
        statement.modifiers,
        wrapWithFunctionHardener(
          statement.expression,
          factory,
          state.helperName,
        ),
      ),
    ];
  }

  return [statement];
}

function transformFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  _sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.Statement[] {
  if (!statement.body) {
    return [statement];
  }

  if (statement.name) {
    state.useHelper();
    return [
      statement,
      factory.createExpressionStatement(
        wrapWithFunctionHardener(
          factory.createIdentifier(statement.name.text),
          factory,
          state.helperName,
        ),
      ),
    ];
  }

  if (!hasDefaultExportModifier(statement.modifiers)) {
    return [statement];
  }

  state.useHelper();
  const defaultName = factory.createUniqueName("__cfDefaultFn");
  const fnExpr = factory.createFunctionExpression(
    retainRuntimeFunctionModifiers(statement.modifiers),
    statement.asteriskToken,
    undefined,
    statement.typeParameters,
    statement.parameters,
    statement.type,
    statement.body,
  );

  return [
    factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            defaultName,
            undefined,
            undefined,
            wrapWithFunctionHardener(fnExpr, factory, state.helperName),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
    factory.createExportAssignment(
      undefined,
      false,
      factory.createIdentifier(defaultName.text),
    ),
  ];
}

function transformVariableStatement(
  statement: ts.VariableStatement,
  _sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.VariableStatement {
  let changed = false;
  const declarations = statement.declarationList.declarations.map(
    (declaration) => {
      if (
        !declaration.initializer ||
        !isDirectFunctionExpression(declaration.initializer)
      ) {
        return declaration;
      }

      changed = true;
      state.useHelper();
      return factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        wrapWithFunctionHardener(
          declaration.initializer,
          factory,
          state.helperName,
        ),
      );
    },
  );

  if (!changed) {
    return statement;
  }

  return factory.updateVariableStatement(
    statement,
    statement.modifiers,
    factory.updateVariableDeclarationList(
      statement.declarationList,
      declarations,
    ),
  );
}

function wrapWithFunctionHardener(
  expression: ts.Expression,
  factory: ts.NodeFactory,
  helperName: string,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier(helperName),
    undefined,
    [expression],
  );
}

function createFunctionHardeningHelper(
  helperName: string,
): ts.FunctionDeclaration {
  const factory = ts.factory;
  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    factory.createIdentifier(helperName),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier("fn"),
        undefined,
        factory.createTypeReferenceNode("Function"),
      ),
    ],
    undefined,
    factory.createBlock([
      factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("Object"),
            "freeze",
          ),
          undefined,
          [factory.createIdentifier("fn")],
        ),
      ),
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier("prototype"),
              undefined,
              undefined,
              factory.createPropertyAccessExpression(
                factory.createIdentifier("fn"),
                "prototype",
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      factory.createIfStatement(
        factory.createBinaryExpression(
          factory.createIdentifier("prototype"),
          factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          factory.createBinaryExpression(
            factory.createTypeOfExpression(
              factory.createIdentifier("prototype"),
            ),
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createStringLiteral("object"),
          ),
        ),
        factory.createBlock([
          factory.createExpressionStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("Object"),
                "freeze",
              ),
              undefined,
              [factory.createIdentifier("prototype")],
            ),
          ),
        ], true),
      ),
      factory.createReturnStatement(factory.createIdentifier("fn")),
    ], true),
  );
}

function isDirectFunctionExpression(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
}

function hasDefaultExportModifier(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): boolean {
  return !!modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.DefaultKeyword
  );
}

function retainRuntimeFunctionModifiers(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): ts.Modifier[] | undefined {
  const retained = modifiers?.filter((modifier): modifier is ts.Modifier =>
    modifier.kind === ts.SyntaxKind.AsyncKeyword
  );
  return retained?.length ? retained : undefined;
}
