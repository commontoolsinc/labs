import ts from "typescript";

const ALLOWED_TSLIB_HELPERS = new Set([
  "__createBinding",
  "__exportStar",
  "__importDefault",
  "__importStar",
  "__setModuleDefault",
]);

export class BundlePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundlePreflightError";
  }
}

export function preflightCompiledBundle(
  source: string,
  filename = "<bundle>",
): void {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );

  if (sourceFile.statements.length !== 1) {
    throw new BundlePreflightError(
      "Compiled bundle must contain a single top-level wrapper",
    );
  }

  const wrapper = unwrapExpressionStatement(sourceFile.statements[0]);
  const body = getWrapperBody(wrapper);

  let phase: "bootstrap" | "define" | "tail" = "bootstrap";
  let sawDefine = false;

  for (const statement of body.statements) {
    if (
      isLoaderBinding(statement) ||
      isRuntimeDepsRegistrationLoop(statement) ||
      isInjectedGlobalBinding(statement) ||
      isTsLibHelperDeclaration(statement)
    ) {
      if (phase !== "bootstrap") {
        throw new BundlePreflightError(
          "Bundle bootstrap helpers must appear before module definitions",
        );
      }
      continue;
    }

    if (isDefineCallStatement(statement)) {
      if (phase === "tail") {
        throw new BundlePreflightError(
          "AMD module definitions must appear before bundle return wiring",
        );
      }
      phase = "define";
      sawDefine = true;
      continue;
    }

    if (isTailStatement(statement)) {
      phase = "tail";
      continue;
    }

    throw new BundlePreflightError(
      "Compiled bundle contains unsupported top-level executable code",
    );
  }

  if (!sawDefine) {
    throw new BundlePreflightError(
      "Compiled bundle must register at least one AMD module",
    );
  }
}

function unwrapExpressionStatement(
  statement: ts.Statement,
): ts.Expression {
  if (!ts.isExpressionStatement(statement)) {
    throw new BundlePreflightError(
      "Compiled bundle must be wrapped in a single expression",
    );
  }
  let expr = statement.expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function getWrapperBody(expression: ts.Expression): ts.Block {
  if (
    ts.isArrowFunction(expression) &&
    ts.isBlock(expression.body)
  ) {
    return expression.body;
  }

  if (ts.isFunctionExpression(expression) && expression.body) {
    return expression.body;
  }

  throw new BundlePreflightError(
    "Compiled bundle wrapper must be a block-bodied function",
  );
}

function isLoaderBinding(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if (statement.declarationList.declarations.length !== 1) return false;

  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isObjectBindingPattern(declaration.name) || !declaration.initializer
  ) {
    return false;
  }

  const names = declaration.name.elements.map((element) =>
    ts.isIdentifier(element.name) ? element.name.text : ""
  );
  if (
    names.length !== 2 || !names.includes("define") ||
    !names.includes("require")
  ) {
    return false;
  }

  return ts.isCallExpression(unwrapExpression(declaration.initializer));
}

function isRuntimeDepsRegistrationLoop(statement: ts.Statement): boolean {
  if (!ts.isForOfStatement(statement)) return false;
  if (!ts.isBlock(statement.statement)) return false;
  if (statement.statement.statements.length !== 1) return false;

  const exprStatement = statement.statement.statements[0];
  if (!ts.isExpressionStatement(exprStatement)) return false;
  if (!ts.isCallExpression(exprStatement.expression)) return false;

  const call = exprStatement.expression;
  return ts.isIdentifier(call.expression) && call.expression.text === "define";
}

function isInjectedGlobalBinding(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if (statement.declarationList.declarations.length !== 1) return false;

  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }

  const initializer = unwrapExpression(declaration.initializer);
  return declaration.name.text === "console" &&
    ts.isPropertyAccessExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "globalThis" &&
    initializer.name.text === "console";
}

function isTsLibHelperDeclaration(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if (statement.declarationList.declarations.length !== 1) return false;

  const declaration = statement.declarationList.declarations[0];
  return ts.isIdentifier(declaration.name) &&
    ALLOWED_TSLIB_HELPERS.has(declaration.name.text) &&
    !!declaration.initializer &&
    isSafeTsLibHelperInitializer(declaration.initializer);
}

function isDefineCallStatement(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === "define";
}

