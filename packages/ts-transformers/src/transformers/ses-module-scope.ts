import ts from "typescript";
import { detectCallKind, isFunctionLikeExpression } from "../ast/mod.ts";
import { Transformer } from "../core/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import {
  addSESSentinel,
  collectReferencedIdentifiers,
  createSESHelperExpr,
  createSESItemId,
  toDirectFunctionExpression,
} from "./ses-wrapper-helpers.ts";

const HOISTABLE_BUILDERS = new Set(["derive", "lift", "handler", "action"]);
const TRUSTED_RUNTIME_IMPORTS = new Set([
  "commontools",
  "commontools/schema",
  "turndown",
  "@commontools/html",
  "@commontools/builder",
  "@commontools/runner",
]);
const WELL_KNOWN_GLOBALS = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "Date",
  "RegExp",
  "Error",
  "console",
  "undefined",
]);

export class SESModuleScopeHoistTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, factory, checker } = context;
    const hoistedStatements: ts.Statement[] = [];
    let hoistedLiftCount = 0;
    let hoistedHandlerCount = 0;

    const visit: ts.Visitor = (node) => {
      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      const callKind = detectCallKind(node, checker);
      const builderName = callKind?.kind === "derive"
        ? "derive"
        : callKind?.kind === "builder"
        ? callKind.builderName
        : ts.isCallExpression(node.expression)
        ? (() => {
          const innerKind = detectCallKind(node.expression, checker);
          if (innerKind?.kind === "builder") {
            return innerKind.builderName;
          }
          return getSimpleBuilderName(node.expression.expression);
        })()
        : getSimpleBuilderName(node.expression);

      if (!builderName || !HOISTABLE_BUILDERS.has(builderName)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      if (isAtModuleScope(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      const callback = ts.isCallExpression(node.expression)
        ? resolveBuilderCallback(node.expression, checker)
        : resolveBuilderCallback(node, checker);
      if (
        !callback || !referencesExternalSymbols(callback, checker) ||
        usesCellMethodCalls(callback)
      ) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      const visited = ts.visitEachChild(
        node,
        visit,
        context.tsContext,
      ) as ts.CallExpression;

      if (builderName === "derive") {
        const hoistedName = `__ct_hoisted_lift_${hoistedLiftCount++}`;
        const args = [...visited.arguments];
        const callbackArg = args[args.length - 1]!;
        const capturesArg = args.length >= 2
          ? args[args.length - 2]
          : undefined;
        const schemaArgs = args.length > 2 ? args.slice(0, -2) : [];
        const liftExpr = context.ctHelpers.sourceHasHelpers()
          ? context.ctHelpers.getHelperExpr("lift")
          : factory.createIdentifier("lift");
        hoistedStatements.push(
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createIdentifier(hoistedName),
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    liftExpr,
                    undefined,
                    [...schemaArgs, callbackArg],
                  ),
                ),
              ],
              ts.NodeFlags.Const,
            ),
          ),
        );
        return capturesArg
          ? factory.createCallExpression(
            factory.createIdentifier(hoistedName),
            undefined,
            [capturesArg],
          )
          : factory.createIdentifier(hoistedName);
      }

      if (
        (builderName === "handler" || builderName === "action") &&
        ts.isCallExpression(visited.expression)
      ) {
        const hoistedName = `__ct_hoisted_handler_${hoistedHandlerCount++}`;
        hoistedStatements.push(
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createIdentifier(hoistedName),
                  undefined,
                  undefined,
                  visited.expression,
                ),
              ],
              ts.NodeFlags.Const,
            ),
          ),
        );
        return factory.createCallExpression(
          factory.createIdentifier(hoistedName),
          undefined,
          [...visited.arguments],
        );
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile;
    if (hoistedStatements.length === 0) {
      return transformed;
    }

    const imports: ts.Statement[] = [];
    const rest: ts.Statement[] = [];
    for (const statement of transformed.statements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        imports.push(statement);
      } else {
        rest.push(statement);
      }
    }

    return factory.updateSourceFile(transformed, [
      ...imports,
      ...hoistedStatements,
      ...rest,
    ]);
  }
}

