import ts from "typescript";
import {
  getDeriveInputAndCallbackArgument,
  getTypeAtLocationWithFallback,
  isWildcardTraversalCall,
  type NormalizedDataFlow,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  cloneKeyExpression,
  getCommonFabricKeyName,
  isCommonFabricKeyExpression,
} from "../utils/reactive-keys.ts";
import {
  collectDestructureBindings,
  createKeyCall,
  type DefaultDestructureBinding,
  type DestructureBinding,
  type PathSegment,
} from "./destructuring-lowering.ts";
import {
  createReactiveWrapperForExpression,
} from "./expression-rewrite/rewrite-helpers.ts";
import {
  addBindingTargetSymbols,
  classifyOpaquePathTerminalCall,
  collectLocalOpaqueRootSymbols,
  getOpaqueAccessInfo,
  isOpaqueOriginCall,
  isOpaqueRootInfo,
  isOpaqueSourceExpression,
  isTopmostMemberAccess,
} from "./opaque-roots.ts";
import {
  assertValidComputeWrapCandidate,
  findPendingComputeWrapCandidate,
} from "./expression-rewrite/emitters/compute-wrap-invariants.ts";
import {
  classifyUnsupportedExpressionSiteCallRoot,
} from "./expression-site-policy.ts";
import { getCellKind } from "./opaque-ref/opaque-ref.ts";

const KNOWN_PATH_TERMINAL_METHODS = new Set([
  "set",
  "update",
  "get",
  "key",
  "map",
  "mapWithPattern",
  "filterWithPattern",
  "flatMapWithPattern",
]);

function isSelfPathSegment(
  segment: PathSegment,
  context: TransformationContext,
): boolean {
  return typeof segment !== "string" &&
    isCommonFabricKeyExpression(segment, context, "SELF");
}

function registerReplacementType(
  replacement: ts.Node,
  original: ts.Node,
  context: TransformationContext,
): void {
  const typeRegistry = context.options.typeRegistry;
  if (!typeRegistry) return;

  const originalType = getTypeAtLocationWithFallback(
    original,
    context.checker,
    typeRegistry,
  );
  if (originalType) {
    typeRegistry.set(replacement, originalType);
  }
}

export function reportComputationError(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern-context:computation",
    message,
    node,
  });
}

function reportReceiverMethodError(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern-context:receiver-method-call",
    message,
    node,
  });
}

export function rewritePatternCallbackBody(
  body: ts.ConciseBody,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
): ts.ConciseBody {
  reportInlineReactiveRootAccesses(body, context);
  const rewrittenBody = rewriteTrackedOpaquePatternBody(
    body,
    opaqueRoots,
    opaqueRootSymbols,
    context,
  );
  return rewriteNestedDeriveCallbackBodies(rewrittenBody, context);
}

