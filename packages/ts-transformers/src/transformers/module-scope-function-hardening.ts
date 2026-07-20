import ts from "typescript";
import {
  BINDING_IDENTITY_HELPER_NAME,
  FUNCTION_HARDENING_HELPER_NAME,
  VERIFIED_BINDING_METADATA_FIELD,
} from "@commonfabric/utils/sandbox-contract";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { normalizeWriterIdentityFile } from "../utils/writer-identity-file.ts";

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
  const fnExpr = factory.createFunctionExpression(
    retainRuntimeFunctionModifiers(statement.modifiers),
    statement.asteriskToken,
    undefined,
    statement.typeParameters,
    statement.parameters,
    statement.type,
    statement.body,
  );

  // Wrapped in place — the same shape the export-assignment branch emits for
  // `export default <fn-expr>` — so no synthetic binding is minted whose
  // declaration and export names would have to be kept in sync.
  return [
    factory.createExportAssignment(
      undefined,
      false,
      wrapWithFunctionHardener(fnExpr, factory, state.helperName),
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
  const exported = hasExportModifier(statement.modifiers);
  const declarations = statement.declarationList.declarations.map(
    (declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
      ) {
        return declaration;
      }
      const initializer = unwrapExpression(declaration.initializer);
      const isTrustedBinding = state.trustedBindingNames.has(
        declaration.name.text,
      );
      const isDirectFunction = isDirectFunctionExpression(initializer);
      const isTrustedCallable = isTrustedBinding &&
        (ts.isCallExpression(initializer) || isDirectFunction);

      if (!isTrustedCallable && !isDirectFunction) {
        return declaration;
      }

      changed = true;
      const inlineBindingAnnotation = isTrustedCallable && exported;
      let rewritten = declaration.initializer;
      if (isTrustedCallable) {
        state.useBindingHelper();
        if (inlineBindingAnnotation) {
          rewritten = annotateBindingIdentifier(
            rewritten,
            declaration.name.text,
            factory,
            state,
          );
        } else {
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
        }
      }

      if (isDirectFunction && isTrustedBinding && !inlineBindingAnnotation) {
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
        return declaration;
      }

      if (isDirectFunction) {
        state.useHelper();
        rewritten = wrapWithFunctionHardener(
          rewritten,
          factory,
          state.helperName,
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
  identifier: ts.Expression,
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
  const value = factory.createIdentifier("value");
  const metadata = factory.createIdentifier("metadata");
  const implementation = factory.createIdentifier("implementation");

  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    factory.createIdentifier(helperName),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        value,
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
      factory.createParameterDeclaration(
        undefined,
        undefined,
        metadata,
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    ],
    undefined,
    factory.createBlock([
      factory.createIfStatement(
        createExtensibleObjectOrFunctionCheck(value, factory),
        factory.createBlock([
          factory.createExpressionStatement(
            createDefineBindingMetadataCall(value, metadata, factory),
          ),
        ], true),
      ),
      factory.createIfStatement(
        factory.createBinaryExpression(
          createObjectOrFunctionCheck(value, factory),
          factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          factory.createBinaryExpression(
            factory.createTypeOfExpression(
              factory.createPropertyAccessExpression(value, "implementation"),
            ),
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createStringLiteral("function"),
          ),
        ),
        factory.createBlock([
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList([
              factory.createVariableDeclaration(
                implementation,
                undefined,
                undefined,
                factory.createPropertyAccessExpression(value, "implementation"),
              ),
            ], ts.NodeFlags.None),
          ),
          factory.createIfStatement(
            createExtensibleObjectOrFunctionCheck(implementation, factory),
            factory.createBlock([
              factory.createExpressionStatement(
                createDefineBindingMetadataCall(
                  implementation,
                  metadata,
                  factory,
                ),
              ),
            ], true),
          ),
        ], true),
      ),
      factory.createReturnStatement(value),
    ], true),
  );
}

function createDefineBindingMetadataCall(
  target: ts.Expression,
  metadata: ts.Expression,
  factory: ts.NodeFactory,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(
      factory.createIdentifier("Object"),
      "defineProperty",
    ),
    undefined,
    [
      target,
      factory.createStringLiteral(VERIFIED_BINDING_METADATA_FIELD),
      factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
          factory.createIdentifier("value"),
          metadata,
        ),
        factory.createPropertyAssignment(
          factory.createIdentifier("configurable"),
          factory.createTrue(),
        ),
      ], true),
    ],
  );
}

