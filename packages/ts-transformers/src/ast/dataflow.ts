import ts from "typescript";

import { getMemberSymbol, isFunctionParameter } from "./utils.ts";
import { symbolDeclaresCommonToolsDefault } from "../core/mod.ts";
import { isOpaqueRefType } from "../transformers/opaque-ref/opaque-ref.ts";
import { detectCallKind } from "./call-kind.ts";

export interface DataFlowScopeParameter {
  readonly name: string;
  readonly symbol: ts.Symbol;
  readonly declaration?: ts.ParameterDeclaration;
}

export interface DataFlowScope {
  readonly id: number;
  readonly parentId: number | null;
  readonly parameters: readonly DataFlowScopeParameter[];
}

export interface DataFlowNode {
  readonly id: number;
  readonly expression: ts.Expression;
  readonly canonicalKey: string;
  readonly parentId: number | null;
  readonly scopeId: number;
  readonly isExplicit: boolean; // True if this node represents an actual dependency, not a traversal artifact
}

export interface DataFlowGraph {
  readonly nodes: readonly DataFlowNode[];
  readonly scopes: readonly DataFlowScope[];
  readonly rootScopeId: number;
}

export type RewriteHint =
  | { kind: "call-if-else"; predicate: ts.Expression }
  | { kind: "skip-call-rewrite"; reason: "array-map" | "builder" }
  | undefined;