function rewriteTrackedOpaquePatternBody(
  body: ts.ConciseBody,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
): ts.ConciseBody {
  if (
    opaqueRoots.size === 0 &&
    opaqueRootSymbols.size === 0 &&
    !hasLocalOpaqueOriginBinding(body, context)
  ) {
    return body;
  }

  const activeOpaqueRoots = new Set(opaqueRoots);
  const scopeStack: Map<string, boolean>[] = [];

  const enterScope = (): void => {
    scopeStack.push(new Map<string, boolean>());
  };

  const exitScope = (): void => {
    const scope = scopeStack.pop();
    if (!scope) return;
    for (const [name, wasOpaque] of scope) {
      if (wasOpaque) {
        activeOpaqueRoots.add(name);
      } else {
        activeOpaqueRoots.delete(name);
      }
    }
  };

  const setBindingOpaqueState = (
    binding: ts.BindingName,
    isOpaque: boolean,
  ): void => {
    const currentScope = scopeStack[scopeStack.length - 1];

    if (ts.isIdentifier(binding)) {
      if (currentScope && !currentScope.has(binding.text)) {
        currentScope.set(binding.text, activeOpaqueRoots.has(binding.text));
      }
      if (isOpaque) {
        activeOpaqueRoots.add(binding.text);
      } else {
        activeOpaqueRoots.delete(binding.text);
      }
      return;
    }

    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) continue;
      setBindingOpaqueState(element.name, isOpaque);
    }
  };

  const diagnosticsSeen = new Set<number>();
  const syntheticDiagnosticsSeen = new WeakSet<ts.Node>();
  const analyze = context.getDataFlowAnalyzer();
  const resolveDiagnosticNode = (node: ts.Node): ts.Node => {
    const original = ts.getOriginalNode(node);
    if (original.pos >= 0) {
      return original;
    }
    return node;
  };
  const reportOnce = (
    node: ts.Node,
    type: "computation" | "receiver-method",
    message: string,
  ): void => {
    const diagnosticNode = resolveDiagnosticNode(node);
    if (diagnosticNode.pos >= 0) {
      const key = diagnosticNode.getStart(context.sourceFile);
      if (diagnosticsSeen.has(key)) return;
      diagnosticsSeen.add(key);
    } else {
      if (syntheticDiagnosticsSeen.has(diagnosticNode)) return;
      syntheticDiagnosticsSeen.add(diagnosticNode);
    }
    if (type === "computation") {
      reportComputationError(context, diagnosticNode, message);
    } else {
      reportReceiverMethodError(context, diagnosticNode, message);
    }
  };

  const callTargetParents = new WeakMap<ts.Node, ts.CallExpression>();

  const getTrackedOpaqueAccessInfo = (
    expression: ts.Expression,
  ): ReturnType<typeof getOpaqueAccessInfo> | undefined => {
    const info = getOpaqueAccessInfo(expression, context);
    return isOpaqueRootInfo(
        info,
        activeOpaqueRoots,
        opaqueRootSymbols,
        context,
      )
      ? info
      : undefined;
  };

  const hasDynamicOpaqueAccess = (
    expression: ts.Expression,
  ): boolean => {
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isTopmostMemberAccess(node)
      ) {
        const info = getTrackedOpaqueAccessInfo(node);
        if (info?.dynamic) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(expression);
    return found;
  };

  const getRelevantDataFlowsForExpression = (
    expression: ts.Expression,
  ) => {
    const relevantDataFlows = context.getRelevantDataFlows(expression).map(
      (dataFlow) => canonicalizeDataFlowForDerive(dataFlow),
    );
    return relevantDataFlows.length > 0 ? relevantDataFlows : undefined;
  };

  const canonicalizeDataFlowForDerive = (
    dataFlow: NormalizedDataFlow,
  ): NormalizedDataFlow => {
    const info = getTrackedOpaqueAccessInfo(dataFlow.expression);
    if (
      !info?.root ||
      info.dynamic ||
      info.path.length === 0 ||
      !info.path.every((segment) => typeof segment === "string")
    ) {
      return dataFlow;
    }

    const expression = createKeyCall(
      context.factory.createIdentifier(info.root),
      info.path,
      context.factory,
    );
    registerReplacementType(expression, dataFlow.expression, context);
    return { ...dataFlow, expression };
  };

  const isDynamicElementAccess = (
    expression: ts.Expression,
  ): expression is ts.ElementAccessExpression => {
    return ts.isElementAccessExpression(expression) &&
      !!expression.argumentExpression &&
      ts.isExpression(expression.argumentExpression) &&
      !(
        ts.isLiteralExpression(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)
      );
  };

  const hasJsxExpressionAncestor = (node: ts.Node): boolean => {
    const scan = (start: ts.Node | undefined): boolean => {
      let current = start;
      while (current) {
        if (ts.isJsxExpression(current)) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };

    if (scan(node.parent)) {
      return true;
    }

    const original = ts.getOriginalNode(node);
    return original !== node && scan(original.parent);
  };

  const shouldWrapDirectJsxExpression = (node: ts.Node): boolean => {
    if (!hasJsxExpressionAncestor(node)) {
      return false;
    }

    let current = node.parent;
    while (current) {
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        context.isSyntheticComputeCallback(current)
      ) {
        return false;
      }
      current = current.parent;
    }

    return true;
  };

  const reportTrackedOpaqueComputation = (
    expression: ts.Expression | undefined,
    diagnosticNode: ts.Node,
    message: string,
  ): void => {
    if (!expression || !getTrackedOpaqueAccessInfo(expression)) {
      return;
    }

    reportOnce(diagnosticNode, "computation", message);
  };

  const registerOpaqueBindingState = (
    name: ts.BindingName,
    initializer: ts.Expression | undefined,
  ): void => {
    const initializerIsOpaque = !!initializer &&
      isOpaqueSourceExpression(
        initializer,
        activeOpaqueRoots,
        opaqueRootSymbols,
        context,
      );
    setBindingOpaqueState(name, initializerIsOpaque);
    if (initializerIsOpaque) {
      addBindingTargetSymbols(name, opaqueRootSymbols, context.checker);
    }
  };

  const maybeWrapDynamicInitializer = (
    initializer: ts.Expression,
  ): ts.Expression | undefined => {
    if (!ts.isBinaryExpression(initializer)) {
      return undefined;
    }

    if (!hasDynamicOpaqueAccess(initializer)) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(initializer);
    if (!relevantDataFlows) {
      return undefined;
    }

    const pendingWrap = findPendingComputeWrapCandidate(
      initializer,
      analyze,
      context,
    );
    if (!pendingWrap) {
      return undefined;
    }

    if (context.getReactiveContext(pendingWrap).kind !== "compute") {
      assertValidComputeWrapCandidate(
        pendingWrap,
        initializer,
        "pattern callback initializer",
        context,
      );
    }

    return createReactiveWrapperForExpression(
      initializer,
      relevantDataFlows,
      context,
    );
  };

  const maybeWrapDynamicJsxAccess = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    if (!shouldWrapDirectJsxExpression(expression)) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(expression);
    if (!relevantDataFlows) {
      return undefined;
    }

    return createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        preferDeriveWrapper: true,
      },
    );
  };

  const maybeWrapCellGetJsxCall = (
    expression: ts.CallExpression,
  ): ts.Expression | undefined => {
    if (classifyOpaquePathTerminalCall(expression) !== "get") {
      return undefined;
    }

    if (!shouldWrapDirectJsxExpression(expression)) {
      return undefined;
    }

    const callee = expression.expression;
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return undefined;
    }

    let receiverIsCellLike = !!getTrackedOpaqueAccessInfo(callee.expression);
    if (!receiverIsCellLike) {
      try {
        const receiverType = context.checker.getTypeAtLocation(
          callee.expression,
        );
        receiverIsCellLike = getCellKind(receiverType, context.checker) !==
          undefined;
      } catch {
        receiverIsCellLike = false;
      }
    }

    if (!receiverIsCellLike) {
      return undefined;
    }

    const relevantDataFlows = getRelevantDataFlowsForExpression(expression);
    if (!relevantDataFlows) {
      return undefined;
    }

    return createReactiveWrapperForExpression(
      expression,
      relevantDataFlows,
      context,
      {
        allowDirectExpressionWrap: true,
        preferDeriveWrapper: true,
      },
    );
  };

  const lowerOpaqueDestructuredVariableStatement = (
    statement: ts.VariableStatement,
  ): ts.VariableStatement | undefined => {
    const rewrittenDeclarations: ts.VariableDeclaration[] = [];
    let changed = false;

    for (const declaration of statement.declarationList.declarations) {
      if (
        !declaration.initializer ||
        ts.isIdentifier(declaration.name) ||
        declaration.type
      ) {
        rewrittenDeclarations.push(declaration);
        continue;
      }

      if (
        !isOpaqueSourceExpression(
          declaration.initializer,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        )
      ) {
        rewrittenDeclarations.push(declaration);
        continue;
      }

      const bindings: DestructureBinding[] = [];
      const defaults: DefaultDestructureBinding[] = [];
      const unsupported: string[] = [];
      collectDestructureBindings(
        declaration.name,
        [],
        bindings,
        defaults,
        unsupported,
        context,
      );

      if (unsupported.length > 0 || defaults.length > 0) {
        if (defaults.length > 0) {
          reportComputationError(
            context,
            declaration.name,
            "Destructuring defaults on opaque local bindings are not lowerable in pattern context; move defaulting into computed().",
          );
        }
        for (const message of unsupported) {
          reportComputationError(context, declaration.name, message);
        }
        rewrittenDeclarations.push(declaration);
        continue;
      }

      changed = true;

      const initializer = unwrapExpression(declaration.initializer);
      let rootIdentifier: ts.Identifier;
      if (ts.isIdentifier(initializer)) {
        rootIdentifier = context.factory.createIdentifier(initializer.text);
      } else {
        rootIdentifier = context.factory.createUniqueName("__cf_destructure");
        rewrittenDeclarations.push(
          context.factory.createVariableDeclaration(
            rootIdentifier,
            undefined,
            undefined,
            declaration.initializer,
          ),
        );
      }

      for (const binding of bindings) {
        let loweredInitializer: ts.Expression;
        if (binding.directKeyExpression) {
          loweredInitializer = context.factory.createElementAccessExpression(
            rootIdentifier,
            cloneKeyExpression(binding.directKeyExpression, context.factory),
          );
        } else if (binding.path.length === 0) {
          loweredInitializer = rootIdentifier;
        } else {
          loweredInitializer = createKeyCall(
            rootIdentifier,
            binding.path,
            context.factory,
          );
        }

        rewrittenDeclarations.push(
          context.factory.createVariableDeclaration(
            context.factory.createIdentifier(binding.localName),
            undefined,
            undefined,
            loweredInitializer,
          ),
        );
      }
    }

    if (!changed) return undefined;

    return context.factory.updateVariableStatement(
      statement,
      statement.modifiers,
      context.factory.updateVariableDeclarationList(
        statement.declarationList,
        rewrittenDeclarations,
      ),
    );
  };

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      if (node !== body) {
        return node;
      }
    }

    if (ts.isBlock(node) && node !== body) {
      enterScope();
      const rewritten = visitEachChildWithJsx(node, visit, context.tsContext);
      exitScope();
      return rewritten;
    }

    if (ts.isVariableStatement(node)) {
      const loweredStatement = lowerOpaqueDestructuredVariableStatement(node);
      if (loweredStatement) {
        return visit(loweredStatement);
      }
    }

    if (ts.isCallExpression(node)) {
      const wrappedCellGet = maybeWrapCellGetJsxCall(node);
      if (wrappedCellGet) {
        registerReplacementType(wrappedCellGet, node, context);
        return wrappedCellGet;
      }

      callTargetParents.set(node.expression, node);
    }

    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isTopmostMemberAccess(node)
    ) {
      if (isDynamicElementAccess(node)) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(node);
        if (wrappedDynamicAccess) {
          registerReplacementType(wrappedDynamicAccess, node, context);
          return wrappedDynamicAccess;
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isExpression(node.initializer)
    ) {
      const rewrittenInitializer = maybeWrapDynamicInitializer(
        node.initializer,
      );
      if (rewrittenInitializer) {
        const rewrittenDeclaration = context.factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          rewrittenInitializer,
        );
        registerOpaqueBindingState(
          rewrittenDeclaration.name,
          rewrittenInitializer,
        );
        return rewrittenDeclaration;
      }
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isVariableDeclaration(visited)) {
      registerOpaqueBindingState(visited.name, visited.initializer);
    }

    if (
      (ts.isPropertyAccessExpression(visited) ||
        ts.isElementAccessExpression(visited)) &&
      isTopmostMemberAccess(visited)
    ) {
      if (isDynamicElementAccess(visited)) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(visited);
        if (wrappedDynamicAccess) {
          registerReplacementType(wrappedDynamicAccess, visited, context);
          return wrappedDynamicAccess;
        }
      }

      const info = getTrackedOpaqueAccessInfo(visited);
      if (!info?.root) {
        return visited;
      }

      if (info.dynamic) {
        const wrappedDynamicAccess = maybeWrapDynamicJsxAccess(visited);
        if (wrappedDynamicAccess) {
          registerReplacementType(wrappedDynamicAccess, visited, context);
          return wrappedDynamicAccess;
        }

        reportOnce(
          visited,
          "computation",
          "Dynamic key access is not lowerable in pattern context. Use a compute wrapper for dynamic traversal.",
        );
        return visited;
      }

      if (ts.isPropertyAccessExpression(visited)) {
        const parentCall = callTargetParents.get(node);
        const unsupportedCallRoot = parentCall
          ? classifyUnsupportedExpressionSiteCallRoot(
            parentCall,
            context,
            analyze,
          )
          : undefined;

        if (
          KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text) && parentCall
        ) {
          if (unsupportedCallRoot === "optional-call") {
            return visited;
          }

          if (info.path.length <= 1) {
            return visited;
          }

          const receiverPath = info.path.slice(0, -1);
          const rewrittenReceiver = createKeyCall(
            context.factory.createIdentifier(info.root),
            receiverPath,
            context.factory,
          );
          const rewrittenMethod = context.factory
            .createPropertyAccessExpression(
              rewrittenReceiver,
              visited.name.text,
            );
          registerReplacementType(rewrittenMethod, visited, context);
          return rewrittenMethod;
        }

        if (parentCall) {
          if (
            unsupportedCallRoot === "optional-call" ||
            unsupportedCallRoot === "unsupported-receiver-method"
          ) {
            return visited;
          }

          reportOnce(
            visited,
            "computation",
            "Method calls on opaque pattern values are not lowerable. Move this call into computed().",
          );
          return visited;
        }
      }

      const firstPathSegment = info.path[0];
      if (
        info.path.length === 1 &&
        firstPathSegment &&
        isSelfPathSegment(firstPathSegment, context)
      ) {
        return visited;
      }

      if (info.path.length > 0) {
        const rewritten = createKeyCall(
          context.factory.createIdentifier(info.root),
          info.path,
          context.factory,
        );
        registerReplacementType(rewritten, visited, context);
        return rewritten;
      }
    }

    if (ts.isCallExpression(visited)) {
      const unsupportedCallRoot = classifyUnsupportedExpressionSiteCallRoot(
        visited,
        context,
        analyze,
      );
      if (unsupportedCallRoot === "unsupported-receiver-method") {
        const reactiveContext = context.getReactiveContext(visited);
        if (
          reactiveContext.kind === "pattern" &&
          (reactiveContext.owner === "pattern" ||
            reactiveContext.owner === "render") &&
          !reactiveContext.inJsxExpression
        ) {
          reportOnce(
            visited,
            "receiver-method",
            "Method calls on reactive values are not yet supported directly in non-JSX pattern bodies. Move this call into computed(() => ...), derive(...), or another safe wrapper.",
          );
        } else {
          reportOnce(
            visited,
            "receiver-method",
            "Method calls on opaque pattern values are not lowerable. Move this call into computed().",
          );
        }
      }

      if (isWildcardTraversalCall(visited, context.checker)) {
        reportTrackedOpaqueComputation(
          visited.arguments[0],
          visited.arguments[0] ?? visited,
          "Wildcard object traversal is not lowerable in pattern context. Move this expression into computed().",
        );
      }
    }

    if (ts.isSpreadElement(visited) || ts.isSpreadAssignment(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited,
        "Spread traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    if (ts.isForInStatement(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited.expression,
        "for..in traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    if (ts.isForOfStatement(visited)) {
      reportTrackedOpaqueComputation(
        visited.expression,
        visited.expression,
        "for..of traversal of opaque pattern values is not lowerable. Move this expression into computed().",
      );
    }

    return visited;
  };

  enterScope();
  if (ts.isBlock(body)) {
    const rewrittenBody = visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
    exitScope();
    return rewrittenBody;
  }

  const rewrittenExpr = visit(body) as ts.Expression;
  exitScope();
  return rewrittenExpr;
}

