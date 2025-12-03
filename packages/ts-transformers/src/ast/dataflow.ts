import ts from "typescript";

import {
  getExpressionText,
  getMemberSymbol,
  isFunctionParameter,
  isMethodCall,
  setParentPointers,
} from "./utils.ts";
import { isFunctionLikeExpression } from "./function-predicates.ts";
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

interface AnalyzerContext {
  nextNodeId: number;
  nextScopeId: number;
  readonly collectedNodes: DataFlowNode[]; // All nodes collected during analysis
  readonly scopes: Map<number, DataFlowScope>;
  readonly expressionToNodeId: Map<ts.Expression, number>; // For O(1) parent lookups
}

interface InternalAnalysis {
  containsOpaqueRef: boolean;
  requiresRewrite: boolean;
  dataFlows: ts.Expression[];
  rewriteHint?: RewriteHint;
}

const emptyAnalysis = (): InternalAnalysis => ({
  containsOpaqueRef: false,
  requiresRewrite: false,
  dataFlows: [],
  rewriteHint: undefined,
});

const mergeAnalyses = (...analyses: InternalAnalysis[]): InternalAnalysis => {
  let contains = false;
  let requires = false;
  const dataFlows: ts.Expression[] = [];
  for (const analysis of analyses) {
    if (!analysis) continue;
    contains ||= analysis.containsOpaqueRef;
    requires ||= analysis.requiresRewrite;
    dataFlows.push(...analysis.dataFlows);
  }
  return {
    containsOpaqueRef: contains,
    requiresRewrite: requires,
    dataFlows,
    rewriteHint: undefined,
  };
};