export class SESCanonicalWrapperTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, factory, checker } = context;
    const statements: ts.Statement[] = [];
    const functionDeclarations = sourceFile.statements.filter((
      statement,
    ): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && !!statement.name &&
      !!statement.body
    );
    const orderedStatements = [
      ...sourceFile.statements.filter((statement) =>
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ),
      ...functionDeclarations,
      ...sourceFile.statements.filter((statement) =>
        !(
          ts.isImportDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement) ||
          (ts.isFunctionDeclaration(statement) && !!statement.name &&
            !!statement.body)
        )
      ),
    ];
    const approvedBindings = new Set<string>(
      functionDeclarations.map((statement) => statement.name?.text ?? ""),
    );
    let ordinal = 0;

    for (const statement of orderedStatements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        statements.push(statement);
        continue;
      }

      if (
        ts.isFunctionDeclaration(statement) && statement.name && statement.body
      ) {
        if (isInjectedJSXHelperDeclaration(statement)) {
          statements.push(statement);
          approvedBindings.add(statement.name.text);
          continue;
        }
        const localName = statement.name.text;
        const itemId = createSESItemId(sourceFile, ordinal++, localName);
        const exportAssignments = createExportAssignments(
          factory,
          statement.modifiers,
          localName,
        );
        const wrapped = factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier(localName),
                undefined,
                undefined,
                factory.createCallExpression(
                  createSESHelperExpr(factory, "__ct_fn"),
                  undefined,
                  [
                    factory.createStringLiteral(itemId),
                    toDirectFunctionExpression(factory, statement),
                  ],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        );
        statements.push(
          addSESSentinel(wrapped, sourceFile, ordinal - 1, localName, "fn"),
        );
        statements.push(...exportAssignments);
        approvedBindings.add(localName);
        continue;
      }

      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        if (ts.isIdentifier(statement.expression)) {
          statements.push(
            createExportAssignmentStatement(
              factory,
              "default",
              statement.expression,
            ),
          );
          continue;
        }

        const localName = `__ct_default_export_${ordinal}`;
        const canonicalizedStatements = createCanonicalBindingStatements({
          factory,
          checker,
          sourceFile,
          ordinal,
          localName,
          initializer: statement.expression,
          approvedBindings,
        });
        if (!canonicalizedStatements) {
          statements.push(
            createExportAssignmentStatement(
              factory,
              "default",
              statement.expression,
            ),
          );
          continue;
        }

        statements.push(...canonicalizedStatements);
        statements.push(
          createExportAssignmentStatement(
            factory,
            "default",
            factory.createIdentifier(localName),
          ),
        );
        approvedBindings.add(localName);
        ordinal++;
        continue;
      }

      if (!ts.isVariableStatement(statement)) {
        statements.push(statement);
        continue;
      }

      const modifiers = statement.modifiers;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          statements.push(
            factory.createVariableStatement(
              modifiers,
              factory.createVariableDeclarationList(
                [declaration],
                ts.NodeFlags.Const,
              ),
            ),
          );
          continue;
        }

        const localName = declaration.name.text;
        const initializer = declaration.initializer;
        const exportAssignments = createExportAssignments(
          factory,
          modifiers,
          localName,
        );
        const canonicalizedStatements = createCanonicalBindingStatements({
          factory,
          checker,
          sourceFile,
          ordinal,
          localName,
          initializer,
          approvedBindings,
        });
        if (!canonicalizedStatements) {
          statements.push(statement);
          continue;
        }

        statements.push(...canonicalizedStatements);
        statements.push(...exportAssignments);
        approvedBindings.add(localName);
        ordinal++;
      }
    }

    return factory.updateSourceFile(sourceFile, statements);
  }
}

function createCanonicalBindingStatements(options: {
  factory: ts.NodeFactory;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  ordinal: number;
  localName: string;
  initializer: ts.Expression;
  approvedBindings: ReadonlySet<string>;
}): ts.Statement[] | undefined {
  const {
    factory,
    checker,
    sourceFile,
    ordinal,
    localName,
    initializer,
    approvedBindings,
  } = options;
  const itemId = createSESItemId(sourceFile, ordinal, localName);
  const builderKind = getCanonicalBuilderKind(initializer, checker);

  if (builderKind) {
    const callback = resolveBuilderCallback(
      initializer as ts.CallExpression,
      checker,
    );
    if (!callback) {
      return undefined;
    }
    const wrappedInitializer = factory.createCallExpression(
      createSESHelperExpr(factory, "__ct_builder"),
      undefined,
      [
        factory.createStringLiteral(builderKind),
        factory.createStringLiteral(itemId),
        toDirectFunctionExpression(factory, callback),
      ],
    );
    const wrappedStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(localName),
            undefined,
            undefined,
            wrappedInitializer,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );
    return [
      addSESSentinel(
        wrappedStatement,
        sourceFile,
        ordinal,
        localName,
        "builder",
      ),
      ...createSchemaAssignments(
        factory,
        localName,
        initializer as ts.CallExpression,
        builderKind,
      ),
    ];
  }

  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    const captureIds = collectReferencedIdentifiers(
      initializer.body,
      approvedBindings,
    );
    const helperName = captureIds.length > 0 ? "__ct_pure_fn" : "__ct_fn";
    const wrappedStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(localName),
            undefined,
            undefined,
            factory.createCallExpression(
              createSESHelperExpr(factory, helperName),
              undefined,
              helperName === "__ct_fn"
                ? [
                  factory.createStringLiteral(itemId),
                  toDirectFunctionExpression(factory, initializer),
                ]
                : [
                  factory.createStringLiteral(itemId),
                  factory.createArrayLiteralExpression(
                    captureIds.map((name) => factory.createStringLiteral(name)),
                  ),
                  toDirectFunctionExpression(factory, initializer),
                ],
            ),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );
    return [
      addSESSentinel(
        wrappedStatement,
        sourceFile,
        ordinal,
        localName,
        helperName === "__ct_fn" ? "fn" : "pure-fn",
      ),
    ];
  }

  const captureIds = collectReferencedIdentifiers(
    initializer,
    approvedBindings,
  );
  const wrappedStatement = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(localName),
          undefined,
          undefined,
          factory.createCallExpression(
            createSESHelperExpr(factory, "__ct_data"),
            undefined,
            [
              factory.createStringLiteral(itemId),
              factory.createArrayLiteralExpression(
                captureIds.map((name) => factory.createStringLiteral(name)),
              ),
              encodeStructuredDataInitializer(initializer),
            ],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
  return [
    addSESSentinel(
      wrappedStatement,
      sourceFile,
      ordinal,
      localName,
      "data",
    ),
  ];
}