/**
 * Recursively process derive() callback bodies to rewrite property accesses
 * on locally-declared OpaqueRef variables (e.g., const foo = computed(...); foo.bar → foo.key("bar")).
 *
 * rewriteTrackedOpaquePatternBody stops at function boundaries, so derive
 * callback bodies are not processed by it. This pass finds derive() calls in
 * the given body, extracts their callbacks, and applies the tracked-opaque
 * rewrite to each callback body
 * with empty opaque roots (since derive callbacks receive unwrapped captures).
 * Local variables initialized from derive/computed/lift calls within the callback
 * will be detected as opaque roots by the tracked-opaque body's variable
 * tracking.
 */
function rewriteNestedDeriveCallbackBodies(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const visit = (node: ts.Node): ts.Node => {
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (!ts.isCallExpression(visited)) return visited;

    const deriveArgs = getDeriveInputAndCallbackArgument(
      visited,
      context.checker,
    );
    if (!deriveArgs) return visited;
    const { callback: callbackArg } = deriveArgs;
    const callbackIndex = visited.arguments.indexOf(callbackArg);

    let processedBody = rewriteNestedDeriveCallbackBodies(
      callbackArg.body,
      context,
    );

    const localOpaqueRootSymbols = collectLocalOpaqueRootSymbols(
      processedBody,
      context,
    );
    const localOpaqueRoots = new Set<string>();
    for (const parameter of callbackArg.parameters) {
      collectBindingNames(parameter.name, localOpaqueRoots);
    }

    processedBody = rewriteTrackedOpaquePatternBody(
      processedBody,
      new Set(),
      localOpaqueRootSymbols,
      context,
    );
    processedBody = rewriteDeriveCallbackComputedKeyAccesses(
      processedBody,
      localOpaqueRoots,
      context,
    );

    if (processedBody === callbackArg.body) return visited;

    const newCallback = ts.isArrowFunction(callbackArg)
      ? context.factory.updateArrowFunction(
        callbackArg,
        callbackArg.modifiers,
        callbackArg.typeParameters,
        callbackArg.parameters,
        callbackArg.type,
        callbackArg.equalsGreaterThanToken,
        processedBody,
      )
      : context.factory.updateFunctionExpression(
        callbackArg as ts.FunctionExpression,
        callbackArg.modifiers,
        (callbackArg as ts.FunctionExpression).asteriskToken,
        (callbackArg as ts.FunctionExpression).name,
        callbackArg.typeParameters,
        callbackArg.parameters,
        callbackArg.type,
        processedBody as ts.Block,
      );

    const args = [...visited.arguments];
    args[callbackIndex] = newCallback;
    return context.factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      args,
    );
  };

  if (ts.isBlock(body)) {
    return visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
  }
  return visit(body) as ts.Expression;
}

