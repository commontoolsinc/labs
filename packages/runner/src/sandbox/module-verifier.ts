import type { RuntimeProgram } from "../harness/types.ts";
import ts from "typescript";

type BindingKind = "builder" | "data" | "function" | "import";

interface BindingInfo {
  kind: BindingKind;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
}

const TRUSTED_BUILDERS = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
]);
const TRUSTED_DATA_HELPERS = new Set(["schema"]);
const TRUSTED_RUNTIME_MODULES = new Set([
  "commontools",
  "@commontools/builder",
  "@commontools/html",
  "@commontools/runner",
]);
const SAFE_GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "Uint8Array",
  "console",
  "globalThis",
  "undefined",
]);

export class ModuleVerificationError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    message: string,
  ) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = "ModuleVerificationError";
  }
}

export function verifyProgramModuleScope(program: RuntimeProgram): void {
  for (const file of program.files) {
    if (file.name.endsWith(".d.ts")) continue;

    const sourceFile = ts.createSourceFile(
      file.name,
      file.contents,
      ts.ScriptTarget.ESNext,
      true,
      scriptKindForFile(file.name),
    );
    const env = new Map<string, BindingInfo>();

    predeclareImports(sourceFile, env);
    predeclareFunctions(sourceFile, env);

    for (const statement of sourceFile.statements) {
      verifyTopLevelStatement(statement, sourceFile, env);
    }
  }
}

function predeclareImports(
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = getImportSpecifier(statement);
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      env.set(clause.name.text, { kind: "import" });
    }

    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      env.set(named.name.text, {
        kind: "import",
        namespaceImport: true,
        trustedRuntimeName: TRUSTED_RUNTIME_MODULES.has(specifier)
          ? specifier
          : undefined,
      });
      continue;
    }

    for (const element of named.elements) {
      env.set(element.name.text, {
        kind: "import",
        trustedRuntimeName: TRUSTED_RUNTIME_MODULES.has(specifier)
          ? element.propertyName?.text ?? element.name.text
          : undefined,
      });
    }
  }
}

function predeclareFunctions(
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      env.set(statement.name.text, { kind: "function" });
    }
  }
}

function verifyTopLevelStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  if (
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  ) {
    return;
  }

  if (ts.isFunctionDeclaration(statement)) {
    verifyTopLevelFunction(statement, sourceFile, env);
    return;
  }

  if (ts.isVariableStatement(statement)) {
    verifyVariableStatement(statement, sourceFile, env);
    return;
  }

  if (ts.isExportAssignment(statement)) {
    classifyTopLevelExpression(statement.expression, sourceFile, env);
    return;
  }

  if (
    ts.isEnumDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    throw verificationError(
      sourceFile,
      statement,
      "Only direct top-level functions, trusted builder definitions, and verified plain data are allowed in SES mode",
    );
  }

  if (
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression)
  ) {
    return;
  }

  throw verificationError(
    sourceFile,
    statement,
    "Top-level executable statements are not allowed in SES mode",
  );
}

function verifyTopLevelFunction(
  statement: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  if (!statement.body) return;
  rejectCapturedTopLevelData(statement, sourceFile, env);
}

function verifyVariableStatement(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
    throw verificationError(
      sourceFile,
      statement,
      "Top-level mutable bindings are not allowed in SES mode; use trusted builder state instead",
    );
  }

  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      throw verificationError(
        sourceFile,
        declaration.name,
        "Top-level destructuring is not allowed in SES mode",
      );
    }
    if (!declaration.initializer) {
      throw verificationError(
        sourceFile,
        declaration,
        "Top-level const bindings must be initialized in SES mode",
      );
    }

    const kind = classifyTopLevelExpression(
      declaration.initializer,
      sourceFile,
      env,
    );
    env.set(declaration.name.text, { kind });
  }
}

function classifyTopLevelExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): BindingKind {
  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr)
  ) {
    rejectCapturedTopLevelData(expr, sourceFile, env);
    return "function";
  }

  if (isPlainDataExpression(expr, env)) {
    return "data";
  }

  if (ts.isCallExpression(expr)) {
    return classifyCallExpression(expr, sourceFile, env);
  }

  if (ts.isIdentifier(expr)) {
    const binding = env.get(expr.text);
    if (!binding) {
      throw verificationError(
        sourceFile,
        expr,
        `Unknown top-level identifier '${expr.text}' in SES mode`,
      );
    }
    return binding.kind;
  }

  throw verificationError(
    sourceFile,
    expr,
    "Top-level value is not allowed in SES mode",
  );
}

