import ts from "typescript";
import {
  detectFactoryType,
  type FactoryTypeInfo,
} from "@commonfabric/schema-generator";

import { detectCallKind } from "./call-kind.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import { unwrapExpression } from "../utils/expression.ts";

export type FactoryValueOrigin =
  | "live"
  | "symbolic"
  | "runtime-materialized"
  | "unknown";

export type FactoryCallExposure = "symbolic" | "runtime-materialized";

type ScheduledCallback =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

const referencedScheduledCallbackCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ScheduledCallback, boolean>
>();

export interface FactoryCalleeClassification {
  readonly members: readonly FactoryTypeInfo[];
  readonly hasNonFactoryMember: boolean;
  readonly origin: FactoryValueOrigin;
}

/**
 * Classify a callable factory independently along its two relevant axes:
 * public factory contract and execution origin. A factory type does not by
 * itself say whether calling the value is safe: eager pattern roots carry a
 * symbolic Cell/link binding, while scheduled callbacks receive a
 * runner-materialized callable.
 */
export function classifyFactoryCallee(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): FactoryCalleeClassification | undefined {
  const target = unwrapExpression(expression);
  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(target);
  } catch {
    return undefined;
  }

  const memberTypes = type.isUnion() ? type.types : [type];
  const members: FactoryTypeInfo[] = [];
  let hasNonFactoryMember = false;
  for (const memberType of memberTypes) {
    if (
      (memberType.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) !== 0
    ) {
      continue;
    }
    const member = detectFactoryType(memberType, checker);
    if (member) {
      members.push(member);
    } else {
      hasNonFactoryMember = true;
    }
  }
  if (members.length === 0) return undefined;

  return {
    members,
    hasNonFactoryMember,
    origin: classifyFactoryValueOrigin(target, checker, new Set()),
  };
}

/**
 * A lexical capture from an eager root becomes an explicit scheduled input
 * when ClosureTransformer lowers a lift/computed/handler/action callback. The
 * runner materializes that input before authored code runs, so the call stays
 * direct even though its pre-lowering lexical origin was symbolic.
 */
export function isInsideFactoryMaterializationBoundary(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  return classifyFactoryCallExposure(node, checker) === "runtime-materialized";
}

/** Return the nearest execution boundary that decides factory exposure. */
export function classifyFactoryCallExposure(
  node: ts.Node,
  checker: ts.TypeChecker,
): FactoryCallExposure | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      if (isReferencedScheduledCallback(current, checker)) {
        return "runtime-materialized";
      }
      if (ts.isFunctionDeclaration(current)) {
        current = current.parent;
        continue;
      }
      const semantics = getCallbackBoundarySemantics(current, checker);
      if (semantics.decision.kind === "supported") {
        switch (semantics.decision.boundaryKind) {
          case "lift-builder":
          case "lift-applied":
          case "computed-builder":
          case "handler-builder":
          case "action-builder":
          case "event-handler":
            return "runtime-materialized";
          case "pattern-builder":
          case "render-builder":
            return "symbolic";
          case "reactive-array-method":
            // Array callbacks do not decide how a captured factory is
            // delivered. Keep walking: an enclosing computed/lift/handler
            // materializes it before this callback runs, while an enclosing
            // eager pattern root leaves it symbolic.
            break;
          default:
            break;
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

function classifyFactoryValueOrigin(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): FactoryValueOrigin {
  const target = unwrapExpression(expression);

  if (ts.isPropertyAccessExpression(target)) {
    return classifyFactoryValueOrigin(target.expression, checker, seenSymbols);
  }
  if (ts.isElementAccessExpression(target)) {
    return classifyFactoryValueOrigin(target.expression, checker, seenSymbols);
  }
  if (ts.isConditionalExpression(target)) {
    return combineOrigins(
      classifyFactoryValueOrigin(
        target.whenTrue,
        checker,
        new Set(seenSymbols),
      ),
      classifyFactoryValueOrigin(
        target.whenFalse,
        checker,
        new Set(seenSymbols),
      ),
    );
  }
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, checker);
    if (callKind?.kind === "builder") return "live";

    const callee = unwrapExpression(target.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "asScope" || callee.name.text === "inSpace")
    ) {
      return classifyFactoryValueOrigin(
        callee.expression,
        checker,
        seenSymbols,
      );
    }
    return "unknown";
  }
  if (!ts.isIdentifier(target)) return "unknown";

  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(target) ?? undefined;
  } catch {
    return "unknown";
  }
  if (!symbol) return "unknown";

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return "live";
  }
  if (seenSymbols.has(symbol)) return "unknown";
  seenSymbols.add(symbol);

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return "unknown";

  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return "live";
  }

  const parameter = findOwningParameter(declaration);
  if (parameter) return classifyParameterOrigin(parameter, checker);

  if (ts.isVariableDeclaration(declaration)) {
    if (isModuleScopedDeclaration(declaration)) return "live";
    if (crossesSymbolicCallbackBoundary(target, declaration, checker)) {
      return "symbolic";
    }
    if (isConstVariableDeclaration(declaration) && declaration.initializer) {
      return classifyFactoryValueOrigin(
        declaration.initializer,
        checker,
        seenSymbols,
      );
    }
    return "unknown";
  }

  if (ts.isBindingElement(declaration)) {
    const variable = findOwningVariableDeclaration(declaration);
    if (!variable?.initializer) return "unknown";
    if (isModuleScopedDeclaration(variable)) return "live";
    if (!isConstVariableDeclaration(variable)) return "unknown";
    return classifyFactoryValueOrigin(
      variable.initializer,
      checker,
      seenSymbols,
    );
  }

  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  ) {
    return "live";
  }

  return "unknown";
}

