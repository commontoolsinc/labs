import type { Program } from "@commontools/js-compiler";
import ts from "typescript";

type BindingKind = "builder" | "data" | "function" | "import" | "unknown";

interface BindingInfo {
  kind: BindingKind;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
  captureSafe?: boolean;
  functionNode?: ts.FunctionLikeDeclaration;
}

const TRUSTED_BUILDERS = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
]);
const TRUSTED_DATA_HELPERS = new Set(["schema", "__ct_data"]);
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

interface PendingCaptureCheck {
  fn: ts.FunctionLikeDeclaration;
  nodeForError: ts.Node;
}

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
    const pendingCaptureChecks: PendingCaptureCheck[] = [];

    predeclareImports(sourceFile, env);
    predeclareFunctions(sourceFile, env);
    predeclareVariables(sourceFile, env);

    for (const statement of sourceFile.statements) {
      verifyTopLevelStatement(
        statement,
        sourceFile,
        env,
        pendingCaptureChecks,
      );
    }

    for (const pending of pendingCaptureChecks) {
      rejectUnsafeCaptures(
        pending.fn,
        pending.nodeForError,
        sourceFile,
        env,
      );
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
        captureSafe: true,
      });
      continue;
    }

    for (const element of named.elements) {
      env.set(element.name.text, {
        kind: "import",
        trustedRuntimeName: TRUSTED_RUNTIME_MODULES.has(specifier)
          ? element.propertyName?.text ?? element.name.text
          : undefined,
        captureSafe: true,
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
  pendingCaptureChecks: PendingCaptureCheck[],
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
    verifyTopLevelFunction(statement, env, pendingCaptureChecks);
    return;
  }

  if (ts.isVariableStatement(statement)) {
    verifyVariableStatement(
      statement,
      sourceFile,
      env,
      pendingCaptureChecks,
    );
    return;
  }

  if (ts.isExportAssignment(statement)) {
    classifyTopLevelExpression(
      statement.expression,
      sourceFile,
      env,
      pendingCaptureChecks,
    );
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

  if (
    ts.isExpressionStatement(statement) &&
    isAllowedHelperMutationStatement(statement.expression, sourceFile, env)
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
  pendingCaptureChecks: PendingCaptureCheck[],
): void {
  if (!statement.name || !statement.body) return;
  env.set(statement.name.text, {
    kind: "function",
    functionNode: statement,
  });
  pendingCaptureChecks.push({
    fn: statement,
    nodeForError: statement,
  });
}

function verifyVariableStatement(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  pendingCaptureChecks: PendingCaptureCheck[],
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

    const binding = classifyTopLevelExpression(
      declaration.initializer,
      sourceFile,
      env,
      pendingCaptureChecks,
    );
    env.set(declaration.name.text, binding);
  }
}

function classifyTopLevelExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  pendingCaptureChecks: PendingCaptureCheck[],
): BindingInfo {
  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr)
  ) {
    pendingCaptureChecks.push({
      fn: expr,
      nodeForError: expr,
    });
    return {
      kind: "function",
      functionNode: expr,
    };
  }

  if (isTopLevelDataExpression(expr, env)) {
    return {
      kind: "data",
      captureSafe: isCaptureSafeDataExpression(expr, env),
    };
  }

  if (ts.isCallExpression(expr)) {
    return classifyCallExpression(
      expr,
      sourceFile,
      env,
      pendingCaptureChecks,
    );
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
  pendingCaptureChecks: PendingCaptureCheck[],
): BindingInfo {
  const trustedName = resolveTrustedCallName(expression.expression, env);
  if (!trustedName) {
    throw verificationError(
      sourceFile,
      expression.expression,
      "Only trusted builder calls and schema() are allowed at module scope in SES mode",
    );
  }

  if (trustedName === "schema") {
    verifySchemaCall(expression, sourceFile, env);
    return {
      kind: "data",
      captureSafe: false,
    };
  }

  if (trustedName === "__ct_data") {
    verifyCtDataCall(expression, sourceFile, env);
    return {
      kind: "data",
      captureSafe: true,
    };
  }

  verifyTrustedBuilderCall(
    trustedName,
    expression,
    sourceFile,
    env,
    pendingCaptureChecks,
  );
  return {
    kind: "builder",
    captureSafe: true,
  };
}

function verifySchemaCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  if (expression.arguments.length !== 1) {
    throw verificationError(
      sourceFile,
      expression,
      "schema() must receive a single plain-data argument in SES mode",
    );
  }
  if (!isTopLevelDataExpression(expression.arguments[0], env)) {
    throw verificationError(
      sourceFile,
      expression.arguments[0],
      "schema() arguments must be plain data in SES mode",
    );
  }
}

function verifyCtDataCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  if (expression.arguments.length !== 1) {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() must receive a single initializer expression in SES mode",
    );
  }
  verifyCtDataExpression(expression.arguments[0], sourceFile, env, new Set());
}