function classifyCallExpression(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): BindingKind {
  const trustedName = resolveTrustedCallName(expression.expression, env);
  if (!trustedName) {
    throw verificationError(
      sourceFile,
      expression.expression,
      "Only trusted builder calls and schema() are allowed at module scope in SES mode",
    );
  }

  if (TRUSTED_DATA_HELPERS.has(trustedName)) {
    if (expression.arguments.length !== 1) {
      throw verificationError(
        sourceFile,
        expression,
        "schema() must receive a single plain-data argument in SES mode",
      );
    }
    if (!isPlainDataExpression(expression.arguments[0], env)) {
      throw verificationError(
        sourceFile,
        expression.arguments[0],
        "schema() arguments must be plain data in SES mode",
      );
    }
    return "data";
  }

  verifyTrustedBuilderCall(trustedName, expression, sourceFile, env);
  return "builder";
}

function verifyTrustedBuilderCall(
  builderName: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const callbackIndexes = callbackIndexesForBuilder(builderName, expression);
  if (callbackIndexes.length === 0) {
    throw verificationError(
      sourceFile,
      expression,
      `Trusted builder '${builderName}' must receive a direct callback in SES mode`,
    );
  }

  for (let i = 0; i < expression.arguments.length; i++) {
    const argument = expression.arguments[i];
    if (callbackIndexes.includes(i)) {
      if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
        throw verificationError(
          sourceFile,
          argument,
          `Trusted builder '${builderName}' must receive a direct callback, not an indirect reference`,
        );
      }
      rejectCapturedTopLevelData(argument, sourceFile, env);
      continue;
    }
    verifyTrustedValueExpression(argument, sourceFile, env);
  }
}

function callbackIndexesForBuilder(
  builderName: string,
  expression: ts.CallExpression,
): number[] {
  switch (builderName) {
    case "pattern":
    case "action":
    case "computed":
      return expression.arguments.length >= 1 ? [0] : [];
    case "lift":
      return expression.arguments.length >= 3
        ? [2]
        : expression.arguments.length >= 1
        ? [0]
        : [];
    case "handler":
      if (
        expression.arguments.length >= 1 &&
        isFunctionLikeExpression(expression.arguments[0])
      ) {
        return [0];
      }
      return expression.arguments.length >= 3 ? [2] : [];
    case "derive":
      return expression.arguments.length >= 4
        ? [3]
        : expression.arguments.length >= 2
        ? [1]
        : [];
    default:
      return [];
  }
}

function verifyTrustedValueExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const expr = unwrapExpression(expression);

  if (isPlainDataExpression(expr, env)) return;

  if (ts.isIdentifier(expr)) {
    if (SAFE_GLOBAL_IDENTIFIERS.has(expr.text)) return;
    if (!env.has(expr.text)) {
      throw verificationError(
        sourceFile,
        expr,
        `Unknown identifier '${expr.text}' in SES-verified module scope`,
      );
    }
    return;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    verifyTrustedValueExpression(expr.expression, sourceFile, env);
    return;
  }

  if (ts.isElementAccessExpression(expr)) {
    verifyTrustedValueExpression(expr.expression, sourceFile, env);
    if (expr.argumentExpression) {
      verifyTrustedValueExpression(expr.argumentExpression, sourceFile, env);
    }
    return;
  }

  if (ts.isCallExpression(expr)) {
    const name = resolveTrustedCallName(expr.expression, env);
    if (name && TRUSTED_DATA_HELPERS.has(name)) {
      if (
        expr.arguments.length !== 1 ||
        !isPlainDataExpression(expr.arguments[0], env)
      ) {
        throw verificationError(
          sourceFile,
          expr,
          "schema() arguments must be plain data in SES mode",
        );
      }
      return;
    }
  }

  throw verificationError(
    sourceFile,
    expr,
    "Only verified plain data and references to verified top-level bindings are allowed here in SES mode",
  );
}

function rejectCapturedTopLevelData(
  fn: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const freeIdentifiers = collectFreeIdentifiers(fn);
  for (const identifier of freeIdentifiers) {
    if (env.get(identifier)?.kind === "data") {
      throw verificationError(
        sourceFile,
        fn,
        `Callback captures top-level data binding '${identifier}', which is disallowed in SES mode`,
      );
    }
  }
}