/**
 * Closure conversion moves a local binding captured by a deeper eager pattern
 * callback into that callback's private argument-1 record. Even when the
 * binding was initialized by a live builder call, its use inside the deeper
 * callback is therefore a symbolic factory input until the runner
 * materializes that pattern generation.
 */
function crossesSymbolicCallbackBoundary(
  useSite: ts.Node,
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = useSite.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const semantics = getCallbackBoundarySemantics(current, checker);
      if (
        semantics.decision.kind === "supported" &&
        (semantics.decision.boundaryKind === "pattern-builder" ||
          semantics.decision.boundaryKind === "render-builder")
      ) {
        return !isDescendantOf(declaration, current);
      }
    }
    current = current.parent;
  }
  return false;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function classifyParameterOrigin(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): FactoryValueOrigin {
  const owner = parameter.parent;
  if (
    !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner) &&
    !ts.isFunctionDeclaration(owner)
  ) {
    return "unknown";
  }
  if (isReferencedScheduledCallback(owner, checker)) {
    return "runtime-materialized";
  }
  if (ts.isFunctionDeclaration(owner)) return "unknown";
  const semantics = getCallbackBoundarySemantics(owner, checker);
  if (semantics.decision.kind !== "supported") return "unknown";

  switch (semantics.decision.boundaryKind) {
    case "pattern-builder":
    case "render-builder":
      return owner.parameters.indexOf(parameter) <= 1 ? "symbolic" : "unknown";
    case "lift-builder":
    case "lift-applied":
    case "computed-builder":
    case "handler-builder":
    case "action-builder":
    case "event-handler":
      return "runtime-materialized";
    default:
      return "unknown";
  }
}

/**
 * Referenced callbacks are not syntactically nested in their owning builder
 * call, so the ordinary ancestor-based callback-boundary policy cannot see
 * them. Resolve stable local callback references at their scheduled builder
 * use site and give their parameters the same runner-materialized exposure as
 * an equivalent inline callback.
 */
function isReferencedScheduledCallback(
  callback: ScheduledCallback,
  checker: ts.TypeChecker,
): boolean {
  let checkerCache = referencedScheduledCallbackCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    referencedScheduledCallbackCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(callback);
  if (cached !== undefined) return cached;

  let scheduled = false;
  let symbolic = false;
  const visit = (node: ts.Node): void => {
    if (scheduled && symbolic) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, checker);
      if (
        callKind?.kind === "builder" &&
        (callKind.builderName === "lift" ||
          callKind.builderName === "handler" ||
          callKind.builderName === "computed" ||
          callKind.builderName === "action" ||
          callKind.builderName === "pattern" ||
          callKind.builderName === "render")
      ) {
        const ownsCallback = node.arguments.some((argument) =>
          resolveCallbackReference(argument, checker, new Set()) === callback
        );
        if (ownsCallback) {
          if (
            callKind.builderName === "pattern" ||
            callKind.builderName === "render"
          ) {
            symbolic = true;
          } else {
            scheduled = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.getSourceFile());
  const materializedOnly = scheduled && !symbolic;
  checkerCache.set(callback, materializedOnly);
  return materializedOnly;
}

function resolveCallbackReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ScheduledCallback | undefined {
  const target = unwrapExpression(expression);
  if (seen.has(target)) return undefined;
  seen.add(target);

  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return target;
  }
  if (
    ts.isCallExpression(target) && target.arguments.length === 1 &&
    ts.isIdentifier(unwrapExpression(target.expression)) &&
    (unwrapExpression(target.expression) as ts.Identifier).text.startsWith(
      "__cfHardenFn",
    )
  ) {
    return resolveCallbackReference(target.arguments[0]!, checker, seen);
  }
  if (!ts.isIdentifier(target)) return undefined;

  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }
  if (
    declaration && ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    return resolveCallbackReference(declaration.initializer, checker, seen);
  }
  return undefined;
}

function findOwningParameter(
  declaration: ts.Declaration,
): ts.ParameterDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isFunctionLike(current)) {
    if (ts.isParameter(current)) return current;
    if (
      !ts.isBindingElement(current) &&
      !ts.isObjectBindingPattern(current) &&
      !ts.isArrayBindingPattern(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function findOwningVariableDeclaration(
  declaration: ts.BindingElement,
): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (ts.isVariableDeclaration(current)) return current;
    if (
      !ts.isBindingElement(current) &&
      !ts.isObjectBindingPattern(current) &&
      !ts.isArrayBindingPattern(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isModuleScopedDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  const statement = declaration.parent.parent;
  return !!statement && statement.parent?.kind === ts.SyntaxKind.SourceFile;
}

function combineOrigins(
  left: FactoryValueOrigin,
  right: FactoryValueOrigin,
): FactoryValueOrigin {
  return left === right ? left : "unknown";
}