export interface DataFlowAnalysis {
  containsOpaqueRef: boolean;
  requiresRewrite: boolean;
  dataFlows: ts.Expression[];
  graph: DataFlowGraph;
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

interface DataFlowScopeInternal {
  readonly id: number;
  readonly parentId: number | null;
  readonly parameterSymbols: ts.Symbol[];
  readonly aggregated: Set<ts.Symbol>;
}

interface AnalyzerContext {
  nextNodeId: number;
  nextScopeId: number;
  readonly collectedNodes: DataFlowNode[]; // All nodes collected during analysis
  readonly scopes: Map<number, DataFlowScopeInternal>;
}

interface InternalAnalysis {
  containsOpaqueRef: boolean;
  requiresRewrite: boolean;
  dataFlows: ts.Expression[];
  localNodes: DataFlowNode[]; // Nodes from this expression subtree only
  rewriteHint?: RewriteHint;
}

const emptyAnalysis = (): InternalAnalysis => ({
  containsOpaqueRef: false,
  requiresRewrite: false,
  dataFlows: [],
  localNodes: [],
  rewriteHint: undefined,
});

const mergeAnalyses = (...analyses: InternalAnalysis[]): InternalAnalysis => {
  let contains = false;
  let requires = false;
  const dataFlows: ts.Expression[] = [];
  const localNodes: DataFlowNode[] = [];
  for (const analysis of analyses) {
    if (!analysis) continue;
    contains ||= analysis.containsOpaqueRef;
    requires ||= analysis.requiresRewrite;
    dataFlows.push(...analysis.dataFlows);
    localNodes.push(...analysis.localNodes);
  }
  return {
    containsOpaqueRef: contains,
    requiresRewrite: requires,
    dataFlows,
    localNodes,
    rewriteHint: undefined,
  };
};

export function createDataFlowAnalyzer(
  checker: ts.TypeChecker,
): (expression: ts.Expression) => DataFlowAnalysis {
  const createScope = (
    context: AnalyzerContext,
    parent: DataFlowScopeInternal | null,
    parameterSymbols: ts.Symbol[],
  ): DataFlowScopeInternal => {
    const aggregated = parent
      ? new Set(parent.aggregated)
      : new Set<ts.Symbol>();
    for (const symbol of parameterSymbols) aggregated.add(symbol);
    const scope: DataFlowScopeInternal = {
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
    scope: DataFlowScopeInternal,
  ): string => {
    const sourceFile = expression.getSourceFile();
    const text = expression.getText(sourceFile);
    return `${scope.id}:${text}`;
  };

  const toDataFlowScope = (
    scope: DataFlowScopeInternal,
  ): DataFlowScope => ({
    id: scope.id,
    parentId: scope.parentId,
    parameters: scope.parameterSymbols.map((symbol) => {
      const declarations = symbol.getDeclarations();
      const parameterDecl = declarations?.find((
        decl,
      ): decl is ts.ParameterDeclaration => ts.isParameter(decl));
      if (parameterDecl) {
        return {
          name: symbol.getName(),
          symbol,
          declaration: parameterDecl,
        } satisfies DataFlowScopeParameter;
      }
      return {
        name: symbol.getName(),
        symbol,
      } satisfies DataFlowScopeParameter;
    }),
  });

  const analyzeExpression = (
    expression: ts.Expression,
    scope: DataFlowScopeInternal,
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

    const recordDataFlow = (
      expr: ts.Expression,
      ownerScope: DataFlowScopeInternal,
      parentId: number | null = null,
      isExplicit: boolean = false,
    ): DataFlowNode => {
      const node: DataFlowNode = {
        id: context.nextNodeId++,
        expression: expr,
        canonicalKey: createCanonicalKey(expr, ownerScope),
        parentId,
        scopeId: ownerScope.id,
        isExplicit,
      };
      context.collectedNodes.push(node);
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
        const node = recordDataFlow(expression, scope, null, true); // Explicit: parameter is a dependency
        return {
          containsOpaqueRef: true,
          requiresRewrite: false, // Map parameters themselves don't need wrapping
          dataFlows: [expression],
          localNodes: [node],
        };
      }
      if (isOpaqueRefType(type, checker)) {
        const node = recordDataFlow(expression, scope, null, true); // Explicit: direct OpaqueRef
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
          localNodes: [node],
        };
      }
      if (symbolDeclaresCommonToolsDefault(symbol, checker)) {
        const node = recordDataFlow(expression, scope, null, true); // Explicit: CommonTools default
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
          localNodes: [node],
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
          findParentNodeId(target.localNodes, expression.expression) ??
            null;
        const node = recordDataFlow(expression, scope, parentId, true); // Explicit: OpaqueRef property

        // Special case: property access on map callback parameters should be treated as OpaqueRef
        // but not require rewrite (they're handled by the map transformation)
        const isMapParameter = target.dataFlows.length === 1 &&
          target.dataFlows[0] &&
          ts.isIdentifier(target.dataFlows[0]) &&
          getOpaqueParameterCallKind(
              checker.getSymbolAtLocation(target.dataFlows[0]),
            ) === "array-map";

        if (isMapParameter) {
          return {
            containsOpaqueRef: true,
            requiresRewrite: false, // Don't wrap simple property access on map params
            dataFlows: [expression],
            localNodes: [node],
          };
        }

        // If the target is a complex expression requiring rewrite (like ElementAccess),
        // propagate its dataFlows. Otherwise, add this property access as a dataFlow.
        if (target.requiresRewrite && target.dataFlows.length > 0) {
          return {
            containsOpaqueRef: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: target.dataFlows,
            localNodes: [node],
          };
        } else {
          return {
            containsOpaqueRef: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: [expression],
            localNodes: [node],
          };
        }
      }
      const propertySymbol = getMemberSymbol(expression, checker);
      if (symbolDeclaresCommonToolsDefault(propertySymbol, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          findParentNodeId(target.localNodes, expression.expression) ?? null;
        const node = recordDataFlow(expression, scope, parentId, true); // Explicit: CommonTools property
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
          localNodes: [node],
        };
      }
      if (isImplicitOpaqueRefExpression(expression)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }

        // Check if this is a computed expression (property access on call result, etc.)
        const isPropertyOnCall = ts.isCallExpression(expression.expression);

        const parentId =
          findParentNodeId(target.localNodes, expression.expression) ?? null;

        // If the target is a complex expression requiring rewrite (ElementAccess or Call),
        // propagate its dataFlows. Otherwise add this property access as a dataFlow.
        if (
          isPropertyOnCall ||
          (target.requiresRewrite && target.dataFlows.length > 0)
        ) {
          // This is a computed expression - use the dependencies from the target
          const node = recordDataFlow(expression, scope, parentId, false);
          return {
            containsOpaqueRef: true,
            requiresRewrite: true,
            dataFlows: target.dataFlows,
            localNodes: [node],
          };
        }

        // This is a direct property access on an OpaqueRef (like state.charms.length)
        // It should be its own explicit dependency
        const node = recordDataFlow(expression, scope, parentId, true);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
          localNodes: [node],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef,
        requiresRewrite: target.requiresRewrite || target.containsOpaqueRef,
        dataFlows: target.dataFlows,
        localNodes: target.localNodes,
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
        const result = mergeAnalyses(target, argument);
        return result;
      }

      if (
        isImplicitOpaqueRefExpression(expression.expression) &&
        target.dataFlows.length === 0
      ) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          findParentNodeId(target.localNodes, expression.expression) ?? null;
        // Element access on implicit opaque ref - this is likely an explicit dependency
        const node = recordDataFlow(expression, scope, parentId, true);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
          localNodes: [node],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef ||
          argument.containsOpaqueRef,
        requiresRewrite: true,
        dataFlows: [...target.dataFlows, ...argument.dataFlows],
        localNodes: [...target.localNodes, ...argument.localNodes],
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
        dataFlows: [
          ...condition.dataFlows,
          ...whenTrue.dataFlows,
          ...whenFalse.dataFlows,
        ],
        localNodes: [
          ...condition.localNodes,
          ...whenTrue.localNodes,
          ...whenFalse.localNodes,
        ],
      };
    }

    if (ts.isBinaryExpression(expression)) {
      const left = analyzeExpression(expression.left, scope, context);
      const right = analyzeExpression(expression.right, scope, context);
      const merged = mergeAnalyses(left, right);
      return {
        ...merged,
        requiresRewrite: left.containsOpaqueRef || right.containsOpaqueRef,
      };
    }

    if (
      ts.isPrefixUnaryExpression(expression) ||
      ts.isPostfixUnaryExpression(expression)
    ) {
      const operand = analyzeExpression(expression.operand, scope, context);
      return {
        containsOpaqueRef: operand.containsOpaqueRef,
        requiresRewrite: operand.containsOpaqueRef,
        dataFlows: operand.dataFlows,
        localNodes: operand.localNodes,
      };
    }

    if (ts.isTemplateExpression(expression)) {
      const parts = expression.templateSpans.map((span) =>
        analyzeExpression(span.expression, scope, context)
      );
      const merged = mergeAnalyses(...parts);
      return {
        ...merged,
        requiresRewrite: parts.some((part) => part.containsOpaqueRef),
      };
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
          if (predicate) {
            return { kind: "call-if-else", predicate };
          }
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
          dataFlows: combined.dataFlows,
          localNodes: combined.localNodes,
          rewriteHint,
        };
      }

      return {
        containsOpaqueRef: combined.containsOpaqueRef,
        requiresRewrite: combined.containsOpaqueRef ||
          combined.requiresRewrite,
        dataFlows: combined.dataFlows,
        localNodes: combined.localNodes,
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
      collectedNodes: [],
      scopes: new Map(),
    };
    const rootScope = createScope(context, null, []);
    const result = analyzeExpression(expression, rootScope, context);
    const scopes = Array.from(context.scopes.values()).map(toDataFlowScope);
    const { localNodes: _, ...resultWithoutNodes } = result;
    return {
      ...resultWithoutNodes,
      graph: {
        nodes: context.collectedNodes,
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
  nodes: DataFlowNode[],
  target: ts.Expression,
): number | null => {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node && node.expression === target) {
      return node.id;
    }
  }
  return null;
};
