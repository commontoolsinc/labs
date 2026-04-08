import ts from "typescript";
import {
  getDeriveInputAndCallbackArgument,
  getTypeAtLocationWithFallback,
  isWildcardTraversalCall,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  cloneKeyExpression,
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
  collectLocalOpaqueRootSymbols,
  getOpaqueAccessInfo,
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
  if (opaqueRoots.size === 0 && opaqueRootSymbols.size === 0) {
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
    const relevantDataFlows = context.getRelevantDataFlows(expression);
    return relevantDataFlows.length > 0 ? relevantDataFlows : undefined;
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

    assertValidComputeWrapCandidate(
      pendingWrap,
      initializer,
      "pattern callback initializer",
      context,
    );

    return createReactiveWrapperForExpression(
      initializer,
      relevantDataFlows,
      context,
    );
  };

  const maybeWrapDynamicJsxAccess = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    const reactiveContext = context.getReactiveContext(expression);
    if (
      reactiveContext.kind !== "pattern" || !reactiveContext.inJsxExpression
    ) {
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
      callTargetParents.set(node.expression, node);
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

    processedBody = rewriteTrackedOpaquePatternBody(
      processedBody,
      new Set(),
      localOpaqueRootSymbols,
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
