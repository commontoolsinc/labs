import ts from "typescript";
import {
  detectCallKind,
  getTypeAtLocationWithFallback,
  isFunctionLikeExpression,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import {
  type CapabilityParamDefault,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  cloneKeyExpression,
  getKnownComputedKeyExpression,
  isCommonToolsKeyExpression,
} from "../utils/reactive-keys.ts";
import {
  collectDestructureBindings,
  createKeyCall,
  type DefaultDestructureBinding,
  type DestructureBinding,
  type PathSegment,
} from "./destructuring-lowering.ts";

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

const WILDCARD_OBJECT_METHODS = new Set(["keys", "values", "entries"]);

function isSelfPathSegment(
  segment: PathSegment,
  context: TransformationContext,
): boolean {
  return typeof segment !== "string" &&
    (
      isCommonToolsKeyExpression(segment, context, "SELF")
    );
}

function getAccessInfo(
  expr: ts.Expression,
  context: TransformationContext,
): {
  root?: string;
  rootIdentifier?: ts.Identifier;
  path: PathSegment[];
  dynamic: boolean;
} {
  const path: PathSegment[] = [];
  let current: ts.Expression = expr;
  let dynamic = false;

  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const arg = current.argumentExpression;
      if (
        arg &&
        (ts.isStringLiteral(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        path.unshift(arg.text);
      } else if (arg) {
        const knownKeyExpression = getKnownComputedKeyExpression(arg, context);
        if (knownKeyExpression) {
          path.unshift(knownKeyExpression);
        } else {
          dynamic = true;
        }
      } else {
        dynamic = true;
      }
      current = current.expression;
      continue;
    }

    break;
  }

  if (ts.isIdentifier(current)) {
    return { root: current.text, rootIdentifier: current, path, dynamic };
  }

  return { path, dynamic };
}

function isTopmostMemberAccess(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
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

function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const kind = detectCallKind(call, checker);
  if (kind?.kind === "builder" && kind.builderName === "pattern") {
    return true;
  }

  const expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text === "pattern";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "pattern";
  }
  return false;
}

function registerCapabilitySummary(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  interprocedural: boolean,
  defaultsByParamName?: ReadonlyMap<string, readonly CapabilityParamDefault[]>,
): void {
  const registry = context.options.capabilitySummaryRegistry;
  if (!registry) return;

  const summary = analyzeFunctionCapabilities(callback, {
    checker: context.checker,
    interprocedural,
  });

  if (!defaultsByParamName || defaultsByParamName.size === 0) {
    registry.set(callback, summary);
    return;
  }

  registry.set(callback, {
    ...summary,
    params: summary.params.map((param) => {
      const defaults = defaultsByParamName.get(param.name);
      if (!defaults || defaults.length === 0) {
        return param;
      }
      return {
        ...param,
        defaults,
      };
    }),
  });
}

function reportComputationError(
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

function isOpaqueOriginCall(
  expression: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const kind = detectCallKind(expression, context.checker);
  if (!kind) return false;

  switch (kind.kind) {
    case "builder":
    case "cell-factory":
    case "cell-for":
    case "derive":
    case "wish":
    case "generate-object":
    case "pattern-tool":
      return true;
    default:
      return false;
  }
}

function isOpaqueSourceExpression(
  expression: ts.Expression,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const current = unwrapExpression(expression);
  const info = getAccessInfo(current, context);
  if (isOpaqueRootInfo(info, opaqueRoots, opaqueRootSymbols, context)) {
    return true;
  }

  if (ts.isCallExpression(current)) {
    if (isOpaqueOriginCall(current, context)) {
      return true;
    }

    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      if (methodName === "key" || methodName === "get") {
        return isOpaqueSourceExpression(
          current.expression.expression,
          opaqueRoots,
          opaqueRootSymbols,
          context,
        );
      }
    }
  }

  return false;
}

function isOpaqueRootInfo(
  info: ReturnType<typeof getAccessInfo>,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const rootIdentifier = info.rootIdentifier;
  if (rootIdentifier) {
    const symbol = context.checker.getSymbolAtLocation(rootIdentifier);
    if (symbol) {
      if (opaqueRootSymbols.has(symbol)) return true;
    }
  }

  return !!info.root && opaqueRoots.has(info.root);
}

function addBindingTargetSymbols(
  name: ts.BindingName,
  bucket: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) {
      bucket.add(symbol);
    }
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingTargetSymbols(element.name, bucket, checker);
  }
}