function rewriteDeriveCallbackComputedKeyAccesses(
  body: ts.ConciseBody,
  opaqueRoots: ReadonlySet<string>,
  context: TransformationContext,
): ts.ConciseBody {
  if (opaqueRoots.size === 0) {
    return body;
  }

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      return node;
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);
    if (
      !ts.isElementAccessExpression(visited) ||
      !isTopmostMemberAccess(visited) ||
      !ts.isIdentifier(visited.expression) ||
      !opaqueRoots.has(visited.expression.text) ||
      !visited.argumentExpression
    ) {
      return visited;
    }

    const keyName = getCommonFabricKeyName(
      visited.argumentExpression,
      context.checker,
    );
    if (!keyName) {
      return visited;
    }

    const rewritten = context.factory.createElementAccessExpression(
      context.factory.createIdentifier(visited.expression.text),
      context.cfHelpers.getHelperExpr(keyName),
    );
    registerReplacementType(rewritten, visited, context);
    return rewritten;
  };

  if (ts.isBlock(body)) {
    return visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
  }
  return visit(body) as ts.Expression;
}

function hasLocalOpaqueOriginBinding(
  body: ts.ConciseBody,
  context: TransformationContext,
): boolean {
  let found = false;

  const scan = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(node) && node !== body) return;

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        isOpaqueOriginCall(initializer, context)
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
  return found;
}

