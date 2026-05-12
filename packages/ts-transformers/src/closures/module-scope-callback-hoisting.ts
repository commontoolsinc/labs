import ts from "typescript";
import {
  isDeclaredWithinFunction,
  isModuleScopedDeclaration,
} from "../ast/scope-analysis.ts";
import { unwrapExpression } from "../utils/expression.ts";
import type { TransformationContext } from "../core/mod.ts";

const HOISTABLE_BUILDER_NAMES = new Set([
  "derive",
  "handler",
  "lift",
  "pattern",
  "patternTool",
]);

export function hoistModuleScopedBuilderCallbacks(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): ts.SourceFile {
  const hoistedStatements: ts.Statement[] = [];

  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, context.tsContext);
    if (!ts.isCallExpression(visited)) {
      return visited;
    }

    const callbackIndices = getBuilderCallbackIndices(visited);
    if (callbackIndices.length === 0) {
      return visited;
    }

    let changed = false;
    const updatedArgs = visited.arguments.map((argument, index) => {
      if (!callbackIndices.includes(index)) {
        return argument;
      }
      if (
        !isFunctionLikeExpression(argument) ||
        !isNestedWithinFunction(argument)
      ) {
        return argument;
      }

      const analysis = analyzeCallbackForHoisting(argument, context.checker);
      if (!analysis.canHoist) {
        // Debug-only diagnostic: builder callbacks (derive/handler/lift/
        // pattern/patternTool) ought to be hoistable to module scope so
        // they become self-contained, sandbox-safe units. When they
        // capture values from enclosing function scope (even plain JS
        // values), hoisting fails silently and the callback runs inline
        // against the live closure. That works in-process today but
        // breaks the self-contained-callback contract — captured values
        // should be passed in as explicit inputs instead.
        //
        // Gated behind `options.debug` because TS symbol resolution on
        // post-ClosureTransformer ASTs produces phantom enclosing-scope
        // hits for synthesized destructured bindings. The diagnostic is
        // useful for targeted investigation of specific files but too
        // noisy to enable in normal builds. The intended population-scale
        // enumeration uses the post-pipeline probe at
        // `test/diagnostics/probe-derive-callback-captures.ts` instead.
        if (
          context.options.debug &&
          analysis.capturedEnclosingNames.size > 0
        ) {
          const names = Array.from(analysis.capturedEnclosingNames).sort()
            .join(", ");
          context.reportDiagnostic({
            severity: "warning",
            type: "pattern-context:non-hoistable-callback",
            message:
              `Builder callback captures enclosing-scope binding(s) [${names}] ` +
              `and cannot be hoisted to module scope. Captured values should ` +
              `be passed in via the inputs argument so the callback stays ` +
              `self-contained.`,
            node: argument,
          });
        }
        return argument;
      }

      changed = true;
      const callbackName = context.factory.createUniqueName(
        "__cfModuleCallback",
      );
      hoistedStatements.push(
        context.factory.createVariableStatement(
          undefined,
          context.factory.createVariableDeclarationList(
            [
              context.factory.createVariableDeclaration(
                callbackName,
                undefined,
                undefined,
                argument,
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
      );
      return callbackName;
    });

    if (!changed) {
      return visited;
    }

    return context.factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      updatedArgs,
    );
  };

  const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile;
  if (hoistedStatements.length === 0) {
    return transformed;
  }

  const insertAt = findHoistInsertionIndex(transformed.statements);
  return context.factory.updateSourceFile(
    transformed,
    [
      ...transformed.statements.slice(0, insertAt),
      ...hoistedStatements,
      ...transformed.statements.slice(insertAt),
    ],
  );
}

function getBuilderCallbackIndices(
  call: ts.CallExpression,
): readonly number[] {
  const callee = unwrapExpression(call.expression);
  const builderName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : undefined;

  if (!builderName || !HOISTABLE_BUILDER_NAMES.has(builderName)) {
    return [];
  }

  switch (builderName) {
    case "derive": {
      const deriveCallback = call.arguments[1];
      return call.arguments.length >= 4 ? [3] : call.arguments.length >= 2 &&
          isFunctionLikeExpression(deriveCallback) &&
          hasSelfDescribingFunctionTypes(deriveCallback)
        ? [1]
        : [];
    }
    case "handler":
    case "lift":
    case "pattern":
    case "patternTool":
      return call.arguments.length >= 1 ? [0] : [];
    default:
      return [];
  }
}

function hasSelfDescribingFunctionTypes(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  if (callback.parameters.length === 0) {
    return true;
  }

  return callback.parameters.every((parameter) => parameter.type !== undefined);
}

interface CallbackHoistAnalysis {
  /** True if the callback can be hoisted to module scope. */
  readonly canHoist: boolean;
  /** Distinct names from enclosing-function scope that the callback captures. */
  readonly capturedEnclosingNames: ReadonlySet<string>;
}

function analyzeCallbackForHoisting(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): CallbackHoistAnalysis {
  let usesModuleScopedReferences = false;
  const capturedEnclosingNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      node !== callback &&
      isFunctionLikeDeclaration(node)
    ) {
      return;
    }

    if (ts.isIdentifier(node)) {
      const scope = getReferenceScope(node, callback, checker);
      if (scope === "module") {
        usesModuleScopedReferences = true;
      } else if (scope === "enclosing") {
        capturedEnclosingNames.add(node.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  for (const parameter of callback.parameters) {
    if (parameter.initializer) {
      visit(parameter.initializer);
    }
  }

  if (callback.body) {
    visit(callback.body);
  }

  return {
    canHoist: usesModuleScopedReferences && capturedEnclosingNames.size === 0,
    capturedEnclosingNames,
  };
}

type ReferenceScope = "local" | "module" | "enclosing" | "other";

function getReferenceScope(
  node: ts.Identifier,
  callback: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): ReferenceScope {
  if (shouldIgnoreReferenceSite(node)) {
    return "local";
  }

  const symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) ??
      getShorthandAssignmentValueSymbol(
        ts.getOriginalNode(node.parent),
        checker,
      )
    : checker.getSymbolAtLocation(node) ??
      getSymbolAtLocation(ts.getOriginalNode(node), checker);
  if (!symbol) {
    return "other";
  }

  const declarations = (symbol.getDeclarations() ?? []).filter((decl) =>
    !ts.isShorthandPropertyAssignment(decl)
  );
  if (declarations.length === 0) {
    return "other";
  }

  if (declarations.every((decl) => isDeclaredWithinFunction(decl, callback))) {
    return "local";
  }

  if (declarations.some((decl) => ts.isTypeParameterDeclaration(decl))) {
    return "local";
  }

  if (
    declarations.some((decl) =>
      ts.isImportSpecifier(decl) ||
      ts.isImportClause(decl) ||
      ts.isNamespaceImport(decl) ||
      isModuleScopedDeclaration(decl)
    )
  ) {
    return "module";
  }

  if (declarations.some((decl) => isDeclaredInEnclosingFunction(decl))) {
    return "enclosing";
  }

  return "other";
}

function shouldIgnoreReferenceSite(node: ts.Identifier): boolean {
  if (!node.parent) {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
  ) {
    return true;
  }

  if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) {
    return true;
  }

  if (ts.isBindingElement(node.parent) && node.parent.propertyName === node) {
    return true;
  }

  if (
    ts.isJsxOpeningElement(node.parent) ||
    ts.isJsxClosingElement(node.parent) ||
    ts.isJsxSelfClosingElement(node.parent)
  ) {
    return true;
  }

  return false;
}

function isDeclaredInEnclosingFunction(decl: ts.Declaration): boolean {
  let current: ts.Node | undefined = decl;
  while (current) {
    if (ts.isFunctionLike(current)) {
      return true;
    }
    if (ts.isSourceFile(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isFunctionLikeExpression(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isFunctionLikeDeclaration(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
}

function isNestedWithinFunction(node: ts.Node): boolean {
  let current = node.parent ?? ts.getOriginalNode(node).parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      return true;
    }
    if (ts.isSourceFile(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function getSymbolAtLocation(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return node && ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)
    : undefined;
}

function getShorthandAssignmentValueSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return node && ts.isShorthandPropertyAssignment(node)
    ? checker.getShorthandAssignmentValueSymbol(node)
    : undefined;
}

function findHoistInsertionIndex(
  statements: readonly ts.Statement[],
): number {
  let index = 0;
  while (
    index < statements.length && ts.isImportDeclaration(statements[index])
  ) {
    index += 1;
  }
  return index;
}
