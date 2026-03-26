import type { Program } from "@commontools/js-compiler";
import ts from "typescript";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "./runtime-module-policy.ts";
import { verifyCompiledBundleModuleFactoriesWithParser } from "./compiled-bundle-verifier.ts";
import { ModuleVerificationError } from "./module-verification-error.ts";

export { ModuleVerificationError } from "./module-verification-error.ts";

type BindingKind = "builder" | "data" | "function" | "import" | "unknown";

interface BindingInfo {
  kind: BindingKind;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
  captureSafe?: boolean;
  ctDataSafe?: boolean;
  functionNode?: ts.FunctionLikeDeclaration;
  hardeningHelper?: boolean;
}

const TRUSTED_BUILDERS = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
]);
const TRUSTED_DATA_HELPERS = new Set([
  "schema",
  "__ct_data",
  "nonPrivateRandom",
  "safeDateNow",
]);
const SAFE_GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Headers",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Request",
  "RegExp",
  "Response",
  "Set",
  "String",
  "Symbol",
  "TextDecoder",
  "TextEncoder",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "Promise",
  "structuredClone",
  "undefined",
]);
const CT_DATA_GLOBAL_CALLS = new Set([
  "BigInt",
  "Boolean",
  "Number",
  "String",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone",
]);
const CT_DATA_STATIC_CALLS = new Map<string, ReadonlySet<string>>([
  ["Array", new Set(["from"])],
  ["Object", new Set(["entries", "fromEntries", "keys", "values"])],
]);
const CT_DATA_PURE_METHOD_NAMES = new Set([
  "entries",
  "filter",
  "flatMap",
  "find",
  "forEach",
  "get",
  "getFullYear",
  "has",
  "includes",
  "indexOf",
  "join",
  "keys",
  "localeCompare",
  "map",
  "padStart",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "test",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "values",
]);
const CT_DATA_LOCAL_MUTATOR_METHOD_NAMES = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

interface PendingCaptureCheck {
  fn: ts.FunctionLikeDeclaration;
  nodeForError: ts.Node;
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

