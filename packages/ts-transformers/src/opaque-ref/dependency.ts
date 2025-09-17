import ts from "typescript";

import { isFunctionParameter, isOpaqueRefType } from "./types.ts";
import { detectCallKind } from "./call-kind.ts";

export interface DependencyScopeParameter {
  readonly name: string;
  readonly symbol: ts.Symbol;
  readonly declaration?: ts.ParameterDeclaration;
}

export interface DependencyScope {
  readonly id: number;
  readonly parentId: number | null;
  readonly parameters: readonly DependencyScopeParameter[];
}

export interface DependencyNode {
  readonly id: number;
  readonly expression: ts.Expression;
  readonly canonicalKey: string;
  readonly parentId: number | null;
  readonly scopeId: number;
}

export interface OpaqueDependencyGraph {
  readonly nodes: readonly DependencyNode[];
  readonly scopes: readonly DependencyScope[];
  readonly rootScopeId: number;
}

export type RewriteHint =
  | { kind: "call-if-else"; predicate: ts.Expression }
  | { kind: "skip-call-rewrite"; reason: "array-map" | "builder" }
  | undefined;

export interface OpaqueExpressionAnalysis {
  containsOpaqueRef: boolean;
  requiresRewrite: boolean;
  dependencies: ts.Expression[];
  nodes: DependencyNode[];
  graph: OpaqueDependencyGraph;
  rewriteHint?: RewriteHint;
}

export function dedupeExpressions(
  expressions: ts.Expression[],
  sourceFile: ts.SourceFile,
): ts.Expression[] {
  const seen = new Map<string, ts.Expression>();
  for (const expr of expressions) {
    const key = expr.getText(sourceFile);
    if (!seen.has(key)) {
      seen.set(key, expr);
    }
  }
  return Array.from(seen.values());
}

interface DependencyScopeInternal {
  readonly id: number;
  readonly parentId: number | null;
  readonly parameterSymbols: ts.Symbol[];
  readonly aggregated: Set<ts.Symbol>;
}

interface AnalyzerContext {
  nextNodeId: number;
  nextScopeId: number;
  readonly nodes: DependencyNode[];
  readonly scopes: Map<number, DependencyScopeInternal>;
}

interface InternalAnalysis {
  containsOpaqueRef: boolean;
  requiresRewrite: boolean;
  dependencies: ts.Expression[];
  nodes: DependencyNode[];
  rewriteHint?: RewriteHint;
}

const emptyAnalysis = (): InternalAnalysis => ({
  containsOpaqueRef: false,
  requiresRewrite: false,
  dependencies: [],
  nodes: [],
  rewriteHint: undefined,
});

const mergeAnalyses = (...analyses: InternalAnalysis[]): InternalAnalysis => {
  let contains = false;
  let requires = false;
  const dependencies: ts.Expression[] = [];
  const nodes: DependencyNode[] = [];
  for (const analysis of analyses) {
    if (!analysis) continue;
    contains ||= analysis.containsOpaqueRef;
    requires ||= analysis.requiresRewrite;
    dependencies.push(...analysis.dependencies);
    nodes.push(...analysis.nodes);
  }
  return {
    containsOpaqueRef: contains,
    requiresRewrite: requires,
    dependencies,
    nodes,
    rewriteHint: undefined,
  };
};

