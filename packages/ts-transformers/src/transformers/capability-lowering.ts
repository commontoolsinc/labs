import ts from "typescript";
import {
  createDataFlowAnalyzer,
  detectCallKind,
  getTypeAtLocationWithFallback,
  isFunctionLikeExpression,
  normalizeDataFlows,
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
  isCommonToolsKeyExpression,
} from "../utils/reactive-keys.ts";
import {
  collectDestructureBindings,
  createKeyCall,
  type DefaultDestructureBinding,
  type DestructureBinding,
  type PathSegment,
} from "./destructuring-lowering.ts";
import { createDeriveCall } from "./builtins/derive.ts";
import { createBindingPlan } from "./opaque-ref/bindings.ts";
import {
  createComputedCallForExpression,
  filterRelevantDataFlows,
} from "./opaque-ref/helpers.ts";
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
} from "./opaque-ref/emitters/compute-wrap-invariants.ts";

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

  const mergedDefaultsByParamName = new Map<
    string,
    readonly CapabilityParamDefault[]
  >();
  const existingSummary = registry.get(callback);
  if (existingSummary) {
    for (const param of existingSummary.params) {
      if (param.defaults && param.defaults.length > 0) {
        mergedDefaultsByParamName.set(param.name, param.defaults);
      }
    }
  }
  if (defaultsByParamName) {
    for (const [paramName, defaults] of defaultsByParamName) {
      mergedDefaultsByParamName.set(paramName, defaults);
    }
  }

  if (mergedDefaultsByParamName.size === 0) {
    registry.set(callback, summary);
    return;
  }

  registry.set(callback, {
    ...summary,
    params: summary.params.map((param) => {
      const defaults = mergedDefaultsByParamName.get(param.name);
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

interface RewriteBodyOptions {
  readonly safeNativeMethodReads?: boolean;
  readonly materializeDirectMapReads?: boolean;
  readonly materializeSafePropertyReadRoots?: ReadonlySet<string>;
}

function unwrapTransparentExpression(
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callbackContainsJsx(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return found;
}

function collectTruthyGuardedRootNamesFromAncestors(
  ancestors: readonly ts.Node[],
  _activeOpaqueRoots: ReadonlySet<string>,
  context: TransformationContext,
): Set<string> {
  const roots = new Set<string>();

  const isWithinExpression = (
    startIndex: number,
    expression: ts.Expression,
  ): boolean => {
    const target = unwrapTransparentExpression(expression);
    const originalTarget = ts.getOriginalNode(target);
    for (let i = startIndex; i < ancestors.length; i++) {
      const current = ancestors[i]!;
      if (
        current === target ||
        current === originalTarget ||
        ts.getOriginalNode(current) === originalTarget
      ) {
        return true;
      }
    }
    return false;
  };

  const addFromExpression = (expression: ts.Expression): void => {
    const current = unwrapTransparentExpression(expression);

    if (ts.isIdentifier(current)) {
      roots.add(current.text);
      return;
    }

    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      addFromExpression(current.left);
      addFromExpression(current.right);
      return;
    }

    if (ts.isPrefixUnaryExpression(current)) {
      if (
        current.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPrefixUnaryExpression(current.operand) &&
        current.operand.operator === ts.SyntaxKind.ExclamationToken
      ) {
        addFromExpression(current.operand.operand);
      }
      return;
    }

    if (
      ts.isBinaryExpression(current) &&
      (
        current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
        current.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken
      )
    ) {
      const left = unwrapTransparentExpression(current.left);
      const right = unwrapTransparentExpression(current.right);
      if (
        ts.isIdentifier(left) &&
        (
          right.kind === ts.SyntaxKind.NullKeyword ||
          right.kind === ts.SyntaxKind.UndefinedKeyword
        )
      ) {
        roots.add(left.text);
      }
      if (
        ts.isIdentifier(right) &&
        (
          left.kind === ts.SyntaxKind.NullKeyword ||
          left.kind === ts.SyntaxKind.UndefinedKeyword
        )
      ) {
        roots.add(right.text);
      }
    }
  };

  let childIndex = ancestors.length - 1;
  for (
    let currentIndex = ancestors.length - 2;
    currentIndex >= 0;
    currentIndex--
  ) {
    const current = ancestors[currentIndex]!;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      break;
    }

    if (
      ts.isConditionalExpression(current) &&
      isWithinExpression(childIndex, current.whenTrue)
    ) {
      addFromExpression(current.condition);
    } else if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isWithinExpression(childIndex, current.right)
    ) {
      addFromExpression(current.left);
    } else if (ts.isCallExpression(current)) {
      const callKind = detectCallKind(current, context.checker);
      if (callKind?.kind === "ifElse") {
        const hasSchemas = current.arguments.length >= 7;
        const conditionIndex = hasSchemas ? 4 : 0;
        const whenTrueIndex = hasSchemas ? 5 : 1;
        if (
          current.arguments[whenTrueIndex] &&
          isWithinExpression(childIndex, current.arguments[whenTrueIndex]!)
        ) {
          const condition = current.arguments[conditionIndex];
          if (condition) {
            addFromExpression(condition);
          }
        }
      } else if (callKind?.kind === "when") {
        const hasSchemas = current.arguments.length >= 5;
        const conditionIndex = hasSchemas ? 3 : 0;
        const valueIndex = hasSchemas ? 4 : 1;
        if (
          current.arguments[valueIndex] &&
          isWithinExpression(childIndex, current.arguments[valueIndex]!)
        ) {
          const condition = current.arguments[conditionIndex];
          if (condition) {
            addFromExpression(condition);
          }
        }
      }
    }

    childIndex = currentIndex;
  }

  return roots;
}

function isKeyProjectionFromRoot(
  expression: ts.Expression,
  rootName: string,
): boolean {
  const current = unwrapTransparentExpression(expression);

  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every((property) =>
      ts.isPropertyAssignment(property) &&
      isKeyProjectionFromRoot(property.initializer, rootName)
    );
  }

  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "key"
  ) {
    const receiver = unwrapTransparentExpression(current.expression.expression);
    return ts.isIdentifier(receiver) && receiver.text === rootName;
  }

  return false;
}

