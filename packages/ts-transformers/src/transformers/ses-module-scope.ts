import ts from "typescript";
import {
  detectCallKind,
  isFunctionLikeExpression,
} from "../ast/mod.ts";
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
        ? findCallbackArg(node.expression)
        : findCallbackArg(node);
      if (!callback || !referencesExternalSymbols(callback, checker)) {
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
        const capturesArg = args.length >= 2 ? args[args.length - 2] : undefined;
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
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
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
    const approvedBindings = new Set<string>();
    let ordinal = 0;

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
        statements.push(statement);
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        const localName = statement.name.text;
        const itemId = createSESItemId(sourceFile, ordinal++, localName);
        const wrapped = factory.createVariableStatement(
          statement.modifiers?.filter((modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword
          ),
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
        approvedBindings.add(localName);
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
        const itemId = createSESItemId(sourceFile, ordinal++, localName);
        const initializer = declaration.initializer;
        const builderKind = getCanonicalBuilderKind(initializer, checker);

        if (builderKind) {
          const callback = findCallbackArg(
            initializer as ts.CallExpression,
          );
          if (!callback) {
            statements.push(statement);
            continue;
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
            modifiers,
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
          statements.push(
            addSESSentinel(
              wrappedStatement,
              sourceFile,
              ordinal - 1,
              localName,
              "builder",
            ),
          );

          const schemaAssignments = createSchemaAssignments(
            factory,
            localName,
            initializer as ts.CallExpression,
            builderKind,
          );
          statements.push(...schemaAssignments);
          approvedBindings.add(localName);
          continue;
        }

        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          const captureIds = collectReferencedIdentifiers(
            initializer.body,
            approvedBindings,
          );
          const helperName = captureIds.length > 0
            ? "__ct_pure_fn"
            : "__ct_fn";
          const wrappedStatement = factory.createVariableStatement(
            modifiers,
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
          statements.push(
            addSESSentinel(
              wrappedStatement,
              sourceFile,
              ordinal - 1,
              localName,
              helperName === "__ct_fn" ? "fn" : "pure-fn",
            ),
          );
          approvedBindings.add(localName);
          continue;
        }

        const captureIds = collectReferencedIdentifiers(initializer, approvedBindings);
        const wrappedStatement = factory.createVariableStatement(
          modifiers,
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
                    initializer,
                  ],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        );
        statements.push(
          addSESSentinel(
            wrappedStatement,
            sourceFile,
            ordinal - 1,
            localName,
            "data",
          ),
        );
        approvedBindings.add(localName);
      }
    }

    return factory.updateSourceFile(sourceFile, statements);
  }
}

function createSchemaAssignments(
  factory: ts.NodeFactory,
  localName: string,
  initializer: ts.CallExpression,
  builderKind: "pattern" | "recipe" | "lift" | "handler",
): ts.Statement[] {
  const args = [...initializer.arguments];
  if (builderKind === "lift" && args.length >= 3) {
    return [
      createAssignment(factory, localName, "argumentSchema", args[0]!),
      createAssignment(factory, localName, "resultSchema", args[1]!),
    ];
  }
  if ((builderKind === "handler" || builderKind === "pattern") && args.length >= 3) {
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

function findCallbackArg(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index--) {
    const argument = call.arguments[index];
    if (argument && isFunctionLikeExpression(argument)) {
      return argument as ts.ArrowFunction | ts.FunctionExpression;
    }
  }
  return undefined;
}

function referencesExternalSymbols(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  const localNames = new Set<string>();
  for (const parameter of callback.parameters) {
    collectBindingNames(parameter.name, localNames);
  }

  let hasExternalReference = false;
  const visit = (node: ts.Node): void => {
    if (hasExternalReference) return;
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, localNames);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      localNames.add(node.name.text);
    }
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (localNames.has(node.text)) return;
      if (WELL_KNOWN_GLOBALS.has(node.text)) {
        return;
      }
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const declarations = symbol.getDeclarations() ?? [];
        if (declarations.some((declaration) => isBuiltinDeclaration(declaration))) {
          return;
        }
      }
      hasExternalReference = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return hasExternalReference;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
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