export function createDependencyAnalyzer(
  checker: ts.TypeChecker,
): (expression: ts.Expression) => OpaqueExpressionAnalysis {
  const createScope = (
    context: AnalyzerContext,
    parent: DependencyScopeInternal | null,
    parameterSymbols: ts.Symbol[],
  ): DependencyScopeInternal => {
    const aggregated = parent
      ? new Set(parent.aggregated)
      : new Set<ts.Symbol>();
    for (const symbol of parameterSymbols) aggregated.add(symbol);
    const scope: DependencyScopeInternal = {
      id: context.nextScopeId++,
      parentId: parent ? parent.id : null,
      parameterSymbols,
      aggregated,
    };
    context.scopes.set(scope.id, scope);
    return scope;
  };

  const createCanonicalKey = (
    expression: ts.Expression,
    scope: DependencyScopeInternal,
  ): string => {
    const sourceFile = expression.getSourceFile();
    const text = expression.getText(sourceFile);
    return `${scope.id}:${text}`;
  };

  const toDependencyScope = (
    scope: DependencyScopeInternal,
  ): DependencyScope => ({
    id: scope.id,
    parentId: scope.parentId,
    parameters: scope.parameterSymbols.map((symbol) => {
      const declarations = symbol.getDeclarations();
      const parameterDecl = declarations?.find((
        decl,
      ): decl is ts.ParameterDeclaration => ts.isParameter(decl));
      return {
        name: symbol.getName(),
        symbol,
        declaration: parameterDecl,
      };
    }),
  });

  const analyzeExpression = (
    expression: ts.Expression,
    scope: DependencyScopeInternal,
    context: AnalyzerContext,
  ): InternalAnalysis => {
    const isSymbolIgnored = (symbol: ts.Symbol | undefined): boolean => {
      if (!symbol) return false;
      if (scope.aggregated.has(symbol) && isRootOpaqueParameter(symbol)) {
        return false;
      }
      return scope.aggregated.has(symbol);
    };

    const originatesFromIgnored = (expr: ts.Expression): boolean => {
      if (ts.isIdentifier(expr)) {
        const symbol = checker.getSymbolAtLocation(expr);
        return isSymbolIgnored(symbol);
      }
      if (
        ts.isPropertyAccessExpression(expr) ||
        ts.isElementAccessExpression(expr)
      ) {
        return originatesFromIgnored(expr.expression);
      }
      if (ts.isCallExpression(expr)) {
        return originatesFromIgnored(expr.expression);
      }
      return false;
    };

    const recordDependency = (
      expr: ts.Expression,
      ownerScope: DependencyScopeInternal,
      parentId: number | null = null,
    ): DependencyNode => {
      const node: DependencyNode = {
        id: context.nextNodeId++,
        expression: expr,
        canonicalKey: createCanonicalKey(expr, ownerScope),
        parentId,
        scopeId: ownerScope.id,
      };
      context.nodes.push(node);
      return node;
    };

    const findRootIdentifier = (
      expr: ts.Expression,
    ): ts.Identifier | undefined => {
      let current: ts.Expression = expr;
      while (true) {
        if (ts.isIdentifier(current)) return current;
        if (ts.isPropertyAccessExpression(current)) {
          current = current.expression;
          continue;
        }
        if (ts.isElementAccessExpression(current)) {
          current = current.expression;
          continue;
        }
        if (
          ts.isParenthesizedExpression(current) ||
          ts.isAsExpression(current) ||
          ts.isTypeAssertionExpression(current) ||
          ts.isNonNullExpression(current)
        ) {
          current = current.expression;
          continue;
        }
        if (ts.isCallExpression(current)) {
          current = current.expression;
          continue;
        }
        return undefined;
      }
    };

    const getOpaqueParameterCallKind = (
      symbol: ts.Symbol | undefined,
    ): "builder" | "array-map" | undefined => {
      if (!symbol) return undefined;
      const declarations = symbol.getDeclarations();
      if (!declarations) return undefined;
      for (const declaration of declarations) {
        if (!ts.isParameter(declaration)) continue;
        let functionNode: ts.Node | undefined = declaration.parent;
        while (functionNode && !ts.isFunctionLike(functionNode)) {
          functionNode = functionNode.parent;
        }
        if (!functionNode) continue;
        let candidate: ts.Node | undefined = functionNode.parent;
        while (candidate && !ts.isCallExpression(candidate)) {
          candidate = candidate.parent;
        }
        if (!candidate) continue;
        const callExpression = candidate as ts.CallExpression;
        const callKind = detectCallKind(callExpression, checker);
        if (callKind?.kind === "builder" || callKind?.kind === "array-map") {
          return callKind.kind;
        }
      }
      return undefined;
    };

    const isRootOpaqueParameter = (symbol: ts.Symbol | undefined): boolean =>
      getOpaqueParameterCallKind(symbol) !== undefined;

    const isImplicitOpaqueRefExpression = (
      expr: ts.Expression,
    ): boolean => {
      const root = findRootIdentifier(expr);
      if (!root) return false;
      const symbol = checker.getSymbolAtLocation(root);
      return isRootOpaqueParameter(symbol);
    };

    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (isSymbolIgnored(symbol)) {
        return emptyAnalysis();
      }
      const type = checker.getTypeAtLocation(expression);
      const parameterCallKind = getOpaqueParameterCallKind(symbol);
      if (parameterCallKind === "array-map") {
        const node = recordDependency(expression, scope);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dependencies: [expression],
          nodes: [node],
        };
      }
      if (isOpaqueRefType(type, checker)) {
        const node = recordDependency(expression, scope);
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dependencies: [expression],
          nodes: [node],
        };
      }
      return emptyAnalysis();
    }

    if (ts.isPropertyAccessExpression(expression)) {
      const target = analyzeExpression(expression.expression, scope, context);
      const propertyType = checker.getTypeAtLocation(expression);
      if (isOpaqueRefType(propertyType, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          findParentNodeId(target.nodes, expression.expression) ??
            null;
        const node = recordDependency(expression, scope, parentId);
        return {
          containsOpaqueRef: true,
          requiresRewrite: target.requiresRewrite,
          dependencies: [expression],
          nodes: [node],
        };
      }
      if (isImplicitOpaqueRefExpression(expression)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          findParentNodeId(target.nodes, expression.expression) ?? null;
        const node = recordDependency(expression, scope, parentId);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dependencies: [expression],
          nodes: [node],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef,
        requiresRewrite: target.requiresRewrite || target.containsOpaqueRef,
        dependencies: target.dependencies,
        nodes: target.nodes,
      };
    }

    if (ts.isElementAccessExpression(expression)) {
      const target = analyzeExpression(expression.expression, scope, context);
      const argumentExpression = expression.argumentExpression;
      const argument = argumentExpression &&
          ts.isExpression(argumentExpression)
        ? analyzeExpression(argumentExpression, scope, context)
        : emptyAnalysis();

      const isStaticIndex = argumentExpression &&
        ts.isExpression(argumentExpression) &&
        (ts.isLiteralExpression(argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(argumentExpression));

      if (isStaticIndex) {
        return mergeAnalyses(target, argument);
      }

      if (
        isImplicitOpaqueRefExpression(expression.expression) &&
        target.dependencies.length === 0
      ) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          findParentNodeId(target.nodes, expression.expression) ?? null;
        const node = recordDependency(expression, scope, parentId);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dependencies: [expression],
          nodes: [node],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef ||
          argument.containsOpaqueRef,
        requiresRewrite: true,
        dependencies: [...target.dependencies],
        nodes: [...target.nodes],
      };
    }

    if (ts.isParenthesizedExpression(expression)) {
      return analyzeExpression(expression.expression, scope, context);
    }

    if (ts.isAsExpression(expression)) {
      return analyzeExpression(expression.expression, scope, context);
    }

    if (ts.isTypeAssertionExpression(expression)) {
      return analyzeExpression(expression.expression, scope, context);
    }

    if (ts.isNonNullExpression(expression)) {
      return analyzeExpression(expression.expression, scope, context);
    }

    if (ts.isConditionalExpression(expression)) {
      const condition = analyzeExpression(expression.condition, scope, context);
      const whenTrue = analyzeExpression(expression.whenTrue, scope, context);
      const whenFalse = analyzeExpression(expression.whenFalse, scope, context);
      return {
        containsOpaqueRef: condition.containsOpaqueRef ||
          whenTrue.containsOpaqueRef ||
          whenFalse.containsOpaqueRef,
        requiresRewrite: true,
        dependencies: [
          ...condition.dependencies,
          ...whenTrue.dependencies,
          ...whenFalse.dependencies,
        ],
        nodes: [
          ...condition.nodes,
          ...whenTrue.nodes,
          ...whenFalse.nodes,
        ],
      };
    }

    if (ts.isBinaryExpression(expression)) {
      const left = analyzeExpression(expression.left, scope, context);
      const right = analyzeExpression(expression.right, scope, context);
      return mergeAnalyses(left, right, {
        containsOpaqueRef: left.containsOpaqueRef || right.containsOpaqueRef,
        requiresRewrite: left.containsOpaqueRef || right.containsOpaqueRef,
        dependencies: [...left.dependencies, ...right.dependencies],
        nodes: [...left.nodes, ...right.nodes],
      });
    }

    if (
      ts.isPrefixUnaryExpression(expression) ||
      ts.isPostfixUnaryExpression(expression)
    ) {
      const operand = analyzeExpression(expression.operand, scope, context);
      return {
        containsOpaqueRef: operand.containsOpaqueRef,
        requiresRewrite: operand.containsOpaqueRef,
        dependencies: operand.dependencies,
        nodes: operand.nodes,
      };
    }

    if (ts.isTemplateExpression(expression)) {
      const parts = expression.templateSpans.map((span) =>
        analyzeExpression(span.expression, scope, context)
      );
      return mergeAnalyses(...parts, {
        containsOpaqueRef: parts.some((part) => part.containsOpaqueRef),
        requiresRewrite: parts.some((part) => part.containsOpaqueRef),
        dependencies: parts.flatMap((part) => part.dependencies),
        nodes: parts.flatMap((part) => part.nodes),
      });
    }

    if (ts.isTaggedTemplateExpression(expression)) {
      if (ts.isTemplateExpression(expression.template)) {
        return analyzeExpression(expression.template, scope, context);
      }
      return emptyAnalysis();
    }

    if (ts.isCallExpression(expression)) {
      const callee = analyzeExpression(expression.expression, scope, context);
      const analyses: InternalAnalysis[] = [callee];
      for (const arg of expression.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          const parameterSymbols: ts.Symbol[] = [];
          for (const parameter of arg.parameters) {
            const symbol = checker.getSymbolAtLocation(parameter.name);
            if (symbol) {
              parameterSymbols.push(symbol);
            }
          }
          const childScope = createScope(context, scope, parameterSymbols);
          if (ts.isBlock(arg.body)) {
            const blockAnalyses: InternalAnalysis[] = [];
            for (const statement of arg.body.statements) {
              if (ts.isReturnStatement(statement) && statement.expression) {
                blockAnalyses.push(
                  analyzeExpression(statement.expression, childScope, context),
                );
              }
            }
            analyses.push(mergeAnalyses(...blockAnalyses));
          } else {
            analyses.push(analyzeExpression(arg.body, childScope, context));
          }
        } else if (ts.isExpression(arg)) {
          analyses.push(analyzeExpression(arg, scope, context));
        }
      }

      const combined = mergeAnalyses(...analyses);
      const callKind = detectCallKind(expression, checker);
      const rewriteHint: RewriteHint | undefined = (() => {
        if (callKind?.kind === "ifElse" && expression.arguments.length > 0) {
          const predicate = expression.arguments[0];
          return { kind: "call-if-else", predicate };
        }
        if (callKind?.kind === "builder") {
          return { kind: "skip-call-rewrite", reason: "builder" };
        }
        if (callKind?.kind === "array-map") {
          return { kind: "skip-call-rewrite", reason: "array-map" };
        }
        return undefined;
      })();

      if (callKind?.kind === "builder") {
        return {
          containsOpaqueRef: combined.containsOpaqueRef,
          requiresRewrite: false,
          dependencies: combined.dependencies,
          nodes: combined.nodes,
          rewriteHint,
        };
      }

      if (
        rewriteHint?.kind === "skip-call-rewrite" &&
        rewriteHint.reason === "array-map"
      ) {
        return {
          containsOpaqueRef: combined.containsOpaqueRef,
          requiresRewrite: false,
          dependencies: combined.dependencies,
          nodes: combined.nodes,
          rewriteHint,
        };
      }

      return {
        containsOpaqueRef: combined.containsOpaqueRef,
        requiresRewrite: combined.containsOpaqueRef ||
          combined.requiresRewrite,
        dependencies: combined.dependencies,
        nodes: combined.nodes,
        rewriteHint,
      };
    }

    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const parameterSymbols: ts.Symbol[] = [];
      for (const parameter of expression.parameters) {
        const symbol = checker.getSymbolAtLocation(parameter.name);
        if (symbol) parameterSymbols.push(symbol);
      }
      const childScope = createScope(context, scope, parameterSymbols);
      if (ts.isBlock(expression.body)) {
        const analyses: InternalAnalysis[] = [];
        for (const statement of expression.body.statements) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            analyses.push(
              analyzeExpression(statement.expression, childScope, context),
            );
          }
        }
        return mergeAnalyses(...analyses);
      }
      return analyzeExpression(expression.body, childScope, context);
    }

    if (ts.isObjectLiteralExpression(expression)) {
      const analyses = expression.properties.map((prop) => {
        if (
          ts.isPropertyAssignment(prop) && ts.isExpression(prop.initializer)
        ) {
          return analyzeExpression(prop.initializer, scope, context);
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return analyzeExpression(prop.name, scope, context);
        }
        return emptyAnalysis();
      });
      return mergeAnalyses(...analyses);
    }

    if (ts.isArrayLiteralExpression(expression)) {
      const analyses = expression.elements.map((element) => {
        if (ts.isExpression(element)) {
          return analyzeExpression(element, scope, context);
        }
        return emptyAnalysis();
      });
      return mergeAnalyses(...analyses);
    }

    const analyses: InternalAnalysis[] = [];
    expression.forEachChild((child) => {
      if (ts.isExpression(child)) {
        analyses.push(analyzeExpression(child, scope, context));
      }
    });
    if (analyses.length === 0) {
      return emptyAnalysis();
    }
    return mergeAnalyses(...analyses);
  };

  return (expression: ts.Expression) => {
    const context: AnalyzerContext = {
      nextNodeId: 0,
      nextScopeId: 0,
      nodes: [],
      scopes: new Map(),
    };
    const rootScope = createScope(context, null, []);
    const result = analyzeExpression(expression, rootScope, context);
    const scopes = Array.from(context.scopes.values()).map(toDependencyScope);
    return {
      ...result,
      graph: {
        nodes: context.nodes,
        scopes,
        rootScopeId: rootScope.id,
      },
    };
  };
}

export function collectOpaqueRefs(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Expression[] {
  const refs: ts.Expression[] = [];
  const processedNodes = new Set<ts.Node>();

  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n)) {
      const name = n.name.getText();
      if (name && name.startsWith("on")) {
        return;
      }
    }

    if (processedNodes.has(n)) return;
    processedNodes.add(n);

    if (ts.isPropertyAccessExpression(n) && ts.isExpression(n)) {
      if (
        ts.isIdentifier(n.expression) &&
        isFunctionParameter(n.expression, checker)
      ) {
        return;
      }

      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        refs.push(n);
        return;
      }
    }

    if (ts.isIdentifier(n) && ts.isExpression(n)) {
      const parent = n.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === n) {
        return;
      }

      if (isFunctionParameter(n, checker)) {
        return;
      }

      const type = checker.getTypeAtLocation(n);
      if (isOpaqueRefType(type, checker)) {
        refs.push(n);
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(node);
  return refs;
}
const findParentNodeId = (
  nodes: DependencyNode[],
  target: ts.Expression,
): number | null => {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node.expression === target) {
      return node.id;
    }
  }
  return null;
};