function createSchemaAssignments(
  factory: ts.NodeFactory,
  localName: string,
  initializer: ts.CallExpression,
  builderKind: "pattern" | "recipe" | "lift" | "handler",
): ts.Statement[] {
  if (isCompilerGeneratedHoistedBuilder(localName)) {
    return [];
  }

  const args = [...initializer.arguments];
  if (builderKind === "lift" && args.length >= 3) {
    return [
      createAssignment(factory, localName, "argumentSchema", args[0]!),
      createAssignment(factory, localName, "resultSchema", args[1]!),
    ];
  }
  if (builderKind === "handler" && args.length >= 3) {
    return [
      createAssignment(
        factory,
        localName,
        "argumentSchema",
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("__ctHelpers"),
            "generateHandlerSchema",
          ),
          undefined,
          [args[0]!, args[1]!],
        ),
      ),
    ];
  }
  if (builderKind === "pattern" && args.length >= 3) {
    return [
      createAssignment(factory, localName, "argumentSchema", args[1]!),
      createAssignment(factory, localName, "resultSchema", args[2]!),
    ];
  }
  if (builderKind === "recipe" && args.length >= 2) {
    return [
      createAssignment(factory, localName, "resultSchema", args[1]!),
    ];
  }
  return [];
}

function isCompilerGeneratedHoistedBuilder(localName: string): boolean {
  return localName.startsWith("__ct_hoisted_lift_");
}

function encodeStructuredDataInitializer(
  initializer: ts.Expression,
): ts.Expression {
  return initializer;
}

const DISALLOWED_NEW_CONSTRUCTORS = new Set([
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "RegExp",
  "Date",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
]);

const DISALLOWED_STATIC_METHOD_TARGETS = new Set([
  "Promise",
  "Symbol",
]);

export function isDisallowedModuleScopeDataInitializer(
  initializer: ts.Expression,
): boolean {
  let disallowed = false;

  const visit = (node: ts.Node): void => {
    if (disallowed) {
      return;
    }

    if (ts.isRegularExpressionLiteral(node)) {
      disallowed = true;
      return;
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DISALLOWED_NEW_CONSTRUCTORS.has(node.expression.text)
    ) {
      disallowed = true;
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      DISALLOWED_STATIC_METHOD_TARGETS.has(node.expression.expression.text)
    ) {
      disallowed = true;
      return;
    }

    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.some((element) => ts.isOmittedExpression(element))) {
        disallowed = true;
        return;
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property) ||
          ts.isMethodDeclaration(property) ||
          ts.isSpreadAssignment(property)
        ) {
          disallowed = true;
          return;
        }
        if (
          ts.isPropertyAssignment(property) &&
          ts.isComputedPropertyName(property.name)
        ) {
          disallowed = true;
          return;
        }
        if (
          ts.isShorthandPropertyAssignment(property) &&
          property.objectAssignmentInitializer
        ) {
          disallowed = true;
          return;
        }
      }
    }

    if (
      node !== initializer &&
      (ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isClassExpression(node))
    ) {
      disallowed = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(initializer);
  return disallowed;
}

function createAssignment(
  factory: ts.NodeFactory,
  localName: string,
  propertyName: string,
  value: ts.Expression,
): ts.Statement {
  return factory.createExpressionStatement(
    factory.createBinaryExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier(localName),
        propertyName,
      ),
      factory.createToken(ts.SyntaxKind.EqualsToken),
      value,
    ),
  );
}