export function createDataFlowAnalyzer(
  checker: ts.TypeChecker,
): (expression: ts.Expression) => DataFlowAnalysis {
  // Convert symbols to enriched parameters with name and declaration info
  const toScopeParameters = (
    symbols: ts.Symbol[],
  ): DataFlowScopeParameter[] =>
    symbols.map((symbol) => {
      const declarations = symbol.getDeclarations();
      const parameterDecl = declarations?.find((
        decl,
      ): decl is ts.ParameterDeclaration => ts.isParameter(decl));
      return parameterDecl
        ? { name: symbol.getName(), symbol, declaration: parameterDecl }
        : { name: symbol.getName(), symbol };
    });

  const createScope = (
    context: AnalyzerContext,
    parent: DataFlowScope | null,
    parameterSymbols: ts.Symbol[],
  ): DataFlowScope => {
    const scope: DataFlowScope = {
      id: context.nextScopeId++,
      parentId: parent ? parent.id : null,
      parameters: toScopeParameters(parameterSymbols),
    };
    context.scopes.set(scope.id, scope);
    return scope;
  };

  // Compute all parameters accessible from a scope (own + ancestors) on-demand
  const getAggregatedSymbols = (
    scope: DataFlowScope,
    scopes: Map<number, DataFlowScope>,
  ): Set<ts.Symbol> => {
    const result = new Set<ts.Symbol>();
    let current: DataFlowScope | undefined = scope;
    while (current) {
      for (const param of current.parameters) {
        result.add(param.symbol);
      }
      current = current.parentId !== null
        ? scopes.get(current.parentId)
        : undefined;
    }
    return result;
  };

  const createCanonicalKey = (
    expression: ts.Expression,
    scope: DataFlowScope,
  ): string => {
    const text = getExpressionText(expression);
    return `${scope.id}:${text}`;
  };

  // Determine how CallExpressions should be handled based on their call kind.
  // Returns the appropriate InternalAnalysis with correct requiresRewrite logic.
  const handleCallExpression = (
    merged: InternalAnalysis,
    callKind: ReturnType<typeof detectCallKind>,
    callee: InternalAnalysis,
    rewriteHint: RewriteHint,
  ): InternalAnalysis => {
    // Builder calls (like recipe) don't need derive wrapping
    if (callKind?.kind === "builder") {
      return {
        ...merged,
        requiresRewrite: false,
        rewriteHint,
      };
    }

    // Array-map calls preserve requiresRewrite from the callee
    // to handle cases like state.items.filter(...).map(...)
    if (callKind?.kind === "array-map") {
      return {
        ...merged,
        requiresRewrite: callee.requiresRewrite,
        rewriteHint,
      };
    }

    // Default: CallExpressions require rewrite if they contain opaque refs
    return {
      ...merged,
      requiresRewrite: merged.containsOpaqueRef || merged.requiresRewrite,
      rewriteHint,
    };
  };

  // Helper: Check if an element access expression has a static (literal) index
  const isStaticElementAccess = (
    expression: ts.ElementAccessExpression,
  ): boolean => {
    const argumentExpression = expression.argumentExpression;
    return argumentExpression !== undefined &&
      ts.isExpression(argumentExpression) &&
      (ts.isLiteralExpression(argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(argumentExpression));
  };

  const analyzeExpression = (
    expression: ts.Expression,
    scope: DataFlowScope,
    context: AnalyzerContext,
  ): InternalAnalysis => {
    // Handle synthetic nodes (created by previous transformers)
    // We can't analyze them directly, but we need to visit children
    if (!expression.getSourceFile()) {
      // Set parent pointers for the entire synthetic subtree to enable
      // parent-based logic (method call detection, etc.) to work
      setParentPointers(expression);
      // Synthetic nodes don't have positions, so getText() will crash
      // We don't currently use the printed text, but keep it for debugging
      try {
        const printer = ts.createPrinter();
        const _exprText = printer.printNode(
          ts.EmitHint.Unspecified,
          expression,
          expression.getSourceFile() ||
            ts.createSourceFile("", "", ts.ScriptTarget.Latest),
        );
        // _exprText could be logged for debugging if needed
        void _exprText;
      } catch {
        // Ignore errors
      }

      // Special handling for synthetic identifiers (must come BEFORE child traversal)
      // These are likely parameters from map closure transformation (like `discount`)
      // We can't resolve symbols for synthetic nodes, but we should treat them as opaque
      if (ts.isIdentifier(expression)) {
        // Skip property names in property access expressions - they're not data flows.
        // For example, `toSchema` in `__ctHelpers.toSchema` is just a property name.
        if (
          expression.parent &&
          ts.isPropertyAccessExpression(expression.parent) &&
          expression.parent.name === expression
        ) {
          // This is a property name, not a value reference - don't capture it
          return emptyAnalysis();
        }

        // If it's a synthetic identifier, treat it as opaque
        // This handles cases like `discount` where the whole identifier is synthetic
        // We need to record it in the graph so normalizeDataFlows can find it
        const node: DataFlowNode = {
          id: context.nextNodeId++,
          expression,
          canonicalKey: `${scope.id}:${getExpressionText(expression)}`,
          parentId: null,
          scopeId: scope.id,
          isExplicit: true, // Explicit: synthetic opaque parameter
        };
        context.collectedNodes.push(node);
        context.expressionToNodeId.set(expression, node.id);
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      // Collect analyses from all children
      const childAnalyses: InternalAnalysis[] = [];

      // Helper to analyze a child expression
      const analyzeChild = (child: ts.Node) => {
        if (ts.isExpression(child)) {
          const childAnalysis = analyzeExpression(child, scope, context);
          childAnalyses.push(childAnalysis);
        }
      };

      // Special handling for JSX elements - ts.forEachChild doesn't traverse JSX expression children
      if (ts.isJsxElement(expression)) {
        // Traverse opening element attributes
        if (expression.openingElement.attributes) {
          expression.openingElement.attributes.properties.forEach(analyzeChild);
        }
        // Traverse JSX children (this is what forEachChild misses!)
        expression.children.forEach((child) => {
          if (ts.isJsxExpression(child)) {
            if (child.expression) {
              analyzeChild(child.expression);
            }
          } else {
            analyzeChild(child);
          }
        });
      } else if (ts.isJsxSelfClosingElement(expression)) {
        // Traverse self-closing element attributes
        if (expression.attributes) {
          expression.attributes.properties.forEach(analyzeChild);
        }
      } else if (ts.isJsxFragment(expression)) {
        // Traverse fragment children
        expression.children.forEach((child) => {
          if (ts.isJsxExpression(child) && child.expression) {
            analyzeChild(child.expression);
          } else {
            analyzeChild(child);
          }
        });
      } else {
        // For non-JSX nodes, use the default traversal
        ts.forEachChild(expression, analyzeChild);
      }

      // Inherit properties from children
      if (childAnalyses.length > 0) {
        const merged = mergeAnalyses(...childAnalyses);

        // For synthetic CallExpressions, detect call kind and set rewriteHint
        if (ts.isCallExpression(expression)) {
          const callKind = detectCallKind(expression, checker);
          const rewriteHint: RewriteHint | undefined = (() => {
            if (callKind?.kind === "builder") {
              return { kind: "skip-call-rewrite", reason: "builder" };
            }
            if (callKind?.kind === "array-map") {
              return { kind: "skip-call-rewrite", reason: "array-map" };
            }
            if (
              callKind?.kind === "ifElse" && expression.arguments.length > 0
            ) {
              const predicate = expression.arguments[0];
              if (predicate) {
                return { kind: "call-if-else", predicate };
              }
            }
            return undefined;
          })();

          // For synthetic CallExpressions, we don't have a separate callee analysis
          // Approximate by using merged for both parameters
          return handleCallExpression(merged, callKind, merged, rewriteHint);
        }

        // Special handling for synthetic property access expressions
        // For synthetic nodes, we can't use checker.getSymbolAtLocation or isOpaqueRefType reliably
        // But we can detect if this looks like a property access that should be a dataflow
        if (ts.isPropertyAccessExpression(expression)) {
          // Find the root identifier by walking up the property chain
          let current: ts.Expression = expression;
          while (ts.isPropertyAccessExpression(current)) {
            current = current.expression;
          }

          if (ts.isIdentifier(current)) {
            const symbol = checker.getSymbolAtLocation(current);
            if (symbol) {
              // Check if this is a parameter in an opaque call (builder or array-map)
              const declarations = symbol.getDeclarations();
              if (declarations) {
                for (const decl of declarations) {
                  if (ts.isParameter(decl)) {
                    // Walk up to find if this parameter belongs to a builder or array-map call
                    let func: ts.Node | undefined = decl.parent;
                    while (func && !ts.isFunctionLike(func)) func = func.parent;
                    if (func) {
                      let callNode: ts.Node | undefined = func.parent;
                      while (callNode && !ts.isCallExpression(callNode)) {
                        callNode = callNode.parent;
                      }
                      if (callNode) {
                        const callKind = detectCallKind(
                          callNode as ts.CallExpression,
                          checker,
                        );
                        if (
                          callKind?.kind === "array-map" ||
                          callKind?.kind === "builder"
                        ) {
                          // This is element.price or state.foo - return full property access as dataflow
                          // Add to graph so normalizeDataFlows can find it
                          const node: DataFlowNode = {
                            id: context.nextNodeId++,
                            expression,
                            canonicalKey: `${scope.id}:${
                              getExpressionText(expression)
                            }`,
                            parentId: null,
                            scopeId: scope.id,
                            isExplicit: true, // Explicit: synthetic opaque property access
                          };
                          context.collectedNodes.push(node);
                          context.expressionToNodeId.set(expression, node.id);
                          return {
                            containsOpaqueRef: true,
                            requiresRewrite: true,
                            dataFlows: [expression],
                          };
                        }
                      }
                    }
                  }
                }
              }
            } else {
              // Symbol is undefined for the root - this is likely a synthetic parameter
              // from a transformer (like `element` from map closure transformer).
              // We can't resolve symbols for synthetic nodes, but if this looks like
              // a property access on a simple identifier (not a complex expression),
              // treat it as an opaque property access that needs derive wrapping.
              // This handles cases like `element.price` where `element` is synthetic.

              // Skip __ctHelpers.* property accesses - these are helper functions, not opaque refs.
              // For example: __ctHelpers.toSchema, __ctHelpers.recipe, __ctHelpers.derive
              if (
                ts.isIdentifier(current) &&
                current.text === "__ctHelpers"
              ) {
                // This is a helper function access, not an opaque ref - don't capture it
                return merged;
              }

              // Don't capture property accesses that are method calls.
              // For example, `element.trim` in `element.trim()` should not be captured.
              if (isMethodCall(expression)) {
                // This is a method call like element.trim() - don't capture it
                return merged;
              }

              // Add to graph so normalizeDataFlows can find it
              const node: DataFlowNode = {
                id: context.nextNodeId++,
                expression,
                canonicalKey: `${scope.id}:${getExpressionText(expression)}`,
                parentId: null,
                scopeId: scope.id,
                isExplicit: true, // Explicit: synthetic opaque property access
              };
              context.collectedNodes.push(node);
              context.expressionToNodeId.set(expression, node.id);
              return {
                containsOpaqueRef: true,
                requiresRewrite: true,
                dataFlows: [expression],
              };
            }
          }
          // Otherwise preserve merged analysis from children
          // NOTE: We should rarely hit this - it means the root wasn't an identifier
          return merged;
        }

        // For binary expressions with OpaqueRef, set requiresRewrite based on containsOpaqueRef
        // This matches the logic in the non-synthetic code path (line 380-388)
        if (ts.isBinaryExpression(expression)) {
          return {
            ...merged,
            requiresRewrite: merged.containsOpaqueRef,
          };
        }

        // For conditional expressions, set requiresRewrite to true if they contain opaque refs
        // This matches the non-synthetic code path for conditional expressions (line 720)
        if (ts.isConditionalExpression(expression)) {
          return {
            ...merged,
            requiresRewrite: true,
          };
        }

        // Element access expressions: static indices don't need derive wrapping,
        // but dynamic indices with opaque refs do (e.g., tagCounts[element])
        if (ts.isElementAccessExpression(expression)) {
          const isStaticIndex = isStaticElementAccess(expression);

          if (isStaticIndex) {
            // Static index like element[0] - preserve merged analysis
            return merged;
          } else if (merged.containsOpaqueRef) {
            // Dynamic index with opaque refs - requires derive wrapper
            return {
              ...merged,
              requiresRewrite: true,
            };
          }
          return merged;
        }

        // For JSX elements, arrow functions, and other expression containers, preserve requiresRewrite from children
        // This matches the non-synthetic code paths for these node types
        if (
          ts.isJsxElement(expression) ||
          ts.isJsxFragment(expression) ||
          ts.isJsxSelfClosingElement(expression) ||
          ts.isParenthesizedExpression(expression) ||
          ts.isArrowFunction(expression) ||
          ts.isFunctionExpression(expression)
        ) {
          return merged;
        }

        // Other synthetic nodes don't require rewrite
        return {
          ...merged,
          requiresRewrite: false,
        };
      }

      // No children with analysis
      return {
        containsOpaqueRef: false,
        requiresRewrite: false,
        dataFlows: [],
        rewriteHint: undefined,
      };
    }

    const isSymbolIgnored = (symbol: ts.Symbol | undefined): boolean => {
      if (!symbol) return false;
      const aggregated = getAggregatedSymbols(scope, context.scopes);
      if (aggregated.has(symbol) && isRootOpaqueParameter(symbol)) {
        return false;
      }
      return aggregated.has(symbol);
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
      ownerScope: DataFlowScope,
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
      context.expressionToNodeId.set(expr, node.id);
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
      if (isOpaqueRefType(type, checker)) {
        recordDataFlow(expression, scope, null, true); // Explicit: direct OpaqueRef
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }
      if (symbolDeclaresCommonToolsDefault(symbol, checker)) {
        recordDataFlow(expression, scope, null, true); // Explicit: CommonTools default
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }
      // Check if this identifier is a parameter to a builder or array-map call (like recipe)
      // These parameters become implicitly opaque even though their type isn't OpaqueRef
      if (isRootOpaqueParameter(symbol)) {
        recordDataFlow(expression, scope, null, true); // Explicit: opaque parameter
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
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
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true); // Explicit: OpaqueRef property

        // If the target is a complex expression requiring rewrite (like ElementAccess),
        // propagate its dataFlows. Otherwise, add this property access as a dataFlow.
        if (target.requiresRewrite && target.dataFlows.length > 0) {
          return {
            containsOpaqueRef: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: target.dataFlows,
          };
        } else {
          return {
            containsOpaqueRef: true,
            requiresRewrite: target.requiresRewrite,
            dataFlows: [expression],
          };
        }
      }
      const propertySymbol = getMemberSymbol(expression, checker);
      if (symbolDeclaresCommonToolsDefault(propertySymbol, checker)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }
        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;
        recordDataFlow(expression, scope, parentId, true); // Explicit: CommonTools property
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
        };
      }
      if (isImplicitOpaqueRefExpression(expression)) {
        if (originatesFromIgnored(expression.expression)) {
          return emptyAnalysis();
        }

        // Check if this is a computed expression (property access on call result, etc.)
        const isPropertyOnCall = ts.isCallExpression(expression.expression);

        const parentId =
          context.expressionToNodeId.get(expression.expression) ?? null;

        // If the target is a complex expression requiring rewrite (ElementAccess or Call),
        // propagate its dataFlows. Otherwise add this property access as a dataFlow.
        if (
          isPropertyOnCall ||
          (target.requiresRewrite && target.dataFlows.length > 0)
        ) {
          // This is a computed expression - use the dependencies from the target
          recordDataFlow(expression, scope, parentId, false);
          return {
            containsOpaqueRef: true,
            requiresRewrite: true,
            dataFlows: target.dataFlows,
          };
        }

        // This is a direct property access on an OpaqueRef (like state.charms.length)
        // It should be its own explicit dependency
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef,
        requiresRewrite: target.requiresRewrite || target.containsOpaqueRef,
        dataFlows: target.dataFlows,
      };
    }

    if (ts.isElementAccessExpression(expression)) {
      const target = analyzeExpression(expression.expression, scope, context);
      const argumentExpression = expression.argumentExpression;
      const argument = argumentExpression &&
          ts.isExpression(argumentExpression)
        ? analyzeExpression(argumentExpression, scope, context)
        : emptyAnalysis();

      const isStaticIndex = isStaticElementAccess(expression);

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
          context.expressionToNodeId.get(expression.expression) ?? null;
        // Element access on implicit opaque ref - this is likely an explicit dependency
        recordDataFlow(expression, scope, parentId, true);
        return {
          containsOpaqueRef: true,
          requiresRewrite: true,
          dataFlows: [expression],
        };
      }
      return {
        containsOpaqueRef: target.containsOpaqueRef ||
          argument.containsOpaqueRef,
        requiresRewrite: true,
        dataFlows: [...target.dataFlows, ...argument.dataFlows],
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
        if (isFunctionLikeExpression(arg)) {
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

      return handleCallExpression(combined, callKind, callee, rewriteHint);
    }

    if (isFunctionLikeExpression(expression)) {
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

    // Handle JSX elements in non-synthetic path too
    if (ts.isJsxElement(expression)) {
      const analyses: InternalAnalysis[] = [];
      // Analyze opening element attributes
      if (expression.openingElement.attributes) {
        expression.openingElement.attributes.properties.forEach((attr) => {
          if (ts.isExpression(attr)) {
            analyses.push(analyzeExpression(attr, scope, context));
          }
        });
      }
      // Analyze JSX children - must handle JsxExpression specially
      expression.children.forEach((child) => {
        if (ts.isJsxExpression(child)) {
          if (child.expression) {
            analyses.push(analyzeExpression(child.expression, scope, context));
          }
        } else if (ts.isJsxElement(child)) {
          analyses.push(analyzeExpression(child, scope, context));
        }
        // Ignore JsxText and other non-expression children
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
      expressionToNodeId: new Map(),
    };
    const rootScope = createScope(context, null, []);
    const result = analyzeExpression(expression, rootScope, context);
    return {
      ...result,
      graph: {
        nodes: context.collectedNodes,
        scopes: Array.from(context.scopes.values()),
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
