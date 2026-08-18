import ts from "typescript";
import {
  BINDING_IDENTITY_HELPER_NAME,
  FUNCTION_HARDENING_HELPER_NAME,
  VERIFIED_BINDING_METADATA_FIELD,
} from "@commonfabric/utils/sandbox-contract";
import {
  detectCallKind,
  resolveCallbackFunctionExpression,
} from "../ast/call-kind.ts";
import { recoverAuthoredPosition } from "../ast/utils.ts";
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
    const sourceFileName = normalizeWriterIdentityFile(
      sourceFile.fileName,
      context.options.canonicalWriterIdentityFile,
    );

    const statements = sourceFile.statements.flatMap((statement) =>
      transformTopLevelStatement(statement, context, {
        helperName: helperName.text,
        bindingHelperName: bindingHelperName.text,
        trustedBindingNames,
        sourceFileName,
        checker: context.checker,
        authoredSourceFile: context.program.getSourceFile(sourceFile.fileName),
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
  readonly checker: ts.TypeChecker;
  /**
   * The parsed AUTHORED file. Recovered lineage ranges index into its text, so
   * it is what resolves them to a line/column and to the authored binding name
   * that encloses them. Absent only if the file left the program.
   */
  readonly authoredSourceFile: ts.SourceFile | undefined;
  readonly useHelper: () => void;
  readonly useBindingHelper: () => void;
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
  state: HardeningState,
): ts.Statement[] {
  const { factory } = context;

  if (ts.isFunctionDeclaration(statement)) {
    return transformFunctionDeclaration(statement, factory, state);
  }

  if (ts.isVariableStatement(statement)) {
    return transformVariableStatement(statement, factory, state);
  }

  if (ts.isExportAssignment(statement)) {
    return transformExportAssignment(statement, factory, state);
  }

  return [statement];
}

/**
 * `export default <expression>`: hardened when the expression is a function,
 * binding-annotated when it is a function-bearing builder call. The exported
 * expression is annotated in place — a default export has no local binding a
 * trailing annotation statement could name.
 */
function transformExportAssignment(
  statement: ts.ExportAssignment,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.Statement[] {
  if (isDirectFunctionExpression(statement.expression)) {
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

  if (statement.isExportEquals) {
    return [statement];
  }

  const artifact = resolveBuilderArtifact(statement.expression, state.checker);
  if (!artifact) {
    return [statement];
  }

  state.useBindingHelper();
  return [
    factory.updateExportAssignment(
      statement,
      statement.modifiers,
      annotateBindingIdentifier(
        statement.expression,
        { artifact },
        factory,
        state,
      ),
    ),
  ];
}

function transformFunctionDeclaration(
  statement: ts.FunctionDeclaration,
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
            { trustedBindingName: statement.name.text, site: statement },
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
      const artifact = resolveBuilderArtifact(
        declaration.initializer,
        state.checker,
      );

      if (!isTrustedCallable && !isDirectFunction && !artifact) {
        return declaration;
      }

      changed = true;
      // A binding that is both trusted and a builder artifact takes ONE
      // annotation carrying both sets of metadata.
      const annotateBinding = isTrustedCallable || artifact !== undefined;
      const inlineBindingAnnotation = annotateBinding && exported;
      let rewritten = declaration.initializer;
      if (annotateBinding) {
        state.useBindingHelper();
        const metadata: BindingIdentityMetadataInput = {
          ...(isTrustedCallable
            ? { trustedBindingName: declaration.name.text }
            : {}),
          ...(artifact ? { artifact } : { site: initializer }),
        };
        if (inlineBindingAnnotation) {
          rewritten = annotateBindingIdentifier(
            rewritten,
            metadata,
            factory,
            state,
          );
        } else {
          postStatements.push(
            factory.createExpressionStatement(
              annotateBindingIdentifier(
                factory.createIdentifier(declaration.name.text),
                metadata,
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

/**
 * A top-level builder artifact that carries an authored function: the builder
 * call itself, plus the function-valued argument whose authored site the
 * annotation reports. `pattern`, `handler`, `lift`, `computed`, `action` and
 * the rest of the builder family qualify; a builder call with no function
 * argument carries no authored function to name and is left alone.
 */
interface BuilderArtifact {
  readonly call: ts.CallExpression;
  readonly fn: ts.ArrowFunction | ts.FunctionExpression;
}

/**
 * The function-bearing builder artifact an expression denotes, if any. Type
 * wrappers are stripped first, so a cast-typed artifact
 * (`const x = handler(...) as XFactory`) resolves like a bare one — the same
 * unwrap `__cfReg` registration performs, and for the same reason.
 *
 * This runs on the fully lowered tree, where synthetic hoists
 * (`__cfLift_N`, `__cfHandler_N`, `__cfPattern_N`) and authored builder consts
 * both present as builder calls: `detectCallKind` recognizes the pipeline's
 * `__cfHelpers.*` spelling as well as the authored imports, so one predicate
 * covers both.
 */
function resolveBuilderArtifact(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): BuilderArtifact | undefined {
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call)) return undefined;
  if (detectCallKind(call, checker)?.kind !== "builder") return undefined;
  // Resolve the callback through identifiers and type wrappers, not just
  // direct function syntax: `handler(onReset)` names an authored function the
  // annotation should locate exactly as `handler((e, s) => …)` does. The
  // resolved declaration's function is the position anchor, so the metadata
  // reports where the callback was WRITTEN, and its enclosing declaration
  // (`onReset`) supplies the binding name.
  for (const argument of call.arguments) {
    const fn = resolveCallbackFunctionExpression(argument, checker);
    if (fn) return { call, fn };
  }
  return undefined;
}

/** What a binding-identity annotation describes. */
interface BindingIdentityMetadataInput {
  /**
   * The binding's own name, present only when it is in the trusted
   * (`WriteAuthorizedBy`) scope. It is what becomes `bindingPath`.
   */
  readonly trustedBindingName?: string;
  /** The builder artifact being annotated, when the value is one. */
  readonly artifact?: BuilderArtifact;
  /** The annotated node, for values that are not builder artifacts. */
  readonly site?: ts.Node;
}

function annotateBindingIdentifier(
  identifier: ts.Expression,
  input: BindingIdentityMetadataInput,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier(state.bindingHelperName),
    undefined,
    [
      identifier,
      createBindingIdentityMetadata(input, factory, state),
    ],
  );
}

/**
 * The metadata object the binding-identity helper stamps onto an annotated
 * value (and onto its `implementation`, when it has one). Fields:
 *
 * - `sourceFile` — the module's normalized writer-identity file name. Always
 *   present.
 * - `bindingPath` — the binding's name, as a one-element path. Present ONLY
 *   for a binding in the trusted (`WriteAuthorizedBy`) scope: together with
 *   `sourceFile` it forms the verified binding identity that authorizes writes,
 *   so a value outside that scope must not carry it.
 * - `position` — where the annotated function was AUTHORED, as
 *   `{ line, col }`. `line` is 1-based and `col` is 0-based, i.e. TypeScript's
 *   own line/character pair with 1 added to the line. Both index into the file
 *   the pipeline transformed, which is the authored file plus the one-line
 *   helper-import prelude injection prepends, so a reader that wants authored
 *   coordinates subtracts that prelude's line (the runner's
 *   `helperInjectionLineOffset` computes it from the authored bytes). Absent
 *   when the value's lineage reaches this stage with no recoverable authored
 *   position.
 * - `bindingName` — the authored name the function was declared under, for
 *   debug display. Absent when it was authored as an inline expression under no
 *   declaration, such as a lifted JSX expression or a `.map` callback.
 *
 * The position describes the artifact's FUNCTION — the callback a builder was
 * given — falling back to the builder call as a whole when the callback's
 * lineage was dropped.
 */
function createBindingIdentityMetadata(
  input: BindingIdentityMetadataInput,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.ObjectLiteralExpression {
  const properties: ts.PropertyAssignment[] = [
    factory.createPropertyAssignment(
      factory.createIdentifier("sourceFile"),
      factory.createStringLiteral(state.sourceFileName),
    ),
  ];

  if (input.trustedBindingName !== undefined) {
    properties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("bindingPath"),
        factory.createArrayLiteralExpression([
          factory.createStringLiteral(input.trustedBindingName),
        ]),
      ),
    );
  }

  const site = resolveAuthoredSite(input, state);
  if (site) {
    properties.push(
      factory.createPropertyAssignment(
        factory.createIdentifier("position"),
        factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            factory.createIdentifier("line"),
            factory.createNumericLiteral(site.line),
          ),
          factory.createPropertyAssignment(
            factory.createIdentifier("col"),
            factory.createNumericLiteral(site.col),
          ),
        ]),
      ),
    );
    if (site.bindingName !== undefined) {
      properties.push(
        factory.createPropertyAssignment(
          factory.createIdentifier("bindingName"),
          factory.createStringLiteral(site.bindingName),
        ),
      );
    }
  }

  return factory.createObjectLiteralExpression(properties, true);
}

/** Where an annotated value was authored, in the shape the metadata reports. */
interface AuthoredSite {
  /** 1-based. */
  readonly line: number;
  /** 0-based. */
  readonly col: number;
  readonly bindingName: string | undefined;
}

/**
 * Resolve the authored line/column — and the authored binding name enclosing
 * it — for the value an annotation describes. The candidates are tried in
 * order, so a builder artifact reports its callback's site and falls back to
 * the whole call only when the callback arrived with no lineage.
 */
function resolveAuthoredSite(
  input: BindingIdentityMetadataInput,
  state: HardeningState,
): AuthoredSite | undefined {
  const authoredSourceFile = state.authoredSourceFile;
  if (!authoredSourceFile) return undefined;

  const candidates = input.artifact
    ? [input.artifact.fn, input.artifact.call]
    : input.site
    ? [input.site]
    : [];

  for (const candidate of candidates) {
    const range = recoverAuthoredPosition(candidate);
    if (!range) continue;
    const enclosing = findAuthoredNodeAt(authoredSourceFile, range.pos);
    // A recovered range starts before the construct's leading trivia; the
    // parsed node covering it reports where its first real token begins.
    const start = enclosing?.node.getStart(authoredSourceFile) ?? range.pos;
    const position = authoredSourceFile.getLineAndCharacterOfPosition(
      start >= range.pos && start < range.end ? start : range.pos,
    );
    return {
      line: position.line + 1,
      col: position.character,
      bindingName: enclosing?.bindingName,
    };
  }
  return undefined;
}

/**
 * Descend the authored tree to the innermost node covering `pos`, carrying the
 * name of the nearest declaration that encloses it.
 *
 * The name is dropped on the way down through a function, because the
 * declaration a function is assigned to does not name what is written INSIDE
 * it: a lift hoisted out of `const doubled = computed(() => count * 2)` is
 * `doubled`, while one hoisted out of a JSX expression in the same pattern's
 * body is anonymous.
 */
function findAuthoredNodeAt(
  sourceFile: ts.SourceFile,
  pos: number,
): { node: ts.Node; bindingName: string | undefined } | undefined {
  let node: ts.Node = sourceFile;
  let bindingName: string | undefined;
  let found = false;

  for (;;) {
    const child = ts.forEachChild(
      node,
      (candidate) =>
        candidate.pos <= pos && pos < candidate.end ? candidate : undefined,
    );
    if (!child) break;
    if (ts.isFunctionLike(node)) bindingName = undefined;
    bindingName = authoredDeclarationName(child) ?? bindingName;
    node = child;
    found = true;
  }

  return found ? { node, bindingName } : undefined;
}

/** The name a declaration binds its value under, for the debug binding name. */
function authoredDeclarationName(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return undefined;
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