function verifyTrustedBuilderCall(
  builderName: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  pendingCaptureChecks: PendingCaptureCheck[],
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
      pendingCaptureChecks.push({
        fn: argument,
        nodeForError: argument,
      });
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
      verifySchemaCall(expr, sourceFile, env);
      return;
    }
    if (name === "__ct_data") {
      verifyCtDataCall(expr, sourceFile, env);
      return;
    }
  }

  throw verificationError(
    sourceFile,
    expr,
    "Only verified plain data and references to verified top-level bindings are allowed here in SES mode",
  );
}

function rejectUnsafeCaptures(
  fn: ts.FunctionLikeDeclaration,
  nodeForError: ts.Node,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  const unsafeCapture = findUnsafeCapture(
    fn,
    env,
    new Set(),
  );
  if (!unsafeCapture) return;

  throw verificationError(
    sourceFile,
    nodeForError,
    unsafeCapture.message,
  );
}

function findUnsafeCapture(
  fn: ts.FunctionLikeDeclaration,
  env: Map<string, BindingInfo>,
  visiting: Set<string>,
): { identifier: string; message: string } | undefined {
  const freeIdentifiers = collectFreeIdentifiers(fn);
  for (const identifier of freeIdentifiers) {
    if (SAFE_GLOBAL_IDENTIFIERS.has(identifier)) continue;

    const binding = env.get(identifier);
    if (!binding || binding.kind === "unknown") {
      return {
        identifier,
        message:
          `Callback captures unknown top-level identifier '${identifier}' in SES mode`,
      };
    }

    if (
      binding.kind === "data" &&
      !isBindingCaptureSafe(identifier, env, visiting)
    ) {
      return {
        identifier,
        message:
          `Callback captures top-level data binding '${identifier}', which is disallowed in SES mode`,
      };
    }

    if (
      binding.kind === "function" &&
      !isBindingCaptureSafe(identifier, env, visiting)
    ) {
      return {
        identifier,
        message:
          `Callback captures top-level function binding '${identifier}', which closes over unsafe state in SES mode`,
      };
    }
  }
  return undefined;
}

function isBindingCaptureSafe(
  identifier: string,
  env: Map<string, BindingInfo>,
  visiting: Set<string>,
): boolean {
  const binding = env.get(identifier);
  if (!binding) return false;

  if (binding.kind === "import" || binding.kind === "builder") {
    return true;
  }

  if (binding.kind === "data") {
    return binding.captureSafe ?? false;
  }

  if (binding.kind !== "function" || !binding.functionNode) {
    return false;
  }

  if (binding.captureSafe !== undefined) {
    return binding.captureSafe;
  }

  if (visiting.has(identifier)) {
    return true;
  }

  visiting.add(identifier);
  const unsafeCapture = findUnsafeCapture(binding.functionNode, env, visiting);
  visiting.delete(identifier);
  binding.captureSafe = !unsafeCapture;
  return binding.captureSafe;
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

function isTopLevelDataExpression(
  expression: ts.Expression,
  env: Map<string, BindingInfo>,
): boolean {
  const expr = unwrapExpression(expression);

  if (isPrimitiveLikeExpression(expr)) {
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
    return true;
  }

  if (
    ts.isCallExpression(expr) &&
    resolveTrustedCallName(expr.expression, env) === "schema"
  ) {
    return expr.arguments.length === 1 &&
      isTopLevelDataExpression(expr.arguments[0], env);
  }

  if (ts.isNewExpression(expr)) {
    return isAllowedCtDataCollection(expr) &&
      (expr.arguments ?? []).every((arg) => isTopLevelDataExpression(arg, env));
  }

  return false;
}

function isCaptureSafeDataExpression(
  expression: ts.Expression,
  env: Map<string, BindingInfo>,
): boolean {
  const expr = unwrapExpression(expression);

  if (isPrimitiveLikeExpression(expr)) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    if (
      expr.text === "undefined" || expr.text === "NaN" ||
      expr.text === "Infinity"
    ) {
      return true;
    }
    return env.get(expr.text)?.captureSafe ?? false;
  }

  if (
    ts.isCallExpression(expr) &&
    resolveTrustedCallName(expr.expression, env) === "__ct_data"
  ) {
    return true;
  }

  return false;
}

function verifyCtDataExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const expr = unwrapExpression(expression);

  if (isPrimitiveLikeExpression(expr)) {
    return;
  }

  if (ts.isIdentifier(expr)) {
    if (
      locals.has(expr.text) ||
      expr.text === "undefined" ||
      expr.text === "NaN" ||
      expr.text === "Infinity"
    ) {
      return;
    }

    if (
      env.get(expr.text)?.kind === "data" && env.get(expr.text)?.captureSafe
    ) {
      return;
    }

    throw verificationError(
      sourceFile,
      expr,
      `__ct_data() cannot capture unsafe top-level identifier '${expr.text}'`,
    );
  }

  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) {
        throw verificationError(
          sourceFile,
          element,
          "__ct_data() does not allow spread elements",
        );
      }
      verifyCtDataExpression(element, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) {
        verifyCtDataExpression(property.initializer, sourceFile, env, locals);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (locals.has(property.name.text)) continue;
        if (
          env.get(property.name.text)?.kind === "data" &&
          env.get(property.name.text)?.captureSafe
        ) {
          continue;
        }
      }
      throw verificationError(
        sourceFile,
        property,
        "__ct_data() only allows plain data object literals",
      );
    }
    return;
  }

  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) {
      verifyCtDataExpression(span.expression, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    verifyCtDataExpression(expr.expression, sourceFile, env, locals);
    return;
  }

  if (ts.isElementAccessExpression(expr)) {
    verifyCtDataExpression(expr.expression, sourceFile, env, locals);
    if (expr.argumentExpression) {
      verifyCtDataExpression(expr.argumentExpression, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    verifyCtDataExpression(expr.operand, sourceFile, env, locals);
    return;
  }

  if (ts.isBinaryExpression(expr)) {
    verifyCtDataExpression(expr.left, sourceFile, env, locals);
    verifyCtDataExpression(expr.right, sourceFile, env, locals);
    return;
  }

  if (ts.isConditionalExpression(expr)) {
    verifyCtDataExpression(expr.condition, sourceFile, env, locals);
    verifyCtDataExpression(expr.whenTrue, sourceFile, env, locals);
    verifyCtDataExpression(expr.whenFalse, sourceFile, env, locals);
    return;
  }

  if (ts.isNewExpression(expr) && isAllowedCtDataCollection(expr)) {
    for (const arg of expr.arguments ?? []) {
      verifyCtDataExpression(arg, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isCallExpression(expr)) {
    const trustedName = resolveTrustedCallName(expr.expression, env);
    if (trustedName === "schema") {
      verifySchemaCall(expr, sourceFile, env);
      return;
    }
    if (trustedName === "__ct_data") {
      verifyCtDataCall(expr, sourceFile, env);
      return;
    }
    if (isDirectIifeCall(expr)) {
      verifyCtDataIife(expr, sourceFile, env, locals);
      return;
    }
  }

  throw verificationError(
    sourceFile,
    expr,
    "__ct_data() initializer contains unsupported executable code",
  );
}

function verifyCtDataIife(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  outerLocals: Set<string>,
): void {
  if (expression.arguments.length !== 0) {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() only allows zero-argument IIFEs",
    );
  }

  const target = unwrapExpression(expression.expression);
  if (!ts.isArrowFunction(target) && !ts.isFunctionExpression(target)) {
    throw verificationError(
      sourceFile,
      expression.expression,
      "__ct_data() only allows direct IIFEs",
    );
  }

  if (target.parameters.length !== 0) {
    throw verificationError(
      sourceFile,
      target,
      "__ct_data() IIFEs cannot declare parameters",
    );
  }

  const locals = new Set(outerLocals);
  if (!ts.isBlock(target.body)) {
    verifyCtDataExpression(target.body, sourceFile, env, locals);
    return;
  }

  let sawReturn = false;
  for (const statement of target.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        throw verificationError(
          sourceFile,
          statement,
          "__ct_data() IIFEs only allow const local bindings",
        );
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          throw verificationError(
            sourceFile,
            declaration,
            "__ct_data() IIFEs only allow simple initialized const bindings",
          );
        }
        verifyCtDataExpression(
          declaration.initializer,
          sourceFile,
          env,
          locals,
        );
        locals.add(declaration.name.text);
      }
      continue;
    }

    if (ts.isReturnStatement(statement) && statement.expression) {
      verifyCtDataExpression(statement.expression, sourceFile, env, locals);
      sawReturn = true;
      continue;
    }

    throw verificationError(
      sourceFile,
      statement,
      "__ct_data() IIFEs only allow const bindings and a final return",
    );
  }

  if (!sawReturn) {
    throw verificationError(
      sourceFile,
      target,
      "__ct_data() IIFEs must return a data value",
    );
  }
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

function isAllowedHelperMutationStatement(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): boolean {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return false;
  }

  if (
    !ts.isPropertyAccessExpression(expression.left) ||
    !ts.isIdentifier(expression.left.expression) ||
    expression.left.name.text !== "fragment"
  ) {
    return false;
  }

  const binding = env.get(expression.left.expression.text);
  if (binding?.kind !== "function") {
    return false;
  }

  try {
    verifyTrustedValueExpression(expression.right, sourceFile, env);
    return true;
  } catch {
    return false;
  }
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

function isDirectIifeCall(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
}

function cloneBindingInfo(binding: BindingInfo): BindingInfo {
  return { ...binding };
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
