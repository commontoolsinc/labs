import ts from "typescript";
import type {
  CapabilityParamSummary,
  FunctionCapabilitySummary,
  ReactiveCapability,
} from "../core/mod.ts";

interface MutableCapabilityState {
  readonly reads: Set<string>;
  readonly writes: Set<string>;
  passthrough: boolean;
  wildcard: boolean;
}

interface AccessPathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly dynamic: boolean;
  readonly optional: boolean;
}

const WRITER_METHODS = new Set(["set", "update"]);
const READER_METHODS = new Set(["get"]);
const WILDCARD_OBJECT_METHODS = new Set(["keys", "values", "entries"]);

function encodePath(path: readonly string[]): string {
  return path.join(".");
}

function decodePath(path: string): readonly string[] {
  if (!path) return [];
  return path.split(".");
}

function isLiteralElement(
  expr: ts.Expression | undefined,
): expr is ts.StringLiteral | ts.NumericLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!expr &&
    (ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr));
}

function getLiteralElementText(
  expr: ts.StringLiteral | ts.NumericLiteral | ts.NoSubstitutionTemplateLiteral,
): string {
  if (ts.isNumericLiteral(expr)) {
    return expr.text;
  }
  return expr.text;
}

function extractLiteralPathArguments(
  args: readonly ts.Expression[],
): { path: readonly string[]; dynamic: boolean } {
  const path: string[] = [];
  for (const arg of args) {
    if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    if (ts.isNoSubstitutionTemplateLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    return { path, dynamic: true };
  }
  return { path, dynamic: false };
}

function extractAccessPath(expr: ts.Expression): AccessPathInfo | undefined {
  const path: string[] = [];
  let dynamic = false;
  let optional = false;
  let current: ts.Expression = expr;

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      optional ||= !!current.questionDotToken;
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      optional ||= !!current.questionDotToken;
      if (isLiteralElement(current.argumentExpression)) {
        path.unshift(getLiteralElementText(current.argumentExpression));
      } else {
        dynamic = true;
      }
      current = current.expression;
      continue;
    }

    break;
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  return {
    root: current.text,
    path,
    dynamic,
    optional,
  };
}

function isMemberRootIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function isTopmostMemberNode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function toCapability(state: MutableCapabilityState): ReactiveCapability {
  const hasReads = state.reads.size > 0;
  const hasWrites = state.writes.size > 0;

  if (hasReads && hasWrites) return "writable";
  if (hasReads) return "readonly";
  if (hasWrites) return "writeonly";
  return "opaque";
}

export function analyzeFunctionCapabilities(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): FunctionCapabilitySummary {
  const states = new Map<string, MutableCapabilityState>();

  for (const parameter of fn.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      states.set(parameter.name.text, {
        reads: new Set<string>(),
        writes: new Set<string>(),
        passthrough: false,
        wildcard: false,
      });
    }
  }

  if (states.size === 0) {
    return { params: [] };
  }

  const trackRead = (name: string, path: readonly string[]): void => {
    const state = states.get(name);
    if (!state) return;
    state.reads.add(encodePath(path));
  };

  const trackWrite = (name: string, path: readonly string[]): void => {
    const state = states.get(name);
    if (!state) return;
    state.writes.add(encodePath(path));
  };

  const markWildcard = (name: string): void => {
    const state = states.get(name);
    if (!state) return;
    state.wildcard = true;
  };

  const markPassthrough = (name: string): void => {
    const state = states.get(name);
    if (!state) return;
    state.passthrough = true;
  };

  const markFromExpression = (
    expression: ts.Expression,
    marker: (name: string, path: readonly string[]) => void,
  ): void => {
    const info = extractAccessPath(expression);
    if (!info || !states.has(info.root)) return;
    if (info.dynamic) {
      markWildcard(info.root);
      return;
    }
    marker(info.root, info.path);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && states.has(node.text)) {
      const parent = node.parent;
      if (!isMemberRootIdentifier(node) && (!parent || !ts.isParameter(parent))) {
        markPassthrough(node.text);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      if (isTopmostMemberNode(node)) {
        const info = extractAccessPath(node);
        if (info && states.has(info.root)) {
          if (info.dynamic) {
            markWildcard(info.root);
          } else {
            trackRead(info.root, info.path);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      // Optional-call forms are non-lowerable; treat as wildcard usage.
      if (node.questionDotToken && ts.isExpression(node.expression)) {
        const info = extractAccessPath(node.expression);
        if (info && states.has(info.root)) {
          markWildcard(info.root);
        }
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const calleeInfo = extractAccessPath(node.expression);
        if (calleeInfo && states.has(calleeInfo.root)) {
          const methodName = node.expression.name.text;
          const basePath = calleeInfo.path.slice(0, -1);
          if (methodName === "key") {
            const argPath = extractLiteralPathArguments(node.arguments);
            if (argPath.dynamic) {
              markWildcard(calleeInfo.root);
            } else {
              trackRead(calleeInfo.root, [...basePath, ...argPath.path]);
            }
          } else if (WRITER_METHODS.has(methodName)) {
            trackWrite(calleeInfo.root, basePath);
          } else if (READER_METHODS.has(methodName)) {
            trackRead(calleeInfo.root, basePath);
          }
        }
      }

      // Full-shape operations.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        WILDCARD_OBJECT_METHODS.has(node.expression.name.text)
      ) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          const info = extractAccessPath(firstArg);
          if (info && states.has(info.root)) {
            markWildcard(info.root);
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "stringify"
      ) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          const info = extractAccessPath(firstArg);
          if (info && states.has(info.root)) {
            markWildcard(info.root);
          }
        }
      }
    }

    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        markFromExpression(node.left, trackWrite);
      }
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        markFromExpression(node.operand, trackWrite);
        markFromExpression(node.operand, trackRead);
      }
    }

    if (
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node)
    ) {
      const spreadExpr = node.expression;
      if (spreadExpr) {
        const info = extractAccessPath(spreadExpr);
        if (info && states.has(info.root)) {
          markWildcard(info.root);
        }
      }
    }

    if (ts.isForInStatement(node)) {
      const info = extractAccessPath(node.expression);
      if (info && states.has(info.root)) {
        markWildcard(info.root);
      }
    }

    ts.forEachChild(node, visit);
  };

  if (ts.isBlock(fn.body)) {
    for (const statement of fn.body.statements) {
      visit(statement);
    }
  } else {
    visit(fn.body);
  }

  const params: CapabilityParamSummary[] = [];
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name)) continue;
    const state = states.get(parameter.name.text);
    if (!state) continue;
    params.push({
      name: parameter.name.text,
      capability: toCapability(state),
      readPaths: Array.from(state.reads).map(decodePath),
      writePaths: Array.from(state.writes).map(decodePath),
      passthrough: state.passthrough,
      wildcard: state.wildcard,
    });
  }

  return { params };
}
