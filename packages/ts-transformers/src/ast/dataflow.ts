import ts from "typescript";

import {
  getExpressionText,
  getMemberSymbol,
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
  // === Synthetic node helpers ===
  // These enable unified handling of both synthetic (transformer-created) and
  // non-synthetic (original source) nodes by gracefully handling cases where
  // the TypeChecker can't resolve symbols or types.

  const isSynthetic = (node: ts.Node): boolean => !node.getSourceFile();

  const tryGetSymbol = (node: ts.Node): ts.Symbol | undefined => {
    try {
      return checker.getSymbolAtLocation(node) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const tryGetType = (node: ts.Node): ts.Type | undefined => {
    try {
      return checker.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
  };

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
    // Builder calls (like pattern) don't need derive wrapping
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
    // Set parent pointers for synthetic nodes (needed for parent-based logic like method call detection)
    if (isSynthetic(expression)) {
      setParentPointers(expression);
    }

    // === Helper functions (available for both synthetic and non-synthetic paths) ===

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
      const symbol = tryGetSymbol(root);
      return isRootOpaqueParameter(symbol);
    };

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
        const symbol = tryGetSymbol(expr);
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

    // === Expression type handlers ===

    if (ts.isIdentifier(expression)) {
      // Skip property names in property access expressions - they're not data flows.
      // For example, `toSchema` in `__ctHelpers.toSchema` is just a property name.
      if (
        expression.parent &&
        ts.isPropertyAccessExpression(expression.parent) &&
        expression.parent.name === expression
      ) {
        return emptyAnalysis();
      }

      const symbol = tryGetSymbol(expression);

      // Can't resolve symbol - if synthetic, treat as opaque parameter
      // This handles cases like `discount` where the whole identifier is synthetic
      if (!symbol && isSynthetic(expression)) {
        recordDataFlow(expression, scope, null, true); // Explicit: synthetic opaque parameter
        return {
          containsOpaqueRef: true,
          requiresRewrite: false,
          dataFlows: [expression],
        };
      }

      if (isSymbolIgnored(symbol)) {
        return emptyAnalysis();
      }

      const type = tryGetType(expression);
      if (type && isOpaqueRefType(type, checker)) {
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
      // Check if this identifier is a parameter to a builder or array-map call (like pattern)
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
      const propertyType = tryGetType(expression);

      if (propertyType && isOpaqueRefType(propertyType, checker)) {
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

      // For synthetic nodes where type/symbol resolution failed, check the root identifier
      if (isSynthetic(expression)) {
        const root = findRootIdentifier(expression);
        if (root && ts.isIdentifier(root)) {
          const rootSymbol = tryGetSymbol(root);
          if (rootSymbol) {
            // Root symbol found - check if it's from builder/array-map
            const callKind = getOpaqueParameterCallKind(rootSymbol);
            if (callKind) {
              // This is element.price or similar - treat as opaque property access
              const parentId =
                context.expressionToNodeId.get(expression.expression) ?? null;
              recordDataFlow(expression, scope, parentId, true);
              return {
                containsOpaqueRef: true,
                requiresRewrite: true,
                dataFlows: [expression],
              };
            }
          } else {
            // Root symbol undefined - fully synthetic parameter (like `element`)
            // Skip __ctHelpers.* property accesses - these are helper functions
            if (root.text === "__ctHelpers") {
              return {
                containsOpaqueRef: target.containsOpaqueRef,
                requiresRewrite: target.requiresRewrite ||
                  target.containsOpaqueRef,
                dataFlows: target.dataFlows,
              };
            }
            // Skip method calls like element.trim()
            if (isMethodCall(expression)) {
              return {
                containsOpaqueRef: target.containsOpaqueRef,
                requiresRewrite: target.requiresRewrite ||
                  target.containsOpaqueRef,
                dataFlows: target.dataFlows,
              };
            }
            // Treat as opaque property access
            const parentId =
              context.expressionToNodeId.get(expression.expression) ?? null;
            recordDataFlow(expression, scope, parentId, true);
            return {
              containsOpaqueRef: true,
              requiresRewrite: true,
              dataFlows: [expression],
            };
          }
        }
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
            const symbol = tryGetSymbol(parameter.name);
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
        const symbol = tryGetSymbol(parameter.name);
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

    // === JSX Expression Handling ===
    // The analyzer provides complete data flow analysis for JSX elements,
    // including both attributes (like `value={expr}`) and children.
    // This makes the analyzer self-contained - callers get correct results
    // regardless of how they traverse the AST.

    // Helper: analyze JSX attributes (JsxAttribute and JsxSpreadAttribute)
    const analyzeJsxAttributes = (
      attributes: ts.JsxAttributes,
    ): InternalAnalysis[] => {
      const results: InternalAnalysis[] = [];
      for (const attr of attributes.properties) {
        if (ts.isJsxAttribute(attr)) {
          // <Component value={expr} /> - analyze the expression inside {expr}
          if (
            attr.initializer &&
            ts.isJsxExpression(attr.initializer) &&
            attr.initializer.expression
          ) {
            results.push(
              analyzeExpression(attr.initializer.expression, scope, context),
            );
          }
          // String literal initializers (value="string") have no dependencies
        } else if (ts.isJsxSpreadAttribute(attr)) {
          // <Component {...expr} /> - analyze the spread expression
          results.push(analyzeExpression(attr.expression, scope, context));
        }
      }
      return results;
    };

    // Helper: analyze JSX children
    const analyzeJsxChildren = (
      children: ts.NodeArray<ts.JsxChild>,
    ): InternalAnalysis[] => {
      const results: InternalAnalysis[] = [];
      for (const child of children) {
        if (ts.isJsxExpression(child) && child.expression) {
          // {expr} - analyze the inner expression
          results.push(analyzeExpression(child.expression, scope, context));
        } else if (
          ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)
        ) {
          // Nested JSX elements - recurse
          results.push(analyzeExpression(child, scope, context));
        }
        // JsxText nodes have no dependencies
      }
      return results;
    };

    if (ts.isJsxElement(expression)) {
      const attrAnalyses = analyzeJsxAttributes(
        expression.openingElement.attributes,
      );
      const childAnalyses = analyzeJsxChildren(expression.children);
      return mergeAnalyses(...attrAnalyses, ...childAnalyses);
    }

    if (ts.isJsxSelfClosingElement(expression)) {
      const attrAnalyses = analyzeJsxAttributes(expression.attributes);
      return mergeAnalyses(...attrAnalyses);
    }

    if (ts.isJsxFragment(expression)) {
      const childAnalyses = analyzeJsxChildren(expression.children);
      return mergeAnalyses(...childAnalyses);
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