function createExportAssignments(
  factory: ts.NodeFactory,
  modifiers:
    | ts.NodeArray<ts.ModifierLike>
    | readonly ts.ModifierLike[]
    | undefined,
  localName: string,
): ts.Statement[] {
  if (
    !modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  ) {
    return [];
  }

  const exportName =
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      ? "default"
      : localName;

  return [
    createExportAssignmentStatement(
      factory,
      exportName,
      factory.createIdentifier(localName),
    ),
  ];
}

function createExportAssignmentStatement(
  factory: ts.NodeFactory,
  exportName: string,
  value: ts.Expression,
): ts.Statement {
  return [
    factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier("exports"),
          exportName,
        ),
        factory.createToken(ts.SyntaxKind.EqualsToken),
        value,
      ),
    ),
  ][0];
}

function getCanonicalBuilderKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): "pattern" | "recipe" | "lift" | "handler" | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }
  const callKind = detectCallKind(expression, checker);
  if (callKind?.kind === "builder") {
    const name = callKind.builderName;
    if (
      name === "pattern" || name === "recipe" || name === "lift" ||
      name === "handler"
    ) {
      return name;
    }
  }
  const simpleName = getSimpleBuilderName(expression.expression);
  if (
    simpleName === "pattern" || simpleName === "recipe" ||
    simpleName === "lift" || simpleName === "handler"
  ) {
    return simpleName;
  }
  return undefined;
}

function getSimpleBuilderName(
  expression: ts.Expression,
): "pattern" | "recipe" | "lift" | "handler" | "action" | "derive" | undefined {
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : undefined;
  if (
    name === "pattern" || name === "recipe" || name === "lift" ||
    name === "handler" || name === "action" || name === "derive"
  ) {
    return name;
  }
  return undefined;
}

function isAtModuleScope(node: ts.Node): boolean {
  if (node.pos === -1) {
    return false;
  }
  let current = node.parent;
  while (current) {
    if (ts.isSourceFile(current)) return true;
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return false;
}

function isInjectedJSXHelperDeclaration(
  statement: ts.FunctionDeclaration,
): boolean {
  if (statement.name?.text !== "h" || !statement.body) {
    return false;
  }

  const compact = statement.body.getText().replace(/\s+/g, " ").trim();
  return compact.includes("return __ctHelpers.h.apply(null, args);");
}

function resolveBuilderCallback(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclarationBase | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index--) {
    const argument = call.arguments[index];
    if (argument && isFunctionLikeExpression(argument)) {
      return argument as ts.ArrowFunction | ts.FunctionExpression;
    }
    if (argument && ts.isIdentifier(argument)) {
      const resolved = resolveModuleScopeCallbackReference(argument, checker);
      if (resolved) {
        return resolved;
      }
    }
  }
  return undefined;
}

function referencesExternalSymbols(
  callback: ts.FunctionLikeDeclarationBase,
  checker: ts.TypeChecker,
): boolean {
  let hasExternalReference = false;
  const visit = (node: ts.Node): void => {
    if (hasExternalReference) return;
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (WELL_KNOWN_GLOBALS.has(node.text)) {
        return;
      }
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const declarations = symbol.getDeclarations() ?? [];
        if (
          declarations.some((declaration) => isBuiltinDeclaration(declaration))
        ) {
          return;
        }
        if (
          declarations.length > 0 &&
          declarations.every((declaration) =>
            isNestedWithin(declaration, callback)
          )
        ) {
          return;
        }
      }
      hasExternalReference = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  if (!callback.body) {
    return false;
  }

  visit(callback.body);
  return hasExternalReference;
}

function isNestedWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function resolveModuleScopeCallbackReference(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclarationBase | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (
      ts.isFunctionDeclaration(declaration) && declaration.body &&
      isAtModuleScope(declaration)
    ) {
      return declaration;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)) &&
      isAtModuleScope(declaration)
    ) {
      return declaration.initializer;
    }
  }
  return undefined;
}

const CELL_METHOD_NAMES = new Set([
  "get",
  "key",
  "push",
  "send",
  "set",
  "update",
]);

function usesCellMethodCalls(
  callback: ts.FunctionLikeDeclarationBase,
): boolean {
  if (!callback.body) {
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CELL_METHOD_NAMES.has(node.expression.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return found;
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  return false;
}

function isBuiltinDeclaration(declaration: ts.Declaration): boolean {
  const fileName = declaration.getSourceFile().fileName.replace(/\\/g, "/");
  return fileName.endsWith("dom.d.ts") ||
    fileName.endsWith("es2023.d.ts") ||
    fileName.includes("/lib.") ||
    fileName.endsWith("/lib.d.ts");
}

export function isTrustedRuntimeImport(specifier: string): boolean {
  return TRUSTED_RUNTIME_IMPORTS.has(specifier);
}