function isHandlerCaptureParamsObjectFromAncestors(
  ancestors: readonly ts.Node[],
): boolean {
  const objectLiteral = ancestors[ancestors.length - 2];
  const call = ancestors[ancestors.length - 3];
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    return false;
  }

  if (
    !call || !ts.isCallExpression(call) || call.arguments[0] !== objectLiteral
  ) {
    return false;
  }

  if (!ts.isCallExpression(call.expression)) {
    return false;
  }

  const expression = unwrapExpression(call.expression.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text === "handler";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "handler";
  }
  return false;
}

function createMaterializedOpaqueRead(
  rootName: string,
  path: readonly PathSegment[],
  factory: ts.NodeFactory,
): ts.Expression {
  let expression: ts.Expression = factory.createCallExpression(
    factory.createPropertyAccessExpression(
      factory.createIdentifier(rootName),
      factory.createIdentifier("get"),
    ),
    undefined,
    [],
  );

  for (const segment of path) {
    if (typeof segment === "string") {
      expression = factory.createPropertyAccessExpression(
        expression,
        factory.createIdentifier(segment),
      );
    } else {
      expression = factory.createElementAccessExpression(
        expression,
        cloneKeyExpression(segment, factory),
      );
    }
  }

  return expression;
}

function materializeOpaqueAccessExpression(
  expression: ts.Expression,
  rootName: string,
  factory: ts.NodeFactory,
): ts.Expression {
  const visit = (current: ts.Expression): ts.Expression => {
    if (ts.isIdentifier(current) && current.text === rootName) {
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier(rootName),
          factory.createIdentifier("get"),
        ),
        undefined,
        [],
      );
    }

    if (ts.isParenthesizedExpression(current)) {
      return factory.createParenthesizedExpression(visit(current.expression));
    }
    if (ts.isAsExpression(current)) {
      return factory.createAsExpression(
        visit(current.expression),
        current.type,
      );
    }
    if (ts.isTypeAssertionExpression(current)) {
      return factory.createTypeAssertion(
        current.type,
        visit(current.expression),
      );
    }
    if (ts.isSatisfiesExpression(current)) {
      return factory.createSatisfiesExpression(
        visit(current.expression),
        current.type,
      );
    }
    if (ts.isNonNullExpression(current)) {
      return factory.createNonNullExpression(visit(current.expression));
    }
    if (ts.isPartiallyEmittedExpression(current)) {
      return factory.createPartiallyEmittedExpression(
        visit(current.expression),
      );
    }
    if (ts.isPropertyAccessExpression(current)) {
      return factory.createPropertyAccessExpression(
        visit(current.expression),
        current.name,
      );
    }
    if (ts.isElementAccessExpression(current)) {
      return factory.createElementAccessExpression(
        visit(current.expression),
        current.argumentExpression,
      );
    }

    return current;
  };

  return visit(expression);
}

function hasMaterializedOpaqueArrayRead(
  node: ts.Node,
  context: TransformationContext,
): boolean {
  let found = false;

  const visit = (current: ts.Node): void => {
    if (found) return;

    if (
      current !== node &&
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ) {
      return;
    }

    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "map" &&
      ts.isCallExpression(current.expression.expression) &&
      ts.isPropertyAccessExpression(current.expression.expression.expression) &&
      current.expression.expression.expression.name.text === "get"
    ) {
      found = true;
      return;
    }

    if (current !== node && ts.isCallExpression(current)) {
      const callKind = detectCallKind(current, context.checker);
      if (
        callKind?.kind === "array-method" ||
        callKind?.kind === "derive" ||
        callKind?.kind === "ifElse" ||
        callKind?.kind === "when" ||
        callKind?.kind === "unless" ||
        (callKind?.kind === "builder")
      ) {
        return;
      }
    }

    ts.forEachChild(current, visit);
  };

  visit(node);
  return found;
}

function getCaptureRootName(
  expression: ts.Expression,
): string | undefined {
  let current = unwrapTransparentExpression(expression);

  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapTransparentExpression(current.expression);
  }

  return ts.isIdentifier(current) ? current.text : undefined;
}

