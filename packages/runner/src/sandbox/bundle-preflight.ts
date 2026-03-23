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
  return ts.isPropertyAccessExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "globalThis";
}

function isTsLibHelperDeclaration(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if (statement.declarationList.declarations.length !== 1) return false;

  const declaration = statement.declarationList.declarations[0];
  return ts.isIdentifier(declaration.name) &&
    ALLOWED_TSLIB_HELPERS.has(declaration.name.text);
}

function isDefineCallStatement(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === "define";
}

function isTailStatement(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return true;
  }

  if (
    !ts.isVariableStatement(statement) && !ts.isExpressionStatement(statement)
  ) {
    return false;
  }

  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    return !!declaration && ts.isIdentifier(declaration.name) &&
      (declaration.name.text === "main" ||
        declaration.name.text === "exportMap");
  }

  if (
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isElementAccessExpression(statement.expression.left) &&
    ts.isIdentifier(statement.expression.left.expression) &&
    statement.expression.left.expression.text === "exportMap"
  ) {
    return true;
  }

  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let expr = expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}
