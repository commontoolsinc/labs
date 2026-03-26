import type { Program } from "@commontools/js-compiler";
import ts from "typescript";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "./runtime-module-policy.ts";
import { verifyCompiledBundleModuleFactoriesWithParser } from "./compiled-bundle-verifier.ts";
import { ModuleVerificationError } from "./module-verification-error.ts";
import {
  isTrustedSnapshotHelperName,
  SAFE_GLOBAL_IDENTIFIERS,
  TOP_LEVEL_CALL_RESULT_ERROR,
  TRUSTED_BUILDERS,
  TRUSTED_DATA_HELPERS,
} from "./policy.ts";

export { ModuleVerificationError } from "./module-verification-error.ts";

type BindingKind = "builder" | "data" | "function" | "import" | "unknown";

interface BindingInfo {
  kind: BindingKind;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
  functionNode?: ts.FunctionLikeDeclaration;
  hardeningHelper?: boolean;
}

export function verifyProgramModuleScope(program: Program): void {
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

    verifyStaticImportPolicy(sourceFile);
    predeclareImports(sourceFile, env);
    predeclareFunctions(sourceFile, env);
    predeclareVariables(sourceFile, env);

    for (const statement of sourceFile.statements) {
      verifyTopLevelStatement(
        statement,
        sourceFile,
        env,
      );
    }
  }
}

export function verifyCompiledBundleModuleFactories(
  source: string,
  filename = "<bundle>",
): void {
  verifyCompiledBundleModuleFactoriesWithParser(source, filename);
}

function verifyStaticImportPolicy(sourceFile: ts.SourceFile): void {
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      throw verificationError(
        sourceFile,
        statement,
        "Import-equals declarations are not allowed in SES mode",
      );
    }

    if (ts.isImportDeclaration(statement)) {
      const specifier = getImportSpecifier(statement);
      if (!isAllowedAuthoredImportSpecifier(specifier)) {
        throw verificationError(
          sourceFile,
          statement.moduleSpecifier,
          `Static import '${specifier}' is not allowed in SES mode`,
        );
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (!isAllowedAuthoredImportSpecifier(specifier)) {
        throw verificationError(
          sourceFile,
          statement.moduleSpecifier,
          `Static re-export '${specifier}' is not allowed in SES mode`,
        );
      }
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
        trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
          ? specifier
          : undefined,
      });
      continue;
    }

    for (const element of named.elements) {
      env.set(element.name.text, {
        kind: "import",
        trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
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
      env.set(statement.name.text, {
        kind: "function",
        functionNode: statement,
        hardeningHelper: isFunctionHardeningHelperDeclaration(statement),
      });
    }
  }
}

function predeclareVariables(
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) && !env.has(declaration.name.text)
      ) {
        env.set(declaration.name.text, { kind: "unknown" });
      }
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
    verifyTopLevelFunction(statement, env);
    return;
  }

  if (ts.isClassDeclaration(statement)) {
    throw verificationError(
      sourceFile,
      statement,
      "Top-level class declarations are not allowed in SES mode",
    );
  }

  if (ts.isVariableStatement(statement)) {
    verifyVariableStatement(
      statement,
      sourceFile,
      env,
    );
    return;
  }

  if (ts.isExportAssignment(statement)) {
    classifyTopLevelExpression(
      statement.expression,
      sourceFile,
      env,
    );
    return;
  }

  if (
    ts.isEnumDeclaration(statement) ||
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

  if (
    ts.isExpressionStatement(statement) &&
    isAllowedFunctionHardeningStatement(statement.expression, sourceFile, env)
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
  env: Map<string, BindingInfo>,
): void {
  if (!statement.name || !statement.body) return;
  if (isFunctionHardeningHelperDeclaration(statement)) {
    env.set(statement.name.text, {
      kind: "function",
      functionNode: statement,
      hardeningHelper: true,
    });
    return;
  }
  env.set(statement.name.text, {
    kind: "function",
    functionNode: statement,
  });
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

    const provisional = provisionalBindingForTopLevelExpression(
      declaration.initializer,
      env,
    );
    if (provisional) {
      env.set(declaration.name.text, provisional);
    }

    const binding = classifyTopLevelExpression(
      declaration.initializer,
      sourceFile,
      env,
    );
    env.set(declaration.name.text, binding);
  }
}