function collectFreeIdentifiers(fn: ts.FunctionLikeDeclaration): Set<string> {
  const free = new Set<string>();
  const scopes: Array<Set<string>> = [];

  const withScope = (bindings: string[], callback: () => void) => {
    scopes.push(new Set(bindings));
    callback();
    scopes.pop();
  };
  const addBinding = (name: ts.BindingName) => {
    const scope = scopes[scopes.length - 1];
    if (!scope) return;
    for (const binding of bindingNames(name)) {
      scope.add(binding);
    }
  };
  const isBound = (name: string) => scopes.some((scope) => scope.has(name));

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;

    if (ts.isFunctionLike(node) && node !== fn) {
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      withScope([], () => ts.forEachChild(node, visit));
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer);
      addBinding(node.name);
      return;
    }

    if (ts.isParameter(node)) {
      if (node.initializer) visit(node.initializer);
      addBinding(node.name);
      return;
    }

    if (ts.isCatchClause(node)) {
      const names = node.variableDeclaration
        ? bindingNames(node.variableDeclaration.name)
        : [];
      withScope(names, () => visit(node.block));
      return;
    }

    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      if (!isBound(node.text)) {
        free.add(node.text);
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  const initialBindings = [
    ...(fn.name && ts.isIdentifier(fn.name) ? [fn.name.text] : []),
    ...fn.parameters.flatMap((parameter: ts.ParameterDeclaration) =>
      bindingNames(parameter.name)
    ),
  ];
  withScope(initialBindings, () => {
    if (fn.body) visit(fn.body);
  });
  return free;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element: ts.ArrayBindingElement) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAccessExpression(parent) && parent.name === node ||
    ts.isPropertyAssignment(parent) && parent.name === node ||
    ts.isShorthandPropertyAssignment(parent) && parent.name === node ||
    ts.isMethodDeclaration(parent) && parent.name === node ||
    ts.isPropertyDeclaration(parent) && parent.name === node ||
    ts.isBindingElement(parent) && parent.propertyName === node ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeReferenceNode(parent) ||
    ts.isExpressionWithTypeArguments(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isLabeledStatement(parent) && parent.label === node ||
    ts.isBreakOrContinueStatement(parent) && parent.label === node
  ) {
    return false;
  }
  return true;
}

function isPlainDataExpression(
  expression: ts.Expression,
  env: Map<string, BindingInfo>,
): boolean {
  const expr = unwrapExpression(expression);

  if (
    ts.isStringLiteralLike(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    return expr.text === "undefined" || env.get(expr.text)?.kind === "data";
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((element: ts.Expression) =>
      !ts.isSpreadElement(element) &&
      isPlainDataExpression(element, env)
    );
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((property: ts.ObjectLiteralElementLike) => {
      if (ts.isPropertyAssignment(property)) {
        return isPlainDataExpression(property.initializer, env);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return env.get(property.name.text)?.kind === "data";
      }
      return false;
    });
  }

  if (ts.isTemplateExpression(expr)) {
    return expr.templateSpans.every((span: ts.TemplateSpan) =>
      isPlainDataExpression(span.expression, env)
    );
  }

  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return true;
  }

  return false;
}

function resolveTrustedCallName(
  expression: ts.LeftHandSideExpression,
  env: Map<string, BindingInfo>,
): string | undefined {
  if (ts.isIdentifier(expression)) {
    const trustedImportName = env.get(expression.text)?.trustedRuntimeName;
    if (
      trustedImportName &&
      (TRUSTED_BUILDERS.has(trustedImportName) ||
        TRUSTED_DATA_HELPERS.has(trustedImportName))
    ) {
      return trustedImportName;
    }
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.name)
  ) {
    const base = expression.expression;
    if (ts.isIdentifier(base)) {
      const binding = env.get(base.text);
      if (
        binding?.namespaceImport &&
        binding.trustedRuntimeName &&
        (TRUSTED_BUILDERS.has(expression.name.text) ||
          TRUSTED_DATA_HELPERS.has(expression.name.text))
      ) {
        return expression.name.text;
      }
    }
  }

  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let expr = expression;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function isFunctionLikeExpression(
  expression: ts.Expression | undefined,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return !!expression &&
    (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression));
}

function getImportSpecifier(statement: ts.ImportDeclaration): string {
  return ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : "";
}

function scriptKindForFile(name: string): ts.ScriptKind {
  if (name.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (name.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function verificationError(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
): ModuleVerificationError {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return new ModuleVerificationError(
    sourceFile.fileName,
    line + 1,
    character + 1,
    message,
  );
}