function isTailStatement(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return isTailReturnStatement(statement);
  }

  if (
    !ts.isVariableStatement(statement) && !ts.isExpressionStatement(statement)
  ) {
    return false;
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.length === 1 &&
      isTailVariableDeclaration(statement.declarationList.declarations[0]);
  }

  return isTailExportMapAssignment(statement.expression);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let expr = expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function isSafeTsLibHelperInitializer(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);

  if (
    ts.isIdentifier(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr)
  ) {
    return true;
  }

  if (
    expr.kind === ts.SyntaxKind.ThisKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return isSafeTsLibHelperInitializer(expr.expression);
  }

  if (ts.isElementAccessExpression(expr)) {
    return isSafeTsLibHelperInitializer(expr.expression) &&
      !!expr.argumentExpression &&
      isSafeTsLibHelperInitializer(expr.argumentExpression);
  }

  if (ts.isBinaryExpression(expr)) {
    return (
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) &&
      isSafeTsLibHelperInitializer(expr.left) &&
      isSafeTsLibHelperInitializer(expr.right);
  }

  if (ts.isConditionalExpression(expr)) {
    return isSafeTsLibHelperInitializer(expr.condition) &&
      isSafeTsLibHelperInitializer(expr.whenTrue) &&
      isSafeTsLibHelperInitializer(expr.whenFalse);
  }

  if (ts.isCallExpression(expr)) {
    return isSafeTsLibHelperInitializerIife(expr);
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    return (
      expr.operator === ts.SyntaxKind.ExclamationToken ||
      expr.operator === ts.SyntaxKind.PlusToken ||
      expr.operator === ts.SyntaxKind.MinusToken ||
      expr.operator === ts.SyntaxKind.TildeToken
    ) &&
      isSafeTsLibHelperInitializer(expr.operand);
  }

  return false;
}

function isSafeTsLibHelperInitializerIife(
  expression: ts.CallExpression,
): boolean {
  if (expression.arguments.length !== 0) {
    return false;
  }

  const callee = unwrapExpression(expression.expression);
  if (
    !ts.isFunctionExpression(callee) &&
    !ts.isArrowFunction(callee)
  ) {
    return false;
  }

  return isSafeTsLibHelperIifeBody(callee.body);
}

function isSafeTsLibHelperIifeBody(body: ts.ConciseBody): boolean {
  if (!ts.isBlock(body)) {
    return isSafeTsLibHelperInitializer(body);
  }

  let sawReturn = false;
  for (let i = 0; i < body.statements.length; i++) {
    const statement = body.statements[i];
    if (ts.isVariableStatement(statement)) {
      if (!isSafeTsLibHelperIifeVariableStatement(statement)) {
        return false;
      }
      continue;
    }

    if (ts.isReturnStatement(statement)) {
      if (i !== body.statements.length - 1 || !statement.expression) {
        return false;
      }
      if (!isSafeTsLibHelperInitializer(statement.expression)) {
        return false;
      }
      sawReturn = true;
      continue;
    }

    return false;
  }

  return sawReturn;
}

function isSafeTsLibHelperIifeVariableStatement(
  statement: ts.VariableStatement,
): boolean {
  return statement.declarationList.declarations.every((declaration) =>
    ts.isIdentifier(declaration.name) &&
    !!declaration.initializer &&
    isSafeTsLibHelperInitializer(declaration.initializer)
  );
}

function isTailVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }

  if (declaration.name.text === "main") {
    return isRequireCall(declaration.initializer);
  }

  if (declaration.name.text === "exportMap") {
    return isObjectCreateNullCall(declaration.initializer);
  }

  return false;
}

function isTailReturnStatement(statement: ts.ReturnStatement): boolean {
  if (!statement.expression) return false;

  const value = unwrapExpression(statement.expression);
  if (isRequireCall(value)) {
    return true;
  }

  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 2) {
    return false;
  }

  const names = new Set<string>();
  for (const property of value.properties) {
    if (
      !ts.isShorthandPropertyAssignment(property) ||
      (property.name.text !== "main" && property.name.text !== "exportMap")
    ) {
      return false;
    }
    names.add(property.name.text);
  }

  return names.has("main") && names.has("exportMap");
}

function isTailExportMapAssignment(expression: ts.Expression): boolean {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isElementAccessExpression(expression.left) ||
    !ts.isIdentifier(expression.left.expression) ||
    expression.left.expression.text !== "exportMap" ||
    !expression.left.argumentExpression
  ) {
    return false;
  }

  const key = unwrapExpression(expression.left.argumentExpression);
  return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
    isRequireCall(expression.right);
}

function isRequireCall(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  return ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    expr.arguments.length === 1 &&
    (ts.isStringLiteral(expr.arguments[0]) ||
      ts.isNoSubstitutionTemplateLiteral(expr.arguments[0]));
}

function isObjectCreateNullCall(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  return ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    expr.expression.name.text === "create" &&
    expr.arguments.length === 1 &&
    expr.arguments[0].kind === ts.SyntaxKind.NullKeyword;
}
