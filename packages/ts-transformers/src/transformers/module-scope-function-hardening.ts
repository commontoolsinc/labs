import ts from "typescript";
import {
  BINDING_IDENTITY_HELPER_NAME,
  FUNCTION_HARDENING_HELPER_NAME,
  VERIFIED_BINDING_METADATA_FIELD,
} from "@commonfabric/utils/sandbox-contract";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class ModuleScopeFunctionHardeningTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const helperName = factory.createUniqueName(FUNCTION_HARDENING_HELPER_NAME);
    const bindingHelperName = factory.createUniqueName(
      BINDING_IDENTITY_HELPER_NAME,
    );
    let helperNeeded = false;
    let bindingHelperNeeded = false;
    const trustedBindingNames = collectWriteAuthorizedByBindingNames(
      sourceFile,
    );
    const sourceFileName = normalizeWriterIdentityFile(sourceFile.fileName);

    const statements = sourceFile.statements.flatMap((statement) =>
      transformTopLevelStatement(statement, context, {
        helperName: helperName.text,
        bindingHelperName: bindingHelperName.text,
        trustedBindingNames,
        sourceFileName,
        useHelper: () => {
          helperNeeded = true;
        },
        useBindingHelper: () => {
          bindingHelperNeeded = true;
        },
      })
    );

    return factory.updateSourceFile(
      sourceFile,
      [
        ...(bindingHelperNeeded
          ? [
            createBindingIdentityHelper(
              bindingHelperName.text,
            ),
          ]
          : []),
        ...(helperNeeded
          ? [
            createFunctionHardeningHelper(helperName.text),
          ]
          : []),
        ...statements,
      ],
    );
  }
}

interface HardeningState {
  readonly helperName: string;
  readonly bindingHelperName: string;
  readonly trustedBindingNames: ReadonlySet<string>;
  readonly sourceFileName: string;
  readonly useHelper: () => void;
  readonly useBindingHelper: () => void;
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
    return transformVariableStatement(statement, sourceFile, factory, state);
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
    const postStatements: ts.Statement[] = [];
    if (state.trustedBindingNames.has(statement.name.text)) {
      state.useBindingHelper();
      postStatements.push(
        factory.createExpressionStatement(
          annotateBindingIdentifier(
            factory.createIdentifier(statement.name.text),
            statement.name.text,
            factory,
            state,
          ),
        ),
      );
    }
    return [
      statement,
      ...postStatements,
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
): ts.Statement[] {
  let changed = false;
  const postStatements: ts.Statement[] = [];
  const declarations = statement.declarationList.declarations.map(
    (declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !state.trustedBindingNames.has(declaration.name.text)
      ) {
        return declaration;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (
        !ts.isCallExpression(initializer) && !isDirectFunctionExpression(
          initializer,
        )
      ) {
        return declaration;
      }

      changed = true;
      state.useBindingHelper();
      postStatements.push(
        factory.createExpressionStatement(
          annotateBindingIdentifier(
            factory.createIdentifier(declaration.name.text),
            declaration.name.text,
            factory,
            state,
          ),
        ),
      );
      const rewritten = declaration.initializer;
      if (isDirectFunctionExpression(initializer)) {
        state.useHelper();
        postStatements.push(
          factory.createExpressionStatement(
            wrapWithFunctionHardener(
              factory.createIdentifier(declaration.name.text),
              factory,
              state.helperName,
            ),
          ),
        );
      }
      return factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        rewritten,
      );
    },
  );

  if (!changed) {
    return [statement];
  }

  return [
    factory.updateVariableStatement(
      statement,
      statement.modifiers,
      factory.updateVariableDeclarationList(
        statement.declarationList,
        declarations,
      ),
    ),
    ...postStatements,
  ];
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

function annotateBindingIdentifier(
  identifier: ts.Identifier,
  bindingName: string,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier(state.bindingHelperName),
    undefined,
    [
      identifier,
      createBindingIdentityMetadata(bindingName, factory, state),
    ],
  );
}

function createBindingIdentityMetadata(
  bindingName: string,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      factory.createIdentifier("sourceFile"),
      factory.createStringLiteral(state.sourceFileName),
    ),
    factory.createPropertyAssignment(
      factory.createIdentifier("bindingPath"),
      factory.createArrayLiteralExpression([
        factory.createStringLiteral(bindingName),
      ]),
    ),
  ], true);
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

function createBindingIdentityHelper(
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
        factory.createIdentifier("value"),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier("metadata"),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    ],
    undefined,
    factory.createBlock([
      factory.createIfStatement(
        factory.createBinaryExpression(
          factory.createParenthesizedExpression(
            factory.createBinaryExpression(
              factory.createIdentifier("value"),
              factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
              factory.createParenthesizedExpression(
                factory.createBinaryExpression(
                  factory.createBinaryExpression(
                    factory.createTypeOfExpression(
                      factory.createIdentifier("value"),
                    ),
                    factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
                    factory.createStringLiteral("object"),
                  ),
                  factory.createToken(ts.SyntaxKind.BarBarToken),
                  factory.createBinaryExpression(
                    factory.createTypeOfExpression(
                      factory.createIdentifier("value"),
                    ),
                    factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
                    factory.createStringLiteral("function"),
                  ),
                ),
              ),
            ),
          ),
          factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier("Object"),
              "isExtensible",
            ),
            undefined,
            [factory.createIdentifier("value")],
          ),
        ),
        factory.createBlock([
          factory.createExpressionStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("Object"),
                "defineProperty",
              ),
              undefined,
              [
                factory.createIdentifier("value"),
                factory.createStringLiteral(VERIFIED_BINDING_METADATA_FIELD),
                factory.createObjectLiteralExpression([
                  factory.createPropertyAssignment(
                    factory.createIdentifier("value"),
                    factory.createIdentifier("metadata"),
                  ),
                  factory.createPropertyAssignment(
                    factory.createIdentifier("configurable"),
                    factory.createTrue(),
                  ),
                ], true),
              ],
            ),
          ),
        ], true),
      ),
      factory.createReturnStatement(factory.createIdentifier("value")),
    ], true),
  );
}

function collectWriteAuthorizedByBindingNames(
  sourceFile: ts.SourceFile,
): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "WriteAuthorizedBy"
    ) {
      const bindingNode = node.typeArguments?.[1];
      if (
        bindingNode && ts.isTypeQueryNode(bindingNode) &&
        ts.isIdentifier(bindingNode.exprName)
      ) {
        names.add(bindingNode.exprName.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function normalizeWriterIdentityFile(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  const strippedPrefixed = normalized.match(/^\/[^/]+(\/.+)$/)?.[1];
  return strippedPrefixed ?? normalized;
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