function provisionalBindingForTopLevelExpression(
  expression: ts.Expression,
  env: Map<string, BindingInfo>,
): BindingInfo | undefined {
  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr)
  ) {
    return {
      kind: "function",
      functionNode: expr,
    };
  }

  if (
    ts.isCallExpression(expr) &&
    isFunctionHardeningHelperCall(expr.expression, env)
  ) {
    if (expr.arguments.length !== 1) {
      return undefined;
    }
    const hardened = unwrapExpression(expr.arguments[0]);
    if (
      ts.isArrowFunction(hardened) ||
      ts.isFunctionExpression(hardened)
    ) {
      return {
        kind: "function",
        functionNode: hardened,
      };
    }
    return undefined;
  }

  if (!ts.isCallExpression(expr)) {
    return undefined;
  }

  const trustedName = resolveTrustedCallName(expr.expression, env);
  if (!trustedName) {
    return undefined;
  }

  if (trustedName === "schema") {
    return {
      kind: "data",
    };
  }

  if (trustedName === "__ct_data" || isTrustedSnapshotHelperName(trustedName)) {
    return {
      kind: "data",
    };
  }

  return {
    kind: "builder",
  };
}

function classifyTopLevelExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr)
  ) {
    return {
      kind: "function",
      functionNode: expr,
    };
  }

  if (
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr)
  ) {
    return classifyReferenceExpression(expr, sourceFile, env);
  }

  if (ts.isCallExpression(expr)) {
    return classifyCallExpression(
      expr,
      sourceFile,
      env,
    );
  }

  if (isTopLevelDataExpression(expr, env)) {
    if (requiresExplicitCtDataWrap(expr)) {
      throw verificationError(
        sourceFile,
        expr,
        "Mutable top-level data must be wrapped in __ct_data() in SES mode",
      );
    }
    return {
      kind: "data",
    };
  }

  if (ts.isIdentifier(expr)) {
    const binding = env.get(expr.text);
    if (!binding || binding.kind === "unknown") {
      throw verificationError(
        sourceFile,
        expr,
        `Unknown top-level identifier '${expr.text}' in SES mode`,
      );
    }
    return cloneBindingInfo(binding);
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
): BindingInfo {
  if (isFunctionHardeningHelperCall(expression.expression, env)) {
    return verifyFunctionHardeningCall(
      expression,
      sourceFile,
      env,
    );
  }

  const trustedName = resolveTrustedCallName(expression.expression, env);
  if (trustedName) {
    if (trustedName === "schema") {
      verifySchemaCall(expression, sourceFile);
      return {
        kind: "data",
      };
    }

    if (trustedName === "__ct_data") {
      verifyCtDataCall(expression, sourceFile);
      return {
        kind: "data",
      };
    }

    if (isTrustedSnapshotHelperName(trustedName)) {
      verifyTrustedSnapshotHelperCall(expression, sourceFile);
      return {
        kind: "data",
      };
    }

    verifyTrustedBuilderCall(
      trustedName,
      expression,
      sourceFile,
      env,
    );
    return {
      kind: "builder",
    };
  }

  if (isLocalCallableExpression(expression.expression, env)) {
    throw verificationError(
      sourceFile,
      expression,
      TOP_LEVEL_CALL_RESULT_ERROR,
    );
  }

  throw verificationError(
    sourceFile,
    expression.expression,
    "Only trusted builder calls, schema(), and canonical function hardening are allowed at module scope in SES mode",
  );
}

function verifyFunctionHardeningCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): BindingInfo {
  if (expression.arguments.length !== 1) {
    throw verificationError(
      sourceFile,
      expression,
      "Function hardening helpers must receive exactly one function value",
    );
  }

  const target = unwrapExpression(expression.arguments[0]);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return {
      kind: "function",
      functionNode: target,
    };
  }

  if (ts.isIdentifier(target)) {
    const binding = env.get(target.text);
    if (binding?.kind === "function" && !binding.hardeningHelper) {
      return cloneBindingInfo(binding);
    }
  }

  throw verificationError(
    sourceFile,
    expression.arguments[0],
    "Function hardening helpers only accept direct functions or previously declared top-level functions",
  );
}

function verifySchemaCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
): void {
  if (expression.arguments.length !== 1) {
    throw verificationError(
      sourceFile,
      expression,
      "schema() must receive exactly one argument in SES mode",
    );
  }
}

function verifyCtDataCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
): void {
  if (expression.arguments.length !== 1) {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() must receive a single initializer expression in SES mode",
    );
  }
}

function verifyTrustedBuilderCall(
  builderName: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const callbackIndexes = callbackIndexesForBuilder(
    builderName,
    expression,
    env,
  );
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
      const callbackFn = resolveTrustedBuilderCallback(argument, env);
      if (!callbackFn) {
        throw verificationError(
          sourceFile,
          argument,
          `Trusted builder '${builderName}' must receive a direct callback, not an indirect reference`,
        );
      }
      continue;
    }
    verifyTrustedValueExpression(argument, sourceFile, env);
  }
}

function callbackIndexesForBuilder(
  builderName: string,
  expression: ts.CallExpression,
  env: Map<string, BindingInfo>,
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
        isTrustedBuilderCallbackArgument(expression.arguments[0], env)
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

function isTrustedBuilderCallbackArgument(
  argument: ts.Expression,
  env: Map<string, BindingInfo>,
): boolean {
  return !!resolveTrustedBuilderCallback(argument, env);
}

function resolveTrustedBuilderCallback(
  argument: ts.Expression,
  env: Map<string, BindingInfo>,
): ts.FunctionLikeDeclaration | undefined {
  const callback = unwrapExpression(argument);
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return callback;
  }

  if (!ts.isIdentifier(callback)) {
    return undefined;
  }

  const binding = env.get(callback.text);
  if (
    binding?.kind !== "function" || !binding.functionNode ||
    binding.hardeningHelper
  ) {
    return undefined;
  }

  return binding.functionNode;
}

function verifyTrustedValueExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const expr = unwrapExpression(expression);

  if (isTopLevelDataExpression(expr, env)) return;

  if (ts.isIdentifier(expr)) {
    if (SAFE_GLOBAL_IDENTIFIERS.has(expr.text)) return;
    const binding = env.get(expr.text);
    if (!binding || binding.kind === "unknown") {
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
    if (name === "schema") {
      verifySchemaCall(expr, sourceFile);
      return;
    }
    if (name === "__ct_data") {
      verifyCtDataCall(expr, sourceFile);
      return;
    }
    if (isTrustedSnapshotHelperName(name)) {
      verifyTrustedSnapshotHelperCall(expr, sourceFile);
      return;
    }
  }

  throw verificationError(
    sourceFile,
    expr,
    "Only verified plain data and references to verified top-level bindings are allowed here in SES mode",
  );
}