function stripSyntheticGetCallsFromRoots(
  body: ts.ConciseBody,
  rootNames: ReadonlySet<string>,
  context: TransformationContext,
  options: {
    readonly nullSafeArrayRoots?: boolean;
  } = {},
): ts.ConciseBody {
  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

    if (
      ts.isCallExpression(visitedNode) &&
      visitedNode.arguments.length === 0 &&
      ts.isPropertyAccessExpression(visitedNode.expression) &&
      visitedNode.expression.name.text === "get"
    ) {
      const receiver = unwrapTransparentExpression(
        visitedNode.expression.expression,
      );
      if (ts.isIdentifier(receiver) && rootNames.has(receiver.text)) {
        const replacement = options.nullSafeArrayRoots
          ? context.factory.createParenthesizedExpression(
            context.factory.createBinaryExpression(
              context.factory.createIdentifier(receiver.text),
              context.factory.createToken(ts.SyntaxKind.QuestionQuestionToken),
              context.factory.createArrayLiteralExpression(),
            ),
          )
          : context.factory.createIdentifier(receiver.text);
        registerReplacementType(replacement, visitedNode, context);
        return replacement;
      }
    }

    return visitedNode;
  };

  return visitEachChildWithJsx(
    body,
    visit,
    context.tsContext,
  ) as ts.ConciseBody;
}

function wrapMaterializedArrayReadsInJsxExpressions(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const analyze = createDataFlowAnalyzer(context.checker);

  const deriveMaterializedExpression = (
    expression: ts.Expression,
    options: {
      readonly nullSafeArrayRoots?: boolean;
    } = {},
  ): ts.Expression | undefined => {
    if (!hasMaterializedOpaqueArrayRead(expression, context)) {
      return undefined;
    }

    const pendingWrap = findPendingComputeWrapCandidate(
      expression,
      analyze,
      context,
    );
    if (!pendingWrap) {
      return undefined;
    }

    const analysis = analyze(expression);
    const relevantDataFlows = filterRelevantDataFlows(
      normalizeDataFlows(
        analysis.graph,
        analysis.dataFlows,
      ).all,
      analysis,
      context,
    );
    if (relevantDataFlows.length === 0) {
      return undefined;
    }

    const materializedRootNames = new Set(
      relevantDataFlows.flatMap((dataFlow) => {
        const rootName = getCaptureRootName(dataFlow.expression);
        return rootName ? [rootName] : [];
      }),
    );

    const derived = createDeriveCall(
      expression,
      relevantDataFlows.map((dataFlow) => dataFlow.expression),
      {
        factory: context.factory,
        tsContext: context.tsContext,
        ctHelpers: context.ctHelpers,
        context,
      },
    );
    if (!derived) {
      return undefined;
    }

    let rewrittenDerived = derived;
    if (
      materializedRootNames.size > 0 &&
      ts.isCallExpression(derived) &&
      derived.arguments.length > 0
    ) {
      const callback = derived.arguments[derived.arguments.length - 1];
      if (callback && isFunctionLikeExpression(callback)) {
        const rewrittenBody = stripSyntheticGetCallsFromRoots(
          callback.body,
          materializedRootNames,
          context,
          options,
        );
        if (rewrittenBody !== callback.body) {
          const rewrittenCallback = ts.isArrowFunction(callback)
            ? context.factory.updateArrowFunction(
              callback,
              callback.modifiers,
              callback.typeParameters,
              callback.parameters,
              callback.type,
              callback.equalsGreaterThanToken,
              rewrittenBody,
            )
            : context.factory.updateFunctionExpression(
              callback,
              callback.modifiers,
              callback.asteriskToken,
              callback.name,
              callback.typeParameters,
              callback.parameters,
              callback.type,
              rewrittenBody as ts.Block,
            );
          const args = [...derived.arguments];
          args[args.length - 1] = rewrittenCallback;
          rewrittenDerived = context.factory.updateCallExpression(
            derived,
            derived.expression,
            derived.typeArguments,
            args,
          );
        }
      }
    }

    registerReplacementType(rewrittenDerived, expression, context);
    return rewrittenDerived;
  };

  const getHelperBranchIndexes = (
    call: ts.CallExpression,
  ): readonly number[] => {
    const callKind = detectCallKind(call, context.checker);
    if (callKind?.kind === "ifElse") {
      return call.arguments.length >= 2
        ? [call.arguments.length - 2, call.arguments.length - 1]
        : [];
    }
    if (callKind?.kind === "when" || callKind?.kind === "unless") {
      return call.arguments.length >= 1 ? [call.arguments.length - 1] : [];
    }
    return [];
  };

  const wrapHelperBranches = (node: ts.Node): ts.Node => {
    if (!ts.isCallExpression(node)) {
      return visitEachChildWithJsx(
        node,
        wrapHelperBranches,
        context.tsContext,
      );
    }

    const branchIndexes = new Set(getHelperBranchIndexes(node));
    if (branchIndexes.size === 0) {
      return visitEachChildWithJsx(
        node,
        wrapHelperBranches,
        context.tsContext,
      );
    }

    let changed = false;
    const expression = visitEachChildWithJsx(
      node.expression,
      wrapHelperBranches,
      context.tsContext,
    ) as ts.LeftHandSideExpression;
    changed ||= expression !== node.expression;

    const args = node.arguments.map((argument, index) => {
      if (!branchIndexes.has(index)) {
        const visitedArgument = visitEachChildWithJsx(
          argument,
          wrapHelperBranches,
          context.tsContext,
        ) as ts.Expression;
        changed ||= visitedArgument !== argument;
        return visitedArgument;
      }

      const rewrittenBranch = deriveMaterializedExpression(argument, {
        nullSafeArrayRoots: true,
      });
      if (rewrittenBranch) {
        changed = true;
        return rewrittenBranch;
      }

      const visitedBranch = visitEachChildWithJsx(
        argument,
        wrapHelperBranches,
        context.tsContext,
      ) as ts.Expression;
      changed ||= visitedBranch !== argument;
      return visitedBranch;
    });

    if (!changed) {
      return node;
    }

    return context.factory.updateCallExpression(
      node,
      expression,
      node.typeArguments,
      args,
    );
  };

  const branchWrappedBody = visitEachChildWithJsx(
    body,
    wrapHelperBranches,
    context.tsContext,
  ) as ts.ConciseBody;

  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

    if (
      !ts.isJsxExpression(visitedNode) ||
      !visitedNode.expression ||
      visitedNode.dotDotDotToken
    ) {
      return visitedNode;
    }

    const rewrittenExpression = deriveMaterializedExpression(
      visitedNode.expression,
    );
    if (!rewrittenExpression) {
      return visitedNode;
    }

    return context.factory.updateJsxExpression(
      visitedNode,
      rewrittenExpression,
    );
  };

  return visitEachChildWithJsx(
    branchWrappedBody,
    visit,
    context.tsContext,
  ) as ts.ConciseBody;
}

