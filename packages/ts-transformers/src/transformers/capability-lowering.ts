import ts from "typescript";
import {
  detectCallKind,
  isFunctionLikeExpression,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";

interface DestructureBinding {
  readonly localName: string;
  readonly path: readonly string[];
}

const KNOWN_PATH_TERMINAL_METHODS = new Set([
  "set",
  "update",
  "get",
  "key",
  "map",
  "mapWithPattern",
]);

const WILDCARD_OBJECT_METHODS = new Set(["keys", "values", "entries"]);

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
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
    return current;
  }
}

function getAccessInfo(expr: ts.Expression): {
  root?: string;
  path: string[];
  dynamic: boolean;
} {
  const path: string[] = [];
  let current: ts.Expression = expr;
  let dynamic = false;

  while (true) {
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
      } else {
        dynamic = true;
      }
      current = current.expression;
      continue;
    }

    break;
  }

  if (ts.isIdentifier(current)) {
    return { root: current.text, path, dynamic };
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

function collectDestructureBindings(
  name: ts.BindingName,
  path: readonly string[],
  bindings: DestructureBinding[],
  unsupported: string[],
): void {
  if (ts.isIdentifier(name)) {
    bindings.push({
      localName: name.text,
      path,
    });
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    unsupported.push(
      "Array destructuring is not lowerable in pattern context; use explicit input.key(...) bindings.",
    );
    return;
  }

  for (const element of name.elements) {
    if (element.dotDotDotToken) {
      unsupported.push(
        "Rest destructuring is not lowerable in pattern context; avoid ...rest in pattern parameters.",
      );
      continue;
    }

    if (element.initializer) {
      unsupported.push(
        "Default destructuring initializers are not lowerable in pattern context; move defaulting into computed().",
      );
      continue;
    }

    let key: string | undefined;
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        key = element.name.text;
      } else {
        unsupported.push(
          "Nested binding without explicit property key is not lowerable in pattern context.",
        );
        continue;
      }
    } else if (ts.isIdentifier(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isStringLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isNumericLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isComputedPropertyName(element.propertyName)) {
      unsupported.push(
        "Computed destructuring keys are not lowerable in pattern context; use explicit input.key(dynamicKey).",
      );
      continue;
    } else {
      unsupported.push(
        "Unsupported destructuring key in pattern context; use explicit input.key(...).",
      );
      continue;
    }

    const nextPath = [...path, key];
    if (ts.isIdentifier(element.name)) {
      bindings.push({
        localName: element.name.text,
        path: nextPath,
      });
      continue;
    }

    if (ts.isArrayBindingPattern(element.name)) {
      unsupported.push(
        "Array destructuring is not lowerable in pattern context; use explicit input.key(...) bindings.",
      );
      continue;
    }

    collectDestructureBindings(element.name, nextPath, bindings, unsupported);
  }
}

function createKeyCall(
  rootIdentifier: ts.Identifier,
  path: readonly string[],
  factory: ts.NodeFactory,
): ts.Expression {
  const keyCall = factory.createCallExpression(
    factory.createPropertyAccessExpression(
      factory.createIdentifier(rootIdentifier.text),
      factory.createIdentifier("key"),
    ),
    undefined,
    path.map((segment) => factory.createStringLiteral(segment)),
  );
  return keyCall;
}

function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const kind = detectCallKind(call, checker);
  return kind?.kind === "builder" && kind.builderName === "pattern";
}

function registerCapabilitySummary(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): void {
  const registry = context.options.capabilitySummaryRegistry;
  if (!registry) return;
  registry.set(callback, analyzeFunctionCapabilities(callback));
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

  if (kind.kind === "builder") {
    return kind.builderName === "lift" || kind.builderName === "pattern";
  }

  return false;
}

function isOpaqueSourceExpression(
  expression: ts.Expression,
  opaqueRoots: ReadonlySet<string>,
  context: TransformationContext,
): boolean {
  const current = unwrapExpression(expression);
  const info = getAccessInfo(current);
  if (info.root && opaqueRoots.has(info.root)) {
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
          context,
        );
      }
    }
  }

  return false;
}