/**
 * Emit a diagnostic for the one-line `const x = wish(...).result` shape, which
 * the body-walker cannot lower because the call result has no name binding to
 * register as a local opaque root. The two-step form (`const w = wish(...);
 * const x = w.result;`) is supported; the one-line form silently produces
 * code where `.result` is plain JS access, and downstream consumers crash
 * with `TypeError: <x>.get is not a function` (or similar) at runtime.
 *
 * This is a build-time guard so the constraint is discoverable at the
 * authoring site rather than from a runtime stack trace in a different file.
 */
function reportInlineReactiveRootAccesses(
  body: ts.ConciseBody,
  context: TransformationContext,
): void {
  const reported = new Set<ts.Node>();

  const scan = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body) return;

    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      // Only flag source-level access sites — synthesized nodes (pos < 0)
      // come from earlier transformer passes that may have lowered
      // `(items ?? []).map(...)` or similar into a synthesized
      // `.method-on-call` shape that LOOKS like the bug but isn't
      // user-authored. This is a build-time guard for user-authored shapes.
      node.pos >= 0
    ) {
      // Only flag the topmost access in a chain (e.g. `wish(...).result` —
      // not `.result` deep inside a longer chain). The topmost site is
      // where the user wrote the access; reporting on inner sites would
      // duplicate the error.
      if (isTopmostMemberAccess(node)) {
        const receiver = findInlineOpaqueOriginCallReceiver(node, context);
        if (receiver && !reported.has(node)) {
          reported.add(node);
          context.reportDiagnostic({
            severity: "error",
            type: "pattern-context:inline-reactive-root-access",
            message: "Cannot read a property directly off the result of a " +
              "reactive-origin call (e.g. wish/computed) in a pattern body. " +
              "Bind the call result to a `const` first, then read the " +
              "property from the binding. For example, instead of " +
              "`const x = wish(...).result;` write " +
              "`const w = wish(...); const x = w.result;`.",
            node,
          });
        }
      }
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
}

/**
 * If `access` is a property/element access chain that bottoms out on a
 * directly-invoked opaque-origin call (without an intermediate Identifier),
 * return that call expression. Otherwise return undefined.
 */
function findInlineOpaqueOriginCallReceiver(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  context: TransformationContext,
): ts.CallExpression | undefined {
  let current: ts.Expression = access.expression;
  // Walk through any non-semantic wrappers (parens, casts) and chained
  // property/element accesses to find the receiver of the chain.
  while (true) {
    const unwrapped = unwrapExpression(current);
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      current = unwrapped.expression;
      continue;
    }
    current = unwrapped;
    break;
  }
  if (
    ts.isCallExpression(current) &&
    isOpaqueOriginCall(current, context)
  ) {
    return current;
  }
  return undefined;
}

function collectBindingNames(
  name: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNames(element.name, names);
  }
}