function createExtensibleObjectOrFunctionCheck(
  value: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  return factory.createBinaryExpression(
    createObjectOrFunctionCheck(value, factory),
    factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier("Object"),
        "isExtensible",
      ),
      undefined,
      [value],
    ),
  );
}

function createObjectOrFunctionCheck(
  value: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  return factory.createBinaryExpression(
    value,
    factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
    factory.createParenthesizedExpression(
      factory.createBinaryExpression(
        factory.createBinaryExpression(
          factory.createTypeOfExpression(value),
          factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          factory.createStringLiteral("object"),
        ),
        factory.createToken(ts.SyntaxKind.BarBarToken),
        factory.createBinaryExpression(
          factory.createTypeOfExpression(value),
          factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          factory.createStringLiteral("function"),
        ),
      ),
    ),
  );
}

function collectWriteAuthorizedByBindingNames(
  sourceFile: ts.SourceFile,
): Set<string> {
  const bindingPositions = discoverWriteAuthorizedByBindingPositions(
    sourceFile,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const positions = bindingPositions.get(node.typeName.text);
      if (positions) {
        for (const position of positions) {
          const bindingNode = node.typeArguments?.[position];
          if (bindingNode) {
            collectTypeQueryIdentifiers(bindingNode, names);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function discoverWriteAuthorizedByBindingPositions(
  sourceFile: ts.SourceFile,
): Map<string, Set<number>> {
  const positionsByName = new Map<string, Set<number>>([
    ["WriteAuthorizedBy", new Set([1])],
    ["TrustedActionWrite", new Set([1])],
    ["TrustedActionWriteWithIntegrity", new Set([1])],
  ]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (
        !ts.isTypeAliasDeclaration(statement) ||
        !ts.isIdentifier(statement.name)
      ) {
        continue;
      }

      const positions = collectAliasBindingPositions(
        statement,
        positionsByName,
      );
      if (!positions.size) {
        continue;
      }

      const existing = positionsByName.get(statement.name.text) ?? new Set();
      for (const position of positions) {
        if (!existing.has(position)) {
          existing.add(position);
          changed = true;
        }
      }
      positionsByName.set(statement.name.text, existing);
    }
  }

  return positionsByName;
}

function collectAliasBindingPositions(
  declaration: ts.TypeAliasDeclaration,
  positionsByName: ReadonlyMap<string, ReadonlySet<number>>,
): Set<number> {
  const typeParameterPositions = new Map<string, number>();
  declaration.typeParameters?.forEach((parameter, index) => {
    typeParameterPositions.set(parameter.name.text, index);
  });

  const positions = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const bindingPositions = positionsByName.get(node.typeName.text);
      if (bindingPositions) {
        for (const bindingPosition of bindingPositions) {
          const bindingNode = node.typeArguments?.[bindingPosition];
          if (bindingNode) {
            collectTypeParameterPositions(
              bindingNode,
              typeParameterPositions,
              positions,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.type);

  return positions;
}

function collectTypeParameterPositions(
  node: ts.Node,
  typeParameterPositions: ReadonlyMap<string, number>,
  positions: Set<number>,
): void {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const position = typeParameterPositions.get(node.typeName.text);
    if (position !== undefined) {
      positions.add(position);
    }
  }
  ts.forEachChild(
    node,
    (child) =>
      collectTypeParameterPositions(child, typeParameterPositions, positions),
  );
}

function collectTypeQueryIdentifiers(
  node: ts.Node,
  names: Set<string>,
): void {
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
    names.add(node.exprName.text);
  }
  ts.forEachChild(node, (child) => collectTypeQueryIdentifiers(child, names));
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

function hasExportModifier(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): boolean {
  return !!modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword
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