function isTopLevelDataExpression(
  expression: ts.Expression,
  env: Map<string, BindingInfo>,
): boolean {
  const expr = unwrapExpression(expression);

  if (
    isPrimitiveLikeExpression(expr) ||
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral
  ) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    const binding = env.get(expr.text);
    return expr.text === "undefined" || expr.text === "NaN" ||
      expr.text === "Infinity" || binding?.kind === "data";
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((element: ts.Expression) =>
      !ts.isSpreadElement(element) &&
      isTopLevelDataExpression(element, env)
    );
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every((property: ts.ObjectLiteralElementLike) => {
      if (ts.isPropertyAssignment(property)) {
        return isTopLevelDataExpression(property.initializer, env);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return env.get(property.name.text)?.kind === "data";
      }
      return false;
    });
  }

  if (ts.isTemplateExpression(expr)) {
    return expr.templateSpans.every((span: ts.TemplateSpan) =>
      isTopLevelDataExpression(span.expression, env)
    );
  }

  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return true;
  }

  if (
    ts.isCallExpression(expr) &&
    resolveTrustedCallName(expr.expression, env) === "__ct_data"
  ) {
    return expr.arguments.length === 1;
  }

  if (
    ts.isCallExpression(expr) &&
    resolveTrustedCallName(expr.expression, env) === "schema"
  ) {
    return expr.arguments.length === 1;
  }

  if (
    ts.isCallExpression(expr) &&
    isTrustedSnapshotHelperName(resolveTrustedCallName(expr.expression, env))
  ) {
    return expr.arguments.length === 0;
  }

  if (ts.isNewExpression(expr)) {
    return isAllowedCtDataCollection(expr) &&
      (expr.arguments ?? []).every((arg) => isTopLevelDataExpression(arg, env));
  }

  return false;
}

function requiresExplicitCtDataWrap(
  expression: ts.Expression,
): boolean {
  const expr = unwrapExpression(expression);

  return ts.isArrayLiteralExpression(expr) ||
    ts.isObjectLiteralExpression(expr) ||
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    ts.isNewExpression(expr);
}

function resolveTrustedCallName(
  expression: ts.LeftHandSideExpression,
  env: Map<string, BindingInfo>,
): string | undefined {
  const callee = normalizeCallTarget(expression);

  if (ts.isIdentifier(callee)) {
    const trustedImportName = env.get(callee.text)?.trustedRuntimeName;
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
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name)
  ) {
    const base = normalizeCallTarget(callee.expression);
    if (ts.isIdentifier(base)) {
      const binding = env.get(base.text);
      if (
        binding?.namespaceImport &&
        binding.trustedRuntimeName &&
        (TRUSTED_BUILDERS.has(callee.name.text) ||
          TRUSTED_DATA_HELPERS.has(callee.name.text))
      ) {
        return callee.name.text;
      }
    }
  }

  return undefined;
}

function classifyReferenceExpression(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const root = getAccessRootIdentifier(expression);
  if (!root) {
    throw verificationError(
      sourceFile,
      expression,
      "Top-level value is not allowed in SES mode",
    );
  }

  if (
    ts.isElementAccessExpression(expression) && expression.argumentExpression
  ) {
    verifyTrustedValueExpression(
      expression.argumentExpression,
      sourceFile,
      env,
    );
  }

  const binding = env.get(root.text);
  if (!binding || binding.kind === "unknown") {
    throw verificationError(
      sourceFile,
      root,
      `Unknown top-level identifier '${root.text}' in SES mode`,
    );
  }
  return cloneBindingInfo(binding);
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

function isFunctionHardeningHelperDeclaration(
  statement: ts.FunctionDeclaration,
): boolean {
  if (!statement.body || statement.parameters.length !== 1) {
    return false;
  }

  const parameter = statement.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
    return false;
  }

  const fnName = parameter.name.text;
  const body = statement.body.statements;
  if (body.length !== 4) {
    return false;
  }

  if (!isObjectFreezeCallStatement(body[0], fnName)) {
    return false;
  }

  const prototypeName = getHardeningPrototypeBindingName(body[1], fnName);
  if (!prototypeName) {
    return false;
  }

  if (!isPrototypeFreezeGuard(body[2], prototypeName)) {
    return false;
  }

  return ts.isReturnStatement(body[3]) &&
    !!body[3].expression &&
    ts.isIdentifier(body[3].expression) &&
    body[3].expression.text === fnName;
}