function rewritePatternBody(
  body: ts.ConciseBody,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
  options: RewriteBodyOptions = {},
): ts.ConciseBody {
  if (opaqueRoots.size === 0 && opaqueRootSymbols.size === 0) {
    return body;
  }

  const activeOpaqueRoots = new Set(opaqueRoots);
  const scopeStack: Map<string, boolean>[] = [];
  const ancestorStack: ts.Node[] = [];

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
  const analyze = createDataFlowAnalyzer(context.checker);
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

  const callTargets = new WeakSet<ts.Node>();
  const safeOpaqueElementMethods = new Set(["at", "find", "findLast"]);
  const isLocallyOpaqueSourceExpression = (
    expression: ts.Expression,
  ): boolean => {
    if (!options.safeNativeMethodReads) {
      return isOpaqueSourceExpression(
        expression,
        activeOpaqueRoots,
        opaqueRootSymbols,
        context,
      );
    }

    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      const symbol = context.checker.getSymbolAtLocation(current);
      return activeOpaqueRoots.has(current.text) ||
        (symbol ? opaqueRootSymbols.has(symbol) : false);
    }

    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      const info = getOpaqueAccessInfo(current, context);
      return !!info.root &&
        isOpaqueRootInfo(
          info,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        );
    }

    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      (
        current.expression.name.text === "key" ||
        safeOpaqueElementMethods.has(current.expression.name.text)
      )
    ) {
      return isLocallyOpaqueSourceExpression(current.expression.expression) ||
        isOpaqueSourceExpression(
          current.expression.expression,
          activeOpaqueRoots,
          opaqueRootSymbols,
          context,
        );
    }

    return false;
  };

  const findDynamicOpaqueAccess = (
    expression: ts.Expression,
  ): ts.Expression | undefined => {
    let culprit: ts.Expression | undefined;

    const visit = (node: ts.Node): void => {
      if (culprit) return;
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isTopmostMemberAccess(node)
      ) {
        const info = getOpaqueAccessInfo(node, context);
        if (
          info.dynamic &&
          isOpaqueRootInfo(
            info,
            activeOpaqueRoots,
            opaqueRootSymbols,
            context,
          )
        ) {
          culprit = node;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(expression);
    return culprit;
  };

  const maybeWrapDynamicInitializer = (
    initializer: ts.Expression,
  ): ts.Expression | undefined => {
    if (!ts.isBinaryExpression(initializer)) {
      return undefined;
    }

    if (!findDynamicOpaqueAccess(initializer)) {
      return undefined;
    }

    const analysis = analyze(initializer);
    const relevantDataFlows = filterRelevantDataFlows(
      normalizeDataFlows(analysis.graph, analysis.dataFlows).all,
      analysis,
      context,
    );
    if (relevantDataFlows.length === 0) {
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

    const plan = createBindingPlan(relevantDataFlows);
    return createComputedCallForExpression(initializer, plan, context);
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
        !isLocallyOpaqueSourceExpression(
          declaration.initializer,
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
        rootIdentifier = context.factory.createUniqueName("__ct_destructure");
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
    ancestorStack.push(node);
    try {
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

      // Record call targets BEFORE visiting children so nested visits can
      // determine whether a PropertyAccessExpression is a method-call callee
      // without relying on parent pointers (which are absent on synthetic nodes).
      if (ts.isCallExpression(node)) {
        callTargets.add(node.expression);
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
          const rewrittenDeclaration = context.factory
            .updateVariableDeclaration(
              node,
              node.name,
              node.exclamationToken,
              node.type,
              rewrittenInitializer,
            );
          const initializerIsOpaque = isLocallyOpaqueSourceExpression(
            rewrittenInitializer,
          );
          setBindingOpaqueState(rewrittenDeclaration.name, initializerIsOpaque);
          if (initializerIsOpaque) {
            addBindingTargetSymbols(
              rewrittenDeclaration.name,
              opaqueRootSymbols,
              context.checker,
            );
          }
          return rewrittenDeclaration;
        }
      }

      const visited = visitEachChildWithJsx(node, visit, context.tsContext);

      if (ts.isVariableDeclaration(visited)) {
        const initializerIsOpaque = !!visited.initializer &&
          isLocallyOpaqueSourceExpression(visited.initializer);
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
        ts.isPropertyAssignment(visited) &&
        ts.isIdentifier(visited.name) &&
        ts.isObjectLiteralExpression(visited.initializer) &&
        isHandlerCaptureParamsObjectFromAncestors(ancestorStack)
      ) {
        const rootName = visited.name.text;
        if (
          collectTruthyGuardedRootNamesFromAncestors(
            ancestorStack,
            activeOpaqueRoots,
            context,
          ).has(rootName) &&
          isKeyProjectionFromRoot(visited.initializer, rootName)
        ) {
          const rootCapture = context.factory.createIdentifier(rootName);
          registerReplacementType(rootCapture, visited.initializer, context);
          return context.factory.updatePropertyAssignment(
            visited,
            visited.name,
            rootCapture,
          );
        }
      }

      const isMemberAccess = ts.isPropertyAccessExpression(visited) ||
        ts.isElementAccessExpression(visited);
      const isCallTargetMemberAccess = isMemberAccess && callTargets.has(node);
      if (
        isMemberAccess &&
        (isTopmostMemberAccess(visited) ||
          (options.safeNativeMethodReads && isCallTargetMemberAccess))
      ) {
        const info = getOpaqueAccessInfo(visited, context);
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

        if (info.dynamic) {
          if (
            options.safeNativeMethodReads &&
            options.materializeSafePropertyReadRoots?.has(info.root)
          ) {
            const materializedRead = materializeOpaqueAccessExpression(
              visited,
              info.root,
              context.factory,
            );
            registerReplacementType(materializedRead, visited, context);
            return materializedRead;
          }

          reportOnce(
            visited,
            "computation",
            "Dynamic key access is not lowerable in pattern context. Use a compute wrapper for dynamic traversal.",
          );
          return visited;
        }

        if (ts.isPropertyAccessExpression(visited)) {
          const isCallTarget = callTargets.has(node);
          const treatDirectMapAsNativeRead = options.safeNativeMethodReads &&
            isCallTarget &&
            visited.name.text === "map" &&
            info.path.length === 1;
          const parentCall = visited.parent;

          if (
            options.materializeDirectMapReads &&
            isCallTarget &&
            visited.name.text === "map" &&
            info.path.length === 1 &&
            parentCall &&
            ts.isCallExpression(parentCall) &&
            parentCall.arguments[0] &&
            isFunctionLikeExpression(parentCall.arguments[0]) &&
            !callbackContainsJsx(parentCall.arguments[0])
          ) {
            const receiver = context.factory.createIdentifier(info.root);
            const materializedReceiver = context.factory.createCallExpression(
              context.factory.createPropertyAccessExpression(
                receiver,
                context.factory.createIdentifier("get"),
              ),
              undefined,
              [],
            );
            const rewrittenMethod = context.factory
              .createPropertyAccessExpression(
                materializedReceiver,
                visited.name.text,
              );
            registerReplacementType(rewrittenMethod, visited, context);
            return rewrittenMethod;
          }

          if (
            KNOWN_PATH_TERMINAL_METHODS.has(visited.name.text) &&
            isCallTarget &&
            !treatDirectMapAsNativeRead
          ) {
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

            if (options.safeNativeMethodReads) {
              const receiverPath = info.path.slice(0, -1);
              const receiver = receiverPath.length > 0
                ? createKeyCall(
                  context.factory.createIdentifier(info.root),
                  receiverPath,
                  context.factory,
                )
                : context.factory.createIdentifier(info.root);
              const materializedReceiver = context.factory.createCallExpression(
                context.factory.createPropertyAccessExpression(
                  receiver,
                  context.factory.createIdentifier("get"),
                ),
                undefined,
                [],
              );
              const rewrittenMethod = context.factory
                .createPropertyAccessExpression(
                  materializedReceiver,
                  visited.name.text,
                );
              registerReplacementType(rewrittenMethod, visited, context);
              return rewrittenMethod;
            }

            reportOnce(
              visited,
              "computation",
              "Method calls on opaque pattern values are not lowerable. Move this call into computed().",
            );
            return visited;
          }
        }

        if (
          options.safeNativeMethodReads &&
          options.materializeSafePropertyReadRoots?.has(info.root)
        ) {
          const materializedRead = createMaterializedOpaqueRead(
            info.root,
            info.path,
            context.factory,
          );
          registerReplacementType(materializedRead, visited, context);
          return materializedRead;
        }

        if (options.safeNativeMethodReads) {
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
          const info = getOpaqueAccessInfo(visited.expression, context);
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
            const info = getOpaqueAccessInfo(firstArg, context);
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
            const info = getOpaqueAccessInfo(firstArg, context);
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
        const info = getOpaqueAccessInfo(visited.expression, context);
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
        const info = getOpaqueAccessInfo(visited.expression, context);
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
    } finally {
      ancestorStack.pop();
    }
  };

  enterScope();
  if (ts.isBlock(body)) {
    let rewrittenBody = visitEachChildWithJsx(
      body,
      visit,
      context.tsContext,
    ) as ts.Block;
    if (options.materializeDirectMapReads) {
      rewrittenBody = wrapMaterializedArrayReadsInJsxExpressions(
        rewrittenBody,
        context,
      ) as ts.Block;
    }
    exitScope();
    return rewrittenBody;
  }

  let rewrittenExpr = visit(body) as ts.Expression;
  if (options.materializeDirectMapReads) {
    rewrittenExpr = wrapMaterializedArrayReadsInJsxExpressions(
      rewrittenExpr,
      context,
    ) as ts.Expression;
  }
  exitScope();
  return rewrittenExpr;
}

/**
 * Recursively process derive() callback bodies to rewrite property accesses
 * on locally-declared OpaqueRef variables (e.g., const foo = computed(...); foo.bar → foo.key("bar")).
 *
 * rewritePatternBody stops at function boundaries, so derive callback bodies
 * are not processed by it. This function finds derive() calls in the given body,
 * extracts their callbacks, and applies rewritePatternBody to each callback body
 * with empty opaque roots (since derive callbacks receive unwrapped captures).
 * Local variables initialized from derive/computed/lift calls within the callback
 * will be detected as opaque roots by rewritePatternBody's variable tracking.
 */
function rewriteDeriveCallbackBodies(
  body: ts.ConciseBody,
  context: TransformationContext,
): ts.ConciseBody {
  const visit = (node: ts.Node): ts.Node => {
    // First recurse into children
    const visited = visitEachChildWithJsx(node, visit, context.tsContext);

    if (!ts.isCallExpression(visited)) return visited;

    const callKind = detectCallKind(visited, context.checker);
    if (callKind?.kind !== "derive") return visited;

    const callbackArg = visited.arguments.length === 2
      ? visited.arguments[1]
      : visited.arguments.length === 4
      ? visited.arguments[3]
      : undefined;

    if (!callbackArg || !isFunctionLikeExpression(callbackArg)) return visited;

    // Recursively process nested derive callbacks first
    let processedBody = rewriteDeriveCallbackBodies(
      callbackArg.body,
      context,
    );

    // Pre-scan the callback body for local variable declarations that produce
    // OpaqueRef values (e.g., const foo = derive(...)). We collect only SYMBOLS
    // (not names) to avoid false rewrites when a block-scoped opaque variable
    // shares a name with an unrelated outer-scope variable. Names are discovered
    // by rewritePatternBody's own setBindingOpaqueState as it walks declarations.
    // We walk the full AST (stopping at nested function boundaries) so
    // declarations inside if/else/loops are also discovered.
    const localOpaqueRootSymbols = collectLocalOpaqueRootSymbols(
      processedBody,
      context,
    );

    // Rewrite property accesses on local OpaqueRef variables.
    // Pass empty name set — rewritePatternBody will populate activeOpaqueRoots
    // via setBindingOpaqueState as it encounters declarations, respecting
    // block scoping. The symbol set bypasses the early return guard.
    processedBody = rewritePatternBody(
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
    args[args.length === 2 ? 1 : 3] = newCallback;
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

function getBuilderCallbackArgument(
  call: ts.CallExpression,
  context: TransformationContext,
):
  | {
    index: number;
    callback: ts.ArrowFunction | ts.FunctionExpression;
    callKind: Exclude<ReturnType<typeof detectCallKind>, undefined>;
  }
  | undefined {
  const callKind = detectCallKind(call, context.checker);
  if (!callKind) {
    const callee = unwrapExpression(call.expression);
    const isHandlerLike = ts.isIdentifier(callee)
      ? callee.text === "handler"
      : ts.isPropertyAccessExpression(callee)
      ? callee.name.text === "handler"
      : false;
    if (isHandlerLike) {
      for (let index = call.arguments.length - 1; index >= 0; index--) {
        const candidate = call.arguments[index];
        if (candidate && isFunctionLikeExpression(candidate)) {
          return {
            index,
            callback: candidate,
            callKind: {
              kind: "builder",
              builderName: "handler",
            },
          };
        }
      }
    }
    return undefined;
  }

  if (callKind.kind === "derive") {
    const candidate = call.arguments.length === 2
      ? call.arguments[1]
      : call.arguments.length === 4
      ? call.arguments[3]
      : undefined;
    if (candidate && isFunctionLikeExpression(candidate)) {
      return {
        index: call.arguments.indexOf(candidate),
        callback: candidate,
        callKind,
      };
    }
    return undefined;
  }

  if (callKind.kind !== "builder") return undefined;

  if (
    callKind.builderName === "pattern" ||
    callKind.builderName === "computed" ||
    callKind.builderName === "lift" ||
    callKind.builderName === "action"
  ) {
    const candidate = call.arguments[0];
    if (candidate && isFunctionLikeExpression(candidate)) {
      return { index: 0, callback: candidate, callKind };
    }
    return undefined;
  }

  if (callKind.builderName === "handler") {
    for (let index = call.arguments.length - 1; index >= 0; index--) {
      const candidate = call.arguments[index];
      if (candidate && isFunctionLikeExpression(candidate)) {
        return { index, callback: candidate, callKind };
      }
    }
  }

  return undefined;
}

function getBindingElementPropertyName(
  element: ts.BindingElement,
): string | undefined {
  if (element.propertyName) {
    if (
      ts.isIdentifier(element.propertyName) ||
      ts.isStringLiteral(element.propertyName) ||
      ts.isNumericLiteral(element.propertyName) ||
      ts.isNoSubstitutionTemplateLiteral(element.propertyName)
    ) {
      return element.propertyName.text;
    }
    return undefined;
  }

  if (ts.isIdentifier(element.name)) {
    return element.name.text;
  }

  return undefined;
}

function addReactiveBindingTargets(
  name: ts.BindingName,
  opaqueRoots: Set<string>,
  opaqueRootSymbols: Set<ts.Symbol>,
  context: TransformationContext,
): void {
  if (ts.isIdentifier(name)) {
    opaqueRoots.add(name.text);
    const symbol = context.checker.getSymbolAtLocation(name);
    if (symbol) {
      opaqueRootSymbols.add(symbol);
    }
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addReactiveBindingTargets(
      element.name,
      opaqueRoots,
      opaqueRootSymbols,
      context,
    );
  }
}

function referencesOpaqueRoot(
  node: ts.Node,
  opaqueNames: ReadonlySet<string>,
): boolean {
  let found = false;

  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(current) && opaqueNames.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  return found;
}

function collectReactiveClosureHandlerRoots(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  reactiveCaptures: ReadonlySet<string> | undefined,
  context: TransformationContext,
): { opaqueRoots: Set<string>; opaqueRootSymbols: Set<ts.Symbol> } {
  const opaqueRoots = new Set<string>();
  const opaqueRootSymbols = new Set<ts.Symbol>();
  const paramsParam = callback.parameters[1];
  if (
    !paramsParam ||
    !ts.isObjectBindingPattern(paramsParam.name) ||
    !reactiveCaptures ||
    reactiveCaptures.size === 0
  ) {
    return { opaqueRoots, opaqueRootSymbols };
  }

  for (const element of paramsParam.name.elements) {
    const propertyName = getBindingElementPropertyName(element);
    if (!propertyName || !reactiveCaptures.has(propertyName)) {
      continue;
    }
    addReactiveBindingTargets(
      element.name,
      opaqueRoots,
      opaqueRootSymbols,
      context,
    );
  }

  return { opaqueRoots, opaqueRootSymbols };
}

function transformClosureHandlerCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  reactiveCaptures: ReadonlySet<string> | undefined,
  materializeSafePropertyReadRoots: ReadonlySet<string> | undefined,
  context: TransformationContext,
): ts.ArrowFunction | ts.FunctionExpression {
  const { opaqueRoots, opaqueRootSymbols } = collectReactiveClosureHandlerRoots(
    callback,
    reactiveCaptures,
    context,
  );
  if (opaqueRoots.size === 0 && opaqueRootSymbols.size === 0) {
    registerCapabilitySummary(callback, context, false);
    return callback;
  }

  let body: ts.ConciseBody = callback.body;
  body = rewritePatternBody(
    body,
    opaqueRoots,
    opaqueRootSymbols,
    context,
    {
      safeNativeMethodReads: true,
      materializeSafePropertyReadRoots,
    },
  );
  body = rewriteDeriveCallbackBodies(body, context);

  if (body === callback.body) {
    registerCapabilitySummary(callback, context, false);
    return callback;
  }

  const transformed = ts.isArrowFunction(callback)
    ? context.factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    )
    : context.factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      body as ts.Block,
    );
  registerCapabilitySummary(transformed, context, false);
  return transformed;
}

function collectDirectReactiveHandlerRootCaptures(
  handlerCall: ts.CallExpression,
  reactiveCaptures: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (!reactiveCaptures || reactiveCaptures.size === 0) {
    return undefined;
  }

  const paramsArg = handlerCall.arguments[0];
  if (!paramsArg || !ts.isObjectLiteralExpression(paramsArg)) {
    return undefined;
  }

  const directCaptures = new Set<string>();
  for (const property of paramsArg.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (reactiveCaptures.has(property.name.text)) {
        directCaptures.add(property.name.text);
      }
      continue;
    }

    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      ts.isIdentifier(property.initializer) &&
      reactiveCaptures.has(property.name.text)
    ) {
      directCaptures.add(property.name.text);
    }
  }

  return directCaptures.size > 0 ? directCaptures : undefined;
}

function rewriteNestedHandlerCallbacksInPatternBody(
  body: ts.ConciseBody,
  reactiveCapturesByHandlerCall: ReadonlyMap<ts.Node, ReadonlySet<string>>,
  context: TransformationContext,
): ts.ConciseBody {
  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

    if (
      !ts.isCallExpression(visitedNode) ||
      !ts.isCallExpression(visitedNode.expression)
    ) {
      return visitedNode;
    }

    const paramsArg = visitedNode.arguments[0];
    if (!paramsArg || !ts.isObjectLiteralExpression(paramsArg)) {
      return visitedNode;
    }

    const callbackInfo = getBuilderCallbackArgument(
      visitedNode.expression,
      context,
    );
    if (
      callbackInfo?.callKind.kind !== "builder" ||
      callbackInfo.callKind.builderName !== "handler"
    ) {
      return visitedNode;
    }

    const reactiveCaptures = reactiveCapturesByHandlerCall.get(visitedNode) ??
      reactiveCapturesByHandlerCall.get(ts.getOriginalNode(visitedNode));
    const transformedCallback = transformClosureHandlerCallback(
      callbackInfo.callback,
      reactiveCaptures,
      collectDirectReactiveHandlerRootCaptures(visitedNode, reactiveCaptures),
      context,
    );
    if (transformedCallback === callbackInfo.callback) {
      return visitedNode;
    }

    const handlerArgs = [...visitedNode.expression.arguments];
    handlerArgs[callbackInfo.index] = transformedCallback;
    const rewrittenFactory = context.factory.updateCallExpression(
      visitedNode.expression,
      visitedNode.expression.expression,
      visitedNode.expression.typeArguments,
      handlerArgs,
    );
    return context.factory.updateCallExpression(
      visitedNode,
      rewrittenFactory,
      visitedNode.typeArguments,
      visitedNode.arguments,
    );
  };

  return visitEachChildWithJsx(
    body,
    visit,
    context.tsContext,
  ) as ts.ConciseBody;
}

function transformPatternCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  isArrayMethodCallback = false,
  nonReactiveCaptures?: ReadonlySet<string>,
  reactiveCapturesByHandlerCall?: ReadonlyMap<ts.Node, ReadonlySet<string>>,
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
  body = rewritePatternBody(
    body,
    opaqueRoots,
    opaqueRootSymbols,
    context,
    { materializeDirectMapReads: isArrayMethodCallback },
  );
  body = rewriteDeriveCallbackBodies(body, context);
  if (reactiveCapturesByHandlerCall) {
    body = rewriteNestedHandlerCallbacksInPatternBody(
      body,
      reactiveCapturesByHandlerCall,
      context,
    );
  }

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
  const callbackInfo = getBuilderCallbackArgument(node, context);
  if (!callbackInfo) return;

  if (callbackInfo.callKind.kind === "derive") {
    registerCapabilitySummary(callbackInfo.callback, context, true);
    return;
  }

  if (callbackInfo.callKind.kind === "builder") {
    registerCapabilitySummary(callbackInfo.callback, context, true);
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
    const reactiveCapturesByHandlerCall = new Map<ts.Node, Set<string>>();

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

        if (
          ts.isCallExpression(node) &&
          ts.isCallExpression(node.expression) &&
          node.arguments[0] &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const callbackInfo = getBuilderCallbackArgument(
            node.expression,
            context,
          );
          const scope = scopeStack.at(-1);
          if (
            scope &&
            callbackInfo?.callKind.kind === "builder" &&
            callbackInfo.callKind.builderName === "handler"
          ) {
            const reactiveCaptures = new Set<string>();
            for (const property of node.arguments[0].properties) {
              let captureName: string | undefined;
              if (ts.isShorthandPropertyAssignment(property)) {
                captureName = property.name.text;
                if (scope.opaqueNames.has(property.name.text)) {
                  reactiveCaptures.add(property.name.text);
                }
              } else if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
              ) {
                captureName = property.name.text;
                if (
                  referencesOpaqueRoot(
                    property.initializer,
                    scope.opaqueNames,
                  )
                ) {
                  reactiveCaptures.add(captureName);
                }
              }
            }

            if (reactiveCaptures.size > 0) {
              reactiveCapturesByHandlerCall.set(node, reactiveCaptures);
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
            reactiveCapturesByHandlerCall,
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

      const handlerFactory = ts.isCallExpression(visitedNode.expression)
        ? visitedNode.expression
        : undefined;
      const callbackInfo = handlerFactory
        ? getBuilderCallbackArgument(handlerFactory, context)
        : undefined;
      const handlerCall = handlerFactory;
      if (
        handlerCall &&
        callbackInfo?.callKind.kind === "builder" &&
        callbackInfo.callKind.builderName === "handler"
      ) {
        const reactiveCaptures = reactiveCapturesByHandlerCall.get(node);
        const transformedCallback = transformClosureHandlerCallback(
          callbackInfo.callback,
          reactiveCaptures,
          collectDirectReactiveHandlerRootCaptures(
            visitedNode,
            reactiveCaptures,
          ),
          context,
        );
        if (transformedCallback !== callbackInfo.callback) {
          const handlerArgs = [...handlerCall.arguments];
          handlerArgs[callbackInfo.index] = transformedCallback;
          const rewrittenFactory = context.factory.updateCallExpression(
            handlerCall,
            handlerCall.expression,
            handlerCall.typeArguments,
            handlerArgs,
          );
          const rewritten = context.factory.updateCallExpression(
            visitedNode,
            rewrittenFactory,
            visitedNode.typeArguments,
            visitedNode.arguments,
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