function addBindingTargets(
  name: ts.BindingName,
  bucket: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    bucket.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingTargets(element.name, bucket);
  }
}

function addAssignmentTargets(
  target: ts.Expression,
  bucket: Set<string>,
): void {
  if (ts.isParenthesizedExpression(target)) {
    addAssignmentTargets(target.expression, bucket);
    return;
  }

  if (ts.isIdentifier(target)) {
    bucket.add(target.text);
    return;
  }

  if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        bucket.add(property.name.text);
      } else if (ts.isPropertyAssignment(property)) {
        addAssignmentTargets(property.initializer, bucket);
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(target)) {
    for (const element of target.elements) {
      if (ts.isSpreadElement(element)) continue;
      addAssignmentTargets(element, bucket);
    }
  }
}

function collectOpaqueRootsFromBody(
  body: ts.ConciseBody,
  initialRoots: ReadonlySet<string>,
  context: TransformationContext,
): Set<string> {
  const roots = new Set(initialRoots);

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body) {
      // Nested callbacks own their own origin tracking.
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      if (
        node.initializer &&
        isOpaqueSourceExpression(node.initializer, roots, context)
      ) {
        addBindingTargets(node.name, roots);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isOpaqueSourceExpression(node.right, roots, context)
    ) {
      addAssignmentTargets(node.left, roots);
    }

    ts.forEachChild(node, visit);
  };

  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      visit(statement);
    }
  } else {
    visit(body);
  }

  return roots;
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
  opaqueRoots: ReadonlySet<string>,
  context: TransformationContext,
): ts.ConciseBody {
  if (opaqueRoots.size === 0) {
    return body;
  }

  const diagnosticsSeen = new Set<number>();
  const reportOnce = (
    node: ts.Node,
    type: "computation" | "optional",
    message: string,
  ): void => {
    const key = node.getStart(context.sourceFile);
    if (diagnosticsSeen.has(key)) return;
    diagnosticsSeen.add(key);
    if (type === "computation") {
      reportComputationError(context, node, message);
    } else {
      reportOptionalError(context, node, message);
    }
  };

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      if (node !== body) {
        return node;
      }
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (
      (ts.isPropertyAccessExpression(visited) ||
        ts.isElementAccessExpression(visited)) &&
      isTopmostMemberAccess(visited)
    ) {
      const info = getAccessInfo(visited);
      if (!info.root || !opaqueRoots.has(info.root)) {
        return visited;
      }

      if (info.dynamic) {
        reportOnce(
          visited,
          "computation",
          "Dynamic key access is not lowerable in pattern context. Use a compute wrapper for dynamic traversal.",
        );
        return visited;
      }

      if (
        ts.isPropertyAccessExpression(visited) &&
        KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text)
      ) {
        const parent = visited.parent;
        if (
          !parent ||
          (ts.isCallExpression(parent) && parent.expression === visited)
        ) {
          return visited;
        }
      }

      const parent = visited.parent;
      if (
        !!parent &&
        ts.isCallExpression(parent) &&
        parent.expression === visited &&
        ts.isPropertyAccessExpression(visited)
      ) {
        if (parent.questionDotToken || visited.questionDotToken) {
          reportOnce(
            visited,
            "optional",
            "Optional-call forms are not lowerable in pattern context. Move this access into computed().",
          );
          return visited;
        }

        if (KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text)) {
          // Keep terminal method calls and let receiver rewriting handle parent links.
          return visited;
        }

        reportOnce(
          visited,
          "computation",
          "Method calls on opaque pattern values are not lowerable. Move this call into computed().",
        );
        return visited;
      }

      if (info.path.length > 0) {
        return createKeyCall(
          context.factory.createIdentifier(info.root),
          info.path,
          context.factory,
        );
      }
    }

    if (ts.isCallExpression(visited)) {
      if (visited.questionDotToken) {
        const info = getAccessInfo(visited.expression);
        if (info.root && opaqueRoots.has(info.root)) {
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
          const info = getAccessInfo(firstArg);
          if (info.root && opaqueRoots.has(info.root)) {
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
          const info = getAccessInfo(firstArg);
          if (info.root && opaqueRoots.has(info.root)) {
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
      const info = getAccessInfo(visited.expression);
      if (info.root && opaqueRoots.has(info.root)) {
        reportOnce(
          visited,
          "computation",
          "Spread traversal of opaque pattern values is not lowerable. Move this expression into computed().",
        );
      }
    }

    if (ts.isForInStatement(visited)) {
      const info = getAccessInfo(visited.expression);
      if (info.root && opaqueRoots.has(info.root)) {
        reportOnce(
          visited.expression,
          "computation",
          "for..in traversal of opaque pattern values is not lowerable. Move this expression into computed().",
        );
      }
    }

    return visited;
  };

  if (ts.isBlock(body)) {
    return visitEachChildWithJsx(body, visit, context.tsContext) as ts.Block;
  }

  return visit(body) as ts.Expression;
}

function transformPatternCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): ts.ArrowFunction | ts.FunctionExpression {
  const factory = context.factory;
  const firstParam = callback.parameters[0];
  const opaqueRoots = new Set<string>();
  const diagnostics: string[] = [];
  let hasUnsupportedDestructuring = false;

  let updatedParameters = callback.parameters;
  let prologue: ts.Statement[] = [];

  if (firstParam) {
    if (ts.isIdentifier(firstParam.name)) {
      opaqueRoots.add(firstParam.name.text);
    } else if (ts.isObjectBindingPattern(firstParam.name)) {
      const bindings: DestructureBinding[] = [];
      collectDestructureBindings(firstParam.name, [], bindings, diagnostics);
      if (diagnostics.length > 0) {
        for (const message of diagnostics) {
          reportComputationError(context, firstParam, message);
        }
        hasUnsupportedDestructuring = true;
      }

      const inputIdentifier = factory.createIdentifier("__ct_pattern_input");
      opaqueRoots.add(inputIdentifier.text);

      const rewrittenFirstParam = factory.updateParameterDeclaration(
        firstParam,
        firstParam.modifiers,
        firstParam.dotDotDotToken,
        inputIdentifier,
        firstParam.questionToken,
        firstParam.type,
        firstParam.initializer,
      );

      updatedParameters = factory.createNodeArray([
        rewrittenFirstParam,
        ...callback.parameters.slice(1),
      ]);

      prologue = bindings.map((binding) =>
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier(binding.localName),
                undefined,
                undefined,
                binding.path.length === 0
                  ? factory.createIdentifier(inputIdentifier.text)
                  : createKeyCall(inputIdentifier, binding.path, factory),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        )
      );
      for (const binding of bindings) {
        opaqueRoots.add(binding.localName);
      }
    } else if (ts.isArrayBindingPattern(firstParam.name)) {
      reportComputationError(
        context,
        firstParam,
        "Array destructuring in pattern parameters is not lowerable. Use an object parameter and explicit input.key(...) bindings.",
      );
      hasUnsupportedDestructuring = true;
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
    registerCapabilitySummary(callback, context);
    return callback;
  }

  let body: ts.ConciseBody = callback.body;
  const expandedOpaqueRoots = collectOpaqueRootsFromBody(
    body,
    opaqueRoots,
    context,
  );
  for (const root of expandedOpaqueRoots) {
    opaqueRoots.add(root);
  }
  body = rewritePatternBody(body, opaqueRoots, context);

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
    registerCapabilitySummary(transformed, context);
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
  registerCapabilitySummary(transformed, context);
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
    registerCapabilitySummary(arg, context);
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
    return context.ctHelpers.sourceHasHelpers() &&
      !context.options.useLegacyOpaqueRefSemantics;
  }

  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

      if (!ts.isCallExpression(visitedNode)) {
        return visitedNode;
      }

      if (isPatternBuilderCall(visitedNode, context.checker)) {
        const callbackArg = visitedNode.arguments[0];
        if (callbackArg && isFunctionLikeExpression(callbackArg)) {
          const transformedCallback = transformPatternCallback(
            callbackArg,
            context,
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