function isObjectFreezeCallStatement(
  statement: ts.Statement,
  argumentName: string,
): boolean {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }

  const expr = unwrapExpression(statement.expression);
  return ts.isCallExpression(expr) &&
    expr.arguments.length === 1 &&
    ts.isIdentifier(expr.arguments[0]) &&
    expr.arguments[0].text === argumentName &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    expr.expression.name.text === "freeze";
}

function getHardeningPrototypeBindingName(
  statement: ts.Statement,
  fnName: string,
): string | undefined {
  if (!ts.isVariableStatement(statement)) {
    return undefined;
  }

  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
    return undefined;
  }

  if (statement.declarationList.declarations.length !== 1) {
    return undefined;
  }

  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isPropertyAccessExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== fnName ||
    declaration.initializer.name.text !== "prototype"
  ) {
    return undefined;
  }

  return declaration.name.text;
}

function isPrototypeFreezeGuard(
  statement: ts.Statement,
  prototypeName: string,
): boolean {
  if (!ts.isIfStatement(statement) || !statement.thenStatement) {
    return false;
  }

  const condition = unwrapExpression(statement.expression);
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== prototypeName
  ) {
    return false;
  }

  const right = unwrapExpression(condition.right);
  if (
    !ts.isBinaryExpression(right) ||
    right.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !ts.isTypeOfExpression(right.left) ||
    !ts.isIdentifier(right.left.expression) ||
    right.left.expression.text !== prototypeName ||
    !ts.isStringLiteral(right.right) ||
    right.right.text !== "object"
  ) {
    return false;
  }

  const thenStatement = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements[0]
    : statement.thenStatement;
  return !!thenStatement &&
    isObjectFreezeCallStatement(thenStatement, prototypeName);
}

function isAllowedFunctionHardeningStatement(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (!isFunctionHardeningHelperCall(expression.expression, env)) {
    return false;
  }

  if (expression.arguments.length !== 1) {
    return false;
  }

  const target = unwrapExpression(expression.arguments[0]);
  if (!ts.isIdentifier(target)) {
    return false;
  }

  const binding = env.get(target.text);
  if (!binding || binding.kind !== "function" || binding.hardeningHelper) {
    return false;
  }

  try {
    verifyFunctionHardeningCall(expression, sourceFile, env);
    return true;
  } catch {
    return false;
  }
}

function isFunctionHardeningHelperCall(
  expression: ts.LeftHandSideExpression,
  env: Map<string, BindingInfo>,
): boolean {
  const callee = normalizeCallTarget(expression);
  return ts.isIdentifier(callee) &&
    env.get(callee.text)?.hardeningHelper === true;
}

function isLocalCallableExpression(
  expression: ts.LeftHandSideExpression,
  env: Map<string, BindingInfo>,
): boolean {
  const callee = normalizeCallTarget(expression);

  if (ts.isIdentifier(callee)) {
    const binding = env.get(callee.text);
    return !!binding &&
      (
        binding.kind === "function" ||
        (binding.kind === "import" && !binding.trustedRuntimeName)
      );
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const root = getAccessRootIdentifier(callee);
    if (!root) return false;
    const binding = env.get(root.text);
    return !!binding && binding.kind === "import" &&
      !binding.trustedRuntimeName;
  }

  return false;
}

function getAccessRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current: ts.Expression = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function isPrimitiveLikeExpression(expression: ts.Expression): boolean {
  return ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isBigIntLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword;
}

function isAllowedCtDataCollection(expression: ts.NewExpression): boolean {
  return ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "Map" ||
      expression.expression.text === "Set");
}

function verifyTrustedSnapshotHelperCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
): void {
  if (expression.arguments.length !== 0) {
    throw verificationError(
      sourceFile,
      expression,
      "Trusted snapshot helpers must not receive arguments in SES mode",
    );
  }
}

function cloneBindingInfo(binding: BindingInfo): BindingInfo {
  return { ...binding };
}

function normalizeCallTarget(
  expression: ts.Expression,
): ts.Expression {
  let current = unwrapExpression(expression);
  while (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    current = unwrapExpression(current.right);
  }
  return current;
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