function reportOptionalError(
  context: TransformationContext,
  node: ts.Node,
  message: string,
): void {
  context.reportDiagnostic({
    severity: "error",
    type: "pattern-context:optional-chaining",
    message,
    node,
  });
}

function rewritePatternBody(
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

  const diagnosticsSeen = new Set<string>();
  let syntheticCounter = 0;
  const reportOnce = (
    node: ts.Node,
    type: "computation" | "optional",
    message: string,
  ): void => {
    // Synthetic nodes (from prior transformers) lack real positions.
    // Try getStart, fall back to original node, then assign a unique key
    // so synthetic nodes are never incorrectly deduped with each other.
    let key: string;
    try {
      key = String(node.getStart(context.sourceFile));
    } catch {
      const original = ts.getOriginalNode(node);
      try {
        key = original !== node && original.pos >= 0
          ? String(original.getStart(context.sourceFile))
          : `synthetic:${syntheticCounter++}`;
      } catch {
        key = `synthetic:${syntheticCounter++}`;
      }
    }
    if (diagnosticsSeen.has(key)) return;
    diagnosticsSeen.add(key);
    if (type === "computation") {
      reportComputationError(context, node, message);
    } else {
      reportOptionalError(context, node, message);
    }
  };

  const callTargets = new WeakSet<ts.Node>();

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

    // Record call targets BEFORE visiting children so nested visits can
    // determine whether a PropertyAccessExpression is a method-call callee
    // without relying on parent pointers (which are absent on synthetic nodes).
    if (ts.isCallExpression(node)) {
      callTargets.add(node.expression);
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (ts.isVariableDeclaration(visited)) {
      const initializerIsOpaque = !!visited.initializer &&
        isOpaqueSourceExpression(
          visited.initializer,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        );
      setBindingOpaqueState(visited.name, initializerIsOpaque);
      if (initializerIsOpaque) {
        addBindingTargetSymbols(
          visited.name,
          opaqueRootSymbols,
          context.checker,
        );
      }
    }

    if (
      (ts.isPropertyAccessExpression(visited) ||
        ts.isElementAccessExpression(visited)) &&
      isTopmostMemberAccess(visited)
    ) {
      const info = getAccessInfo(visited, context);
      if (
        !info.root ||
        !isOpaqueRootInfo(
          info,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        )
      ) {
        return visited;
      }

      // Handle PropertyAccessExpression call targets first, before the
      // info.dynamic check. Known terminal methods (map, mapWithPattern, etc.)
      // are handled by the closure/array-method transformers and should not
      // trigger dynamic-access errors even when their receiver contains a
      // dynamic element access — that access is reported separately when
      // visited in its own context.
      if (ts.isPropertyAccessExpression(visited)) {
        const isCallTarget = callTargets.has(node);

        if (
          KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text) && isCallTarget
        ) {
          const parentCall = visited.parent;
          if (
            (parentCall && ts.isCallExpression(parentCall) &&
              parentCall.questionDotToken) ||
            visited.questionDotToken
          ) {
            reportOnce(
              visited,
              "optional",
              "Optional-call forms are not lowerable in pattern context. Move this access into computed().",
            );
            return visited;
          }

          if (info.path.length <= 1) {
            return visited;
          }

          if (info.dynamic) {
            // The receiver contains a dynamic access (e.g. obj[key].map(...)).
            // We can't rewrite the receiver path to .key() calls when it
            // contains a dynamic segment. Return as-is; the dynamic access
            // will be reported when visited in its own context.
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

        if (isCallTarget) {
          const parentCall = visited.parent;
          if (
            (parentCall && ts.isCallExpression(parentCall) &&
              parentCall.questionDotToken) ||
            visited.questionDotToken
          ) {
            reportOnce(
              visited,
              "optional",
              "Optional-call forms are not lowerable in pattern context. Move this access into computed().",
            );
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

      // Dynamic key access on non-terminal-method expressions is not lowerable.
      if (info.dynamic) {
        reportOnce(
          visited,
          "computation",
          "Dynamic key access is not lowerable in pattern context. Use a compute wrapper for dynamic traversal.",
        );
        return visited;
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
      if (visited.questionDotToken) {
        const info = getAccessInfo(visited.expression, context);
        if (
          isOpaqueRootInfo(
            info,
            activeOpaqueRoots,
            opaqueRootSymbols,
            context,
          )
        ) {
          reportOnce(
            visited,
            "optional",
            "Optional-call forms are not lowerable in pattern context. Move this expression into computed().",
          );
        }
      }

      if (
        ts.isPropertyAccessExpression(visited.expression) &&
        ts.isIdentifier(visited.expression.expression) &&
        visited.expression.expression.text === "Object" &&
        WILDCARD_OBJECT_METHODS.has(visited.expression.name.text)
      ) {
        const firstArg = visited.arguments[0];
        if (firstArg) {
          const info = getAccessInfo(firstArg, context);
          if (
            isOpaqueRootInfo(
              info,
              activeOpaqueRoots,
              opaqueRootSymbols,
              context,
            )
          ) {
            reportOnce(
              firstArg,
              "computation",
              "Wildcard object traversal is not lowerable in pattern context. Move this expression into computed().",
            );
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(visited.expression) &&
        ts.isIdentifier(visited.expression.expression) &&
        visited.expression.expression.text === "JSON" &&
        visited.expression.name.text === "stringify"
      ) {
        const firstArg = visited.arguments[0];
        if (firstArg) {
          const info = getAccessInfo(firstArg, context);
          if (
            isOpaqueRootInfo(
              info,
              activeOpaqueRoots,
              opaqueRootSymbols,
              context,
            )
          ) {
            reportOnce(
              firstArg,
              "computation",
              "Wildcard object traversal is not lowerable in pattern context. Move this expression into computed().",
            );
          }
        }
      }
    }

    if (ts.isSpreadElement(visited) || ts.isSpreadAssignment(visited)) {
      const info = getAccessInfo(visited.expression, context);
      if (
        isOpaqueRootInfo(
          info,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        )
      ) {
        reportOnce(
          visited,
          "computation",
          "Spread traversal of opaque pattern values is not lowerable. Move this expression into computed().",
        );
      }
    }

    if (ts.isForInStatement(visited)) {
      const info = getAccessInfo(visited.expression, context);
      if (
        isOpaqueRootInfo(
          info,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        )
      ) {
        reportOnce(
          visited.expression,
          "computation",
          "for..in traversal of opaque pattern values is not lowerable. Move this expression into computed().",
        );
      }
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

/** Property names that correspond to reactive data in map callback params. */
const MAP_REACTIVE_PROPERTIES = new Set(["element", "index", "array"]);

/**
 * Check if a map callback binding is for a non-reactive capture.
 *
 * In map callbacks created by the ClosureTransformer, bindings under the
 * "params" namespace are captures from the outer scope.  Some captures are
 * reactive (e.g. the outer pattern's input cells) and some are plain values
 * (e.g. local `const` objects).  The `nonReactiveCaptures` set, computed by
 * the pre-scan pass, tells us which capture names correspond to non-reactive
 * outer variables.
 */
function isNonReactiveCapture(
  binding: DestructureBinding,
  nonReactiveCaptures?: ReadonlySet<string>,
): boolean {
  if (!nonReactiveCaptures || nonReactiveCaptures.size === 0) return false;
  if (binding.path.length < 2) return false;
  // Captures live under the "params" namespace in map callbacks.
  if (binding.path[0] !== "params") return false;
  const captureName = binding.path[1];
  return typeof captureName === "string" &&
    nonReactiveCaptures.has(captureName);
}

function isReactiveArrayMethodBinding(
  binding: DestructureBinding,
  nonReactiveCaptures?: ReadonlySet<string>,
): boolean {
  if (binding.path.length === 0) return false;
  const rootProp = binding.path[0];
  if (typeof rootProp !== "string") return false;
  // Known framework parameters are always reactive.
  if (MAP_REACTIVE_PROPERTIES.has(rootProp)) return true;
  // Captures under "params" are reactive unless the pre-scan determined
  // that the outer scope variable is non-reactive.
  if (rootProp === "params") {
    return !isNonReactiveCapture(binding, nonReactiveCaptures);
  }
  // Top-level captures (no "params" namespace) — treat as reactive by default.
  return true;
}

function transformPatternCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  isArrayMethodCallback = false,
  nonReactiveCaptures?: ReadonlySet<string>,
): ts.ArrowFunction | ts.FunctionExpression {
  const factory = context.factory;
  const firstParam = callback.parameters[0];
  const opaqueRoots = new Set<string>();
  const opaqueRootSymbols = new Set<ts.Symbol>();
  const diagnostics: string[] = [];
  const extractedDefaults: DefaultDestructureBinding[] = [];
  let hasUnsupportedDestructuring = false;
  let summaryParamName: string | undefined;

  let updatedParameters = callback.parameters;
  let prologue: ts.Statement[] = [];

  if (firstParam) {
    if (ts.isIdentifier(firstParam.name)) {
      opaqueRoots.add(firstParam.name.text);
      const symbol = context.checker.getSymbolAtLocation(firstParam.name);
      if (symbol) {
        opaqueRootSymbols.add(symbol);
      }
      summaryParamName = firstParam.name.text;
    } else if (
      ts.isObjectBindingPattern(firstParam.name) ||
      ts.isArrayBindingPattern(firstParam.name)
    ) {
      const bindings: DestructureBinding[] = [];
      collectDestructureBindings(
        firstParam.name,
        [],
        bindings,
        extractedDefaults,
        diagnostics,
        context,
      );
      if (diagnostics.length > 0) {
        for (const message of diagnostics) {
          reportComputationError(context, firstParam, message);
        }
        hasUnsupportedDestructuring = true;
      }

      const inputIdentifier = factory.createIdentifier("__ct_pattern_input");
      opaqueRoots.add(inputIdentifier.text);
      const inputSymbol = context.checker.getSymbolAtLocation(firstParam.name);
      if (inputSymbol) {
        opaqueRootSymbols.add(inputSymbol);
      }
      addBindingTargetSymbols(
        firstParam.name,
        opaqueRootSymbols,
        context.checker,
      );

      const rewrittenFirstParam = factory.updateParameterDeclaration(
        firstParam,
        firstParam.modifiers,
        firstParam.dotDotDotToken,
        inputIdentifier,
        firstParam.questionToken,
        firstParam.type,
        firstParam.initializer,
      );
      summaryParamName = inputIdentifier.text;

      updatedParameters = factory.createNodeArray([
        rewrittenFirstParam,
        ...callback.parameters.slice(1),
      ]);

      prologue = bindings.map((binding) => {
        let initializer: ts.Expression;
        if (binding.directKeyExpression) {
          initializer = factory.createElementAccessExpression(
            factory.createIdentifier(inputIdentifier.text),
            cloneKeyExpression(binding.directKeyExpression, factory),
          );
        } else if (binding.path.length === 0) {
          initializer = factory.createIdentifier(inputIdentifier.text);
        } else {
          initializer = createKeyCall(
            inputIdentifier,
            binding.path,
            factory,
          );
        }

        // For array method callback captures that are non-reactive in the outer scope
        // (e.g. a local `const` object), skip .key() and build a chained
        // property access so the runtime provides the concrete value instead
        // of wrapping it in an opaque cell ref.
        if (
          isArrayMethodCallback &&
          isNonReactiveCapture(binding, nonReactiveCaptures)
        ) {
          initializer = factory.createIdentifier(inputIdentifier.text);
          for (const segment of binding.path) {
            if (typeof segment === "string") {
              initializer = factory.createPropertyAccessExpression(
                initializer,
                factory.createIdentifier(segment),
              );
            }
          }
        }

        return factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier(binding.localName),
                undefined,
                undefined,
                initializer,
              ),
            ],
            ts.NodeFlags.Const,
          ),
        );
      });
      for (const binding of bindings) {
        // For map callbacks, skip non-reactive captures from opaqueRoots so the
        // body rewriting does not transform their property accesses to .key()
        // calls or flag their spreads as non-lowerable.
        if (
          isArrayMethodCallback &&
          !isReactiveArrayMethodBinding(binding, nonReactiveCaptures)
        ) {
          continue;
        }
        opaqueRoots.add(binding.localName);
      }
    } else {
      reportComputationError(
        context,
        firstParam,
        "Pattern parameter destructuring form is not lowerable. Use an object parameter and explicit input.key(...) bindings.",
      );
      hasUnsupportedDestructuring = true;
    }
  }

  // Keep authored callback parameter bindings intact when we already know
  // lowering is non-lowerable. This avoids generating unbound identifiers.
  if (hasUnsupportedDestructuring) {
    registerCapabilitySummary(callback, context, false);
    return callback;
  }

  const defaultsByParamName = new Map<
    string,
    readonly CapabilityParamDefault[]
  >();
  if (summaryParamName && extractedDefaults.length > 0) {
    defaultsByParamName.set(
      summaryParamName,
      extractedDefaults.map((entry) => ({
        path: entry.path,
        defaultType: entry.defaultType,
      })),
    );
  }

  let body: ts.ConciseBody = callback.body;
  body = rewritePatternBody(body, opaqueRoots, opaqueRootSymbols, context);

  if (prologue.length > 0) {
    if (ts.isBlock(body)) {
      body = factory.createBlock([...prologue, ...body.statements], true);
    } else {
      body = factory.createBlock(
        [...prologue, factory.createReturnStatement(body)],
        true,
      );
    }
  }

  if (ts.isArrowFunction(callback)) {
    const transformed = factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      updatedParameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    );
    registerCapabilitySummary(
      transformed,
      context,
      false,
      defaultsByParamName,
    );
    return transformed;
  }

  const transformed = factory.updateFunctionExpression(
    callback,
    callback.modifiers,
    callback.asteriskToken,
    callback.name,
    callback.typeParameters,
    updatedParameters,
    callback.type,
    body as ts.Block,
  );
  registerCapabilitySummary(
    transformed,
    context,
    false,
    defaultsByParamName,
  );
  return transformed;
}

function maybeRegisterBuilderCapabilitySummary(
  node: ts.CallExpression,
  context: TransformationContext,
): void {
  const callKind = detectCallKind(node, context.checker);
  if (!callKind) return;

  const registerFrom = (arg: ts.Expression | undefined): void => {
    if (!arg || !isFunctionLikeExpression(arg)) return;
    registerCapabilitySummary(arg, context, true);
  };

  if (callKind.kind === "derive") {
    registerFrom(node.arguments[1]);
    return;
  }

  if (callKind.kind === "builder") {
    if (callKind.builderName === "lift") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "handler") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "computed") {
      registerFrom(node.arguments[0]);
      return;
    }
    if (callKind.builderName === "action") {
      registerFrom(node.arguments[0]);
      return;
    }
  }
}

function registerBuilderSummariesInSubtree(
  node: ts.Node,
  context: TransformationContext,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      maybeRegisterBuilderCapabilitySummary(current, context);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

export class CapabilityLoweringTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.ctHelpers.sourceHasHelpers();
  }

  transform(context: TransformationContext): ts.SourceFile {
    // ── Pre-scan pass ──────────────────────────────────────────────────
    // Walk the AST top-down to:
    // 1. Identify which pattern() calls are map callback patterns (first
    //    argument to mapWithPattern()).
    // 2. For each such map pattern, determine which captures are
    //    non-reactive by checking whether the captured variable name
    //    exists in the enclosing pattern's opaque parameter set.
    //
    // This information is consumed by transformPatternCallback to decide
    // whether a capture should use .key() (reactive) or direct property
    // access (non-reactive, e.g. a local `const` object literal).
    const arrayMethodPatternCallNodes = new Set<ts.Node>();
    const nonReactiveCapturesByMapPattern = new Map<
      ts.Node,
      Set<string>
    >();

    {
      // Per-scope info tracked during the pre-scan walk.
      interface ScopeInfo {
        /** Names that are opaque/reactive in this pattern scope. */
        opaqueNames: Set<string>;
        /** Symbols that are opaque/reactive. */
        opaqueSymbols: Set<ts.Symbol>;
      }

      const scopeStack: ScopeInfo[] = [];

      const collectBindingNames = (
        name: ts.BindingName,
        names: Set<string>,
      ): void => {
        if (ts.isIdentifier(name)) {
          names.add(name.text);
        } else if (ts.isObjectBindingPattern(name)) {
          for (const el of name.elements) {
            collectBindingNames(el.name, names);
          }
        } else if (ts.isArrayBindingPattern(name)) {
          for (const el of name.elements) {
            if (!ts.isOmittedExpression(el)) {
              collectBindingNames(el.name, names);
            }
          }
        }
      };

      /** Walk the pattern body to propagate opaque bindings. */
      const collectOpaqueBindings = (
        body: ts.ConciseBody,
        scope: ScopeInfo,
      ): void => {
        if (!ts.isBlock(body)) return;
        for (const stmt of body.statements) {
          if (!ts.isVariableStatement(stmt)) continue;
          for (const decl of stmt.declarationList.declarations) {
            if (!decl.initializer) continue;
            if (
              ts.isIdentifier(decl.name) &&
              isOpaqueSourceExpression(
                decl.initializer,
                scope.opaqueNames,
                scope.opaqueSymbols,
                context,
              )
            ) {
              scope.opaqueNames.add(decl.name.text);
              const sym = context.checker.getSymbolAtLocation(decl.name);
              if (sym) scope.opaqueSymbols.add(sym);
            }
          }
        }
      };

      const preScan = (node: ts.Node): void => {
        // Detect pattern() builder calls and push scope info onto the
        // stack so nested mapWithPattern() calls can classify captures.
        let pushed = false;
        if (
          ts.isCallExpression(node) &&
          isPatternBuilderCall(node, context.checker)
        ) {
          const cb = node.arguments[0];
          if (cb && isFunctionLikeExpression(cb)) {
            const opaqueNames = new Set<string>();
            const opaqueSymbols = new Set<ts.Symbol>();
            const firstParam = cb.parameters[0];
            if (firstParam) {
              collectBindingNames(firstParam.name, opaqueNames);
              addBindingTargetSymbols(
                firstParam.name,
                opaqueSymbols,
                context.checker,
              );
            }
            const scope: ScopeInfo = { opaqueNames, opaqueSymbols };
            collectOpaqueBindings(cb.body, scope);
            scopeStack.push(scope);
            pushed = true;
          }
        }

        // Detect mapWithPattern() calls.
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "mapWithPattern" &&
          node.arguments[0] &&
          ts.isCallExpression(node.arguments[0])
        ) {
          const innerPattern = node.arguments[0];
          arrayMethodPatternCallNodes.add(innerPattern);

          // Determine non-reactive captures: a capture is non-reactive
          // when its original binding is not opaque/reactive in the
          // enclosing pattern scope.
          const scope = scopeStack.at(-1);
          if (scope && node.arguments[1]) {
            const capturesArg = node.arguments[1];
            if (ts.isObjectLiteralExpression(capturesArg)) {
              const nonReactive = new Set<string>();
              for (const prop of capturesArg.properties) {
                let originalName: string | undefined;
                let captureName: string | undefined;
                if (ts.isShorthandPropertyAssignment(prop)) {
                  originalName = prop.name.text;
                  captureName = prop.name.text;
                } else if (
                  ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)
                ) {
                  captureName = prop.name.text;
                  originalName = ts.isIdentifier(prop.initializer)
                    ? prop.initializer.text
                    : prop.name.text;
                }
                if (
                  originalName && captureName &&
                  !scope.opaqueNames.has(originalName)
                ) {
                  nonReactive.add(captureName);
                }
              }
              if (nonReactive.size > 0) {
                nonReactiveCapturesByMapPattern.set(innerPattern, nonReactive);
              }
            }
          }
        }

        ts.forEachChild(node, preScan);

        if (pushed) scopeStack.pop();
      };

      preScan(context.sourceFile);
    }

    // ── Main transform pass ────────────────────────────────────────────
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

      if (!ts.isCallExpression(visitedNode)) {
        return visitedNode;
      }

      if (isPatternBuilderCall(visitedNode, context.checker)) {
        const callbackArg = visitedNode.arguments[0];
        if (callbackArg && isFunctionLikeExpression(callbackArg)) {
          const isArrayMethodCallback = arrayMethodPatternCallNodes.has(node);
          const nonReactiveCaptures = isArrayMethodCallback
            ? nonReactiveCapturesByMapPattern.get(node)
            : undefined;
          const transformedCallback = transformPatternCallback(
            callbackArg,
            context,
            isArrayMethodCallback,
            nonReactiveCaptures,
          );
          const rewritten = context.factory.updateCallExpression(
            visitedNode,
            visitedNode.expression,
            visitedNode.typeArguments,
            [
              transformedCallback,
              ...visitedNode.arguments.slice(1),
            ],
          );
          registerBuilderSummariesInSubtree(transformedCallback.body, context);
          maybeRegisterBuilderCapabilitySummary(rewritten, context);
          return rewritten;
        }
      }

      maybeRegisterBuilderCapabilitySummary(visitedNode, context);
      return visitedNode;
    };

    return visitEachChildWithJsx(
      context.sourceFile,
      visit,
      context.tsContext,
    ) as ts.SourceFile;
  }
}