    verifyStaticImportPolicy(sourceFile);
    rejectDynamicImportExpressions(sourceFile, sourceFile);
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

function rejectDynamicImportExpressions(
  root: ts.Node,
  sourceFile: ts.SourceFile,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) {
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      throw verificationError(
        sourceFile,
        node,
        "Dynamic import() is not allowed in SES mode",
      );
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(root, visit);
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
        captureSafe: true,
      });
      continue;
    }

    for (const element of named.elements) {
      env.set(element.name.text, {
        kind: "import",
        trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
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
  pendingCaptureChecks: PendingCaptureCheck[],
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
      pendingCaptureChecks,
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
      captureSafe: isCaptureSafeDataExpression(expr, env),
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
  pendingCaptureChecks: PendingCaptureCheck[],
): BindingInfo {
  if (isFunctionHardeningHelperCall(expression.expression, env)) {
    return verifyFunctionHardeningCall(
      expression,
      sourceFile,
      env,
      pendingCaptureChecks,
    );
  }

  const trustedName = resolveTrustedCallName(expression.expression, env);
  if (trustedName) {
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

    if (isTrustedSnapshotHelperName(trustedName)) {
      verifyTrustedSnapshotHelperCall(expression, sourceFile);
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

  if (isLocalCallableExpression(expression.expression, env)) {
    verifyLocalTopLevelCall(expression, sourceFile, env);
    return {
      kind: "data",
      captureSafe: false,
    };
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
  pendingCaptureChecks: PendingCaptureCheck[],
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
    pendingCaptureChecks.push({
      fn: target,
      nodeForError: target,
    });
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

function verifyLocalTopLevelCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
): void {
  for (const argument of expression.arguments) {
    verifyTrustedValueExpression(argument, sourceFile, env);
  }
}

function verifyTrustedBuilderCall(
  builderName: string,
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  pendingCaptureChecks: PendingCaptureCheck[],
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
      pendingCaptureChecks.push({
        fn: callbackFn,
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
      verifySchemaCall(expr, sourceFile, env);
      return;
    }
    if (name === "__ct_data") {
      verifyCtDataCall(expr, sourceFile, env);
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
  const visitNestedFunction = (node: ts.FunctionLikeDeclaration) => {
    const nestedBindings = [
      ...(node.name && ts.isIdentifier(node.name) ? [node.name.text] : []),
      ...node.parameters.flatMap((parameter: ts.ParameterDeclaration) =>
        bindingNames(parameter.name)
      ),
    ];
    withScope(nestedBindings, () => {
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visit(parameter.initializer);
        }
      }
      if (node.body) {
        visit(node.body);
      }
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;

    if (isTrackedFunctionLike(node) && node !== fn) {
      visitNestedFunction(node);
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      const hoistedBindings = node.statements.flatMap((statement) =>
        ts.isFunctionDeclaration(statement) && statement.name
          ? [statement.name.text]
          : []
      );
      withScope(hoistedBindings, () => ts.forEachChild(node, visit));
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

function isTrackedFunctionLike(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
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
    ts.isJsxAttribute(parent) && parent.name === node ||
    (
        ts.isJsxOpeningElement(parent) ||
        ts.isJsxSelfClosingElement(parent) ||
        ts.isJsxClosingElement(parent)
      ) && parent.tagName === node ||
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
    return true;
  }

  if (
    ts.isCallExpression(expr) &&
    resolveTrustedCallName(expr.expression, env) === "schema"
  ) {
    return expr.arguments.length === 1 &&
      isTopLevelDataExpression(expr.arguments[0], env);
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

function isCaptureSafeDataExpression(
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

function requiresExplicitCtDataWrap(
  expression: ts.Expression,
): boolean {
  const expr = unwrapExpression(expression);

  return ts.isArrayLiteralExpression(expr) ||
    ts.isObjectLiteralExpression(expr) ||
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    ts.isNewExpression(expr);
}

function verifyCtDataExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const expr = unwrapExpression(expression);

  if (
    isPrimitiveLikeExpression(expr) ||
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral
  ) {
    return;
  }

  if (ts.isIdentifier(expr)) {
    if (isAllowedCtDataIdentifier(expr.text, env, locals)) {
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
      verifyCtDataPropertyName(property.name, sourceFile, env, locals);
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
      if (
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        verifyCtDataFunctionLike(property, sourceFile, env, locals, new Set());
        continue;
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

  if (ts.isCallExpression(expr) && isAllowedCtDataEphemeralCall(expr)) {
    for (const arg of expr.arguments) {
      verifyCtDataExpression(arg, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const compiledExportsBinding = getCompiledExportsBindingName(expr, env);
    if (compiledExportsBinding) {
      if (isAllowedCtDataIdentifier(compiledExportsBinding, env, locals)) {
        return;
      }

      throw verificationError(
        sourceFile,
        expr,
        `__ct_data() cannot capture unsafe top-level identifier '${compiledExportsBinding}'`,
      );
    }

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

  if (ts.isPostfixUnaryExpression(expr)) {
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

  if (ts.isNewExpression(expr)) {
    if (isAllowedCtDataProxy(expr)) {
      verifyCtDataProxyExpression(expr, sourceFile, env, locals);
      return;
    }
    verifyCtDataNewExpression(expr, sourceFile, env, locals);
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
    if (isTrustedSnapshotHelperName(trustedName)) {
      verifyTrustedSnapshotHelperCall(expr, sourceFile);
      return;
    }
    if (isDirectIifeCall(expr)) {
      verifyCtDataIife(expr, sourceFile, env, locals);
      return;
    }
    verifyCtDataCallExpression(expr, sourceFile, env, locals);
    return;
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
  verifyCtDataFunctionLike(target, sourceFile, env, locals, new Set());
}

function isAllowedCtDataIdentifier(
  identifier: string,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): boolean {
  if (
    locals.has(identifier) ||
    identifier === "undefined" ||
    identifier === "NaN" ||
    identifier === "Infinity" ||
    SAFE_GLOBAL_IDENTIFIERS.has(identifier)
  ) {
    return true;
  }

  const binding = env.get(identifier);
  if (!binding) {
    return false;
  }

  if (binding.kind === "data") {
    return binding.captureSafe === true;
  }

  return binding.kind === "function";
}

function verifyCtDataCallExpression(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  if (expression.expression.kind === ts.SyntaxKind.ImportKeyword) {
    throw verificationError(
      sourceFile,
      expression,
      "Dynamic import() is not allowed in __ct_data()",
    );
  }

  const callee = normalizeCallTarget(expression.expression);
  if (ts.isIdentifier(callee)) {
    verifyCtDataIdentifierCall(expression, callee, sourceFile, env, locals);
    return;
  }

  if (ts.isPropertyAccessExpression(callee)) {
    verifyCtDataPropertyCall(expression, callee, sourceFile, env, locals);
    return;
  }

  if (ts.isElementAccessExpression(callee)) {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() does not allow computed method calls",
    );
  }

  throw verificationError(
    sourceFile,
    expression,
    "__ct_data() initializer contains unsupported executable code",
  );
}

function verifyCtDataIdentifierCall(
  expression: ts.CallExpression,
  callee: ts.Identifier,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const binding = env.get(callee.text);
  if (binding?.kind === "function") {
    verifyCtDataCallArguments(expression.arguments, sourceFile, env, locals);
    verifyCtDataTopLevelHelperCall(
      callee,
      sourceFile,
      env,
      new Set(),
    );
    return;
  }

  if (binding?.kind === "import") {
    throw verificationError(
      sourceFile,
      expression,
      `__ct_data() cannot call imported helper '${callee.text}'`,
    );
  }

  if (locals.has(callee.text)) {
    throw verificationError(
      sourceFile,
      expression,
      `__ct_data() cannot call local binding '${callee.text}' unless it is inlined directly`,
    );
  }

  if (!CT_DATA_GLOBAL_CALLS.has(callee.text)) {
    throw verificationError(
      sourceFile,
      expression,
      `__ct_data() cannot call ambient global '${callee.text}'`,
    );
  }

  verifyCtDataCallArguments(expression.arguments, sourceFile, env, locals);
}

function verifyCtDataPropertyCall(
  expression: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const base = normalizeCallTarget(
    callee.expression as ts.LeftHandSideExpression,
  );
  if (
    ts.isIdentifier(base) &&
    isRejectedAmbientCtDataCall(base.text, callee.name.text)
  ) {
    throw verificationError(
      sourceFile,
      expression,
      `__ct_data() must not call ${base.text}.${callee.name.text}() directly`,
    );
  }

  if (
    ts.isIdentifier(base) &&
    CT_DATA_STATIC_CALLS.get(base.text)?.has(callee.name.text)
  ) {
    verifyCtDataCallArguments(expression.arguments, sourceFile, env, locals);
    return;
  }

  const receiverRoot = getAccessRootIdentifier(callee.expression);
  const receiverIsLocal = !!receiverRoot && locals.has(receiverRoot.text);
  const methodName = callee.name.text;
  if (
    !CT_DATA_PURE_METHOD_NAMES.has(methodName) &&
    !(receiverIsLocal && CT_DATA_LOCAL_MUTATOR_METHOD_NAMES.has(methodName))
  ) {
    throw verificationError(
      sourceFile,
      expression,
      `__ct_data() cannot call method '${methodName}' here`,
    );
  }

  verifyCtDataExpression(callee.expression, sourceFile, env, locals);
  verifyCtDataCallArguments(expression.arguments, sourceFile, env, locals);
}

function verifyCtDataCallArguments(
  args: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  for (const arg of args) {
    const target = unwrapExpression(arg);
    if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
      verifyCtDataFunctionLike(target, sourceFile, env, locals, new Set());
      continue;
    }
    verifyCtDataExpression(arg, sourceFile, env, locals);
  }
}

function verifyCtDataTopLevelHelperCall(
  callee: ts.Identifier,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  visiting: Set<string>,
): void {
  const binding = env.get(callee.text);
  if (binding?.kind !== "function" || !binding.functionNode) {
    throw verificationError(
      sourceFile,
      callee,
      `Unknown __ct_data() helper '${callee.text}'`,
    );
  }

  if (binding.ctDataSafe === true || visiting.has(callee.text)) {
    return;
  }

  if (binding.ctDataSafe === false) {
    throw verificationError(
      sourceFile,
      callee,
      `Top-level helper '${callee.text}' is not safe for __ct_data()`,
    );
  }

  visiting.add(callee.text);
  try {
    verifyCtDataFunctionLike(
      binding.functionNode,
      sourceFile,
      env,
      new Set(),
      visiting,
    );
    binding.ctDataSafe = true;
  } catch (error) {
    binding.ctDataSafe = false;
    throw error;
  } finally {
    visiting.delete(callee.text);
  }
}

function verifyCtDataFunctionLike(
  fn: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  outerLocals: Set<string>,
  visiting: Set<string>,
): void {
  const locals = new Set(outerLocals);
  if (fn.name && ts.isIdentifier(fn.name)) {
    locals.add(fn.name.text);
  }
  for (const parameter of fn.parameters) {
    for (const name of bindingNames(parameter.name)) {
      locals.add(name);
    }
    if (parameter.initializer) {
      verifyCtDataExpression(parameter.initializer, sourceFile, env, locals);
    }
  }

  if (!fn.body) {
    return;
  }

  if (ts.isBlock(fn.body)) {
    verifyCtDataBlock(fn.body, sourceFile, env, locals, visiting);
    return;
  }

  verifyCtDataExpression(fn.body, sourceFile, env, locals);
}

function verifyCtDataBlock(
  block: ts.Block,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  outerLocals: Set<string>,
  visiting: Set<string>,
): void {
  const locals = new Set(outerLocals);
  for (const statement of block.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.add(statement.name.text);
    }
  }

  for (const statement of block.statements) {
    verifyCtDataStatement(statement, sourceFile, env, locals, visiting);
  }
}

function verifyCtDataStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
  visiting: Set<string>,
): void {
  if (
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression)
  ) {
    return;
  }

  if (ts.isFunctionDeclaration(statement)) {
    verifyCtDataFunctionLike(statement, sourceFile, env, locals, visiting);
    return;
  }

  if (ts.isVariableStatement(statement)) {
    verifyCtDataVariableStatement(statement, sourceFile, env, locals);
    return;
  }

  if (ts.isReturnStatement(statement)) {
    if (statement.expression) {
      verifyCtDataExpression(statement.expression, sourceFile, env, locals);
    }
    return;
  }

  if (ts.isExpressionStatement(statement)) {
    verifyCtDataExpression(statement.expression, sourceFile, env, locals);
    return;
  }

  if (ts.isIfStatement(statement)) {
    verifyCtDataExpression(statement.expression, sourceFile, env, locals);
    verifyCtDataNestedStatement(
      statement.thenStatement,
      sourceFile,
      env,
      locals,
      visiting,
    );
    if (statement.elseStatement) {
      verifyCtDataNestedStatement(
        statement.elseStatement,
        sourceFile,
        env,
        locals,
        visiting,
      );
    }
    return;
  }

  if (ts.isForStatement(statement)) {
    verifyCtDataForStatement(statement, sourceFile, env, locals, visiting);
    return;
  }

  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
    verifyCtDataForEachStatement(statement, sourceFile, env, locals, visiting);
    return;
  }

  if (ts.isBlock(statement)) {
    verifyCtDataNestedStatement(statement, sourceFile, env, locals, visiting);
    return;
  }

  if (
    ts.isEmptyStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  ) {
    return;
  }

  throw verificationError(
    sourceFile,
    statement,
    "__ct_data() helpers only allow local bindings, loops, conditionals, and synchronous expressions",
  );
}

function verifyCtDataNestedStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
  visiting: Set<string>,
): void {
  if (ts.isBlock(statement)) {
    verifyCtDataBlock(statement, sourceFile, env, locals, visiting);
    return;
  }

  verifyCtDataStatement(statement, sourceFile, env, new Set(locals), visiting);
}

function verifyCtDataVariableStatement(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  for (const declaration of statement.declarationList.declarations) {
    if (!declaration.initializer) {
      throw verificationError(
        sourceFile,
        declaration,
        "__ct_data() locals must be initialized",
      );
    }
    verifyCtDataExpression(declaration.initializer, sourceFile, env, locals);
    for (const name of bindingNames(declaration.name)) {
      locals.add(name);
    }
  }
}

function verifyCtDataForStatement(
  statement: ts.ForStatement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
  visiting: Set<string>,
): void {
  const loopLocals = new Set(locals);
  if (statement.initializer) {
    if (ts.isVariableDeclarationList(statement.initializer)) {
      for (const declaration of statement.initializer.declarations) {
        if (declaration.initializer) {
          verifyCtDataExpression(
            declaration.initializer,
            sourceFile,
            env,
            loopLocals,
          );
        }
        for (const name of bindingNames(declaration.name)) {
          loopLocals.add(name);
        }
      }
    } else {
      verifyCtDataExpression(
        statement.initializer,
        sourceFile,
        env,
        loopLocals,
      );
    }
  }
  if (statement.condition) {
    verifyCtDataExpression(statement.condition, sourceFile, env, loopLocals);
  }
  if (statement.incrementor) {
    verifyCtDataExpression(statement.incrementor, sourceFile, env, loopLocals);
  }
  verifyCtDataNestedStatement(
    statement.statement,
    sourceFile,
    env,
    loopLocals,
    visiting,
  );
}

function verifyCtDataForEachStatement(
  statement: ts.ForOfStatement | ts.ForInStatement,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  outerLocals: Set<string>,
  visiting: Set<string>,
): void {
  const locals = new Set(outerLocals);
  if (ts.isVariableDeclarationList(statement.initializer)) {
    for (const declaration of statement.initializer.declarations) {
      if (declaration.initializer) {
        verifyCtDataExpression(
          declaration.initializer,
          sourceFile,
          env,
          locals,
        );
      }
      for (const name of bindingNames(declaration.name)) {
        locals.add(name);
      }
    }
  } else {
    verifyCtDataExpression(statement.initializer, sourceFile, env, locals);
  }

  verifyCtDataExpression(statement.expression, sourceFile, env, locals);
  verifyCtDataNestedStatement(
    statement.statement,
    sourceFile,
    env,
    locals,
    visiting,
  );
}

function verifyCtDataNewExpression(
  expression: ts.NewExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const target = normalizeCallTarget(expression.expression);
  if (ts.isIdentifier(target)) {
    const binding = env.get(target.text);
    if (binding?.kind === "import") {
      throw verificationError(
        sourceFile,
        expression,
        `__ct_data() cannot construct imported helper '${target.text}'`,
      );
    }

    if (
      !locals.has(target.text) &&
      !SAFE_GLOBAL_IDENTIFIERS.has(target.text) &&
      binding?.kind !== "function"
    ) {
      throw verificationError(
        sourceFile,
        expression,
        `__ct_data() cannot construct '${target.text}' here`,
      );
    }
  } else {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() only allows direct constructor calls",
    );
  }

  for (const arg of expression.arguments ?? []) {
    verifyCtDataExpression(arg, sourceFile, env, locals);
  }
}

function isRejectedAmbientCtDataCall(
  baseName: string,
  propertyName: string,
): boolean {
  return baseName === "Date" && propertyName === "now" ||
    baseName === "Math" && propertyName === "random";
}

function verifyCtDataProxyExpression(
  expression: ts.NewExpression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const args = expression.arguments ?? [];
  if (args.length !== 2) {
    throw verificationError(
      sourceFile,
      expression,
      "__ct_data() Proxy initializers must receive exactly target and handler",
    );
  }

  verifyCtDataExpression(args[0], sourceFile, env, locals);
  verifyCtDataProxyHandlerExpression(args[1], sourceFile, env, locals);
}

function verifyCtDataProxyHandlerExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  const expr = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(expr)) {
    throw verificationError(
      sourceFile,
      expr,
      "__ct_data() Proxy handlers must be object literals",
    );
  }

  for (const property of expr.properties) {
    verifyCtDataPropertyName(property.name, sourceFile, env, locals);
    if (
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      if (isFunctionLikeExpression(unwrapExpression(property.initializer))) {
        continue;
      }
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
      "__ct_data() Proxy handlers must be plain object literals",
    );
  }
}

function verifyCtDataPropertyName(
  name: ts.PropertyName | undefined,
  sourceFile: ts.SourceFile,
  env: Map<string, BindingInfo>,
  locals: Set<string>,
): void {
  if (!name || !ts.isComputedPropertyName(name)) {
    return;
  }
  verifyCtDataExpression(name.expression, sourceFile, env, locals);
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

function isFunctionLikeExpression(
  expression: ts.Expression | undefined,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return !!expression &&
    (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression));
}

function getCompiledExportsBindingName(
  expression: ts.PropertyAccessExpression,
  env: Map<string, BindingInfo>,
): string | undefined {
  if (
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "exports"
  ) {
    return undefined;
  }

  const exportsBinding = env.get("exports");
  if (exportsBinding?.kind !== "import" || !exportsBinding.namespaceImport) {
    return undefined;
  }

  return expression.name.text;
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
    verifyFunctionHardeningCall(expression, sourceFile, env, []);
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

function isAllowedCtDataProxy(expression: ts.NewExpression): boolean {
  return ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Proxy";
}

function isAllowedCtDataEphemeralCall(expression: ts.CallExpression): boolean {
  return ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Symbol";
}

function isTrustedSnapshotHelperName(
  name: string | undefined,
): name is "nonPrivateRandom" | "safeDateNow" {
  return name === "nonPrivateRandom" || name === "safeDateNow";
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

function isDirectIifeCall(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
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
