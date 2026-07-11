import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { getTypeAtLocationWithFallback } from "../ast/utils.ts";
import { isCommonFabricSymbol } from "../core/common-fabric-symbols.ts";
import type { TransformationContext } from "../core/context.ts";
import {
  AVAILABILITY_REASONS,
  type AvailabilityObservation,
  type AvailabilityReason,
  isAvailabilityReason,
} from "./types.ts";

export function unwrapAvailabilityExpression(
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function valueSymbolAtIdentifier(
  identifier: ts.Identifier,
  context: TransformationContext,
): ts.Symbol | undefined {
  const parent = identifier.parent;
  if (
    parent && ts.isShorthandPropertyAssignment(parent) &&
    parent.name === identifier
  ) {
    return context.checker.getShorthandAssignmentValueSymbol(parent) ??
      context.checker.getSymbolAtLocation(identifier);
  }
  return context.checker.getSymbolAtLocation(identifier);
}

export type AvailabilityValueProvenance =
  | { readonly kind: "async-result"; readonly source: ts.Expression }
  | { readonly kind: "result-projection"; readonly source: ts.Expression };

const ASYNC_RUNTIME_EXPORTS = new Set([
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
]);

function isAdvancedStreamProducer(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    return (
      callKind?.kind === "runtime-call" &&
      callKind.exportName === "generateTextStream"
    ) || (
      callKind?.kind === "generate-object" &&
      callKind.exportName === "generateObjectStream"
    );
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return !!initializer &&
    isAdvancedStreamProducer(initializer, context, seenSymbols);
}

function constInitializer(
  identifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression | undefined {
  const symbol = valueSymbolAtIdentifier(identifier, context);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (
    !declaration || !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return undefined;
  }
  const declarationList = declaration.parent;
  return ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.Const) !== 0
    ? declaration.initializer
    : undefined;
}

/**
 * Resolve the async-result origin which TypeScript can erase for `any` and
 * `unknown`. A resultOf projection deliberately retains its source while
 * marking that the static usable view no longer exposes unavailable variants.
 */
export function resolveAvailabilityValueProvenance(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): AvailabilityValueProvenance | undefined {
  const target = unwrapAvailabilityExpression(expression);

  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    if (callKind?.kind === "availability-result") {
      const source = target.arguments[0];
      if (!source) return undefined;
      const nested = resolveAvailabilityValueProvenance(
        source,
        context,
        seenSymbols,
      );
      return {
        kind: "result-projection",
        source: nested?.source ?? source,
      };
    }
    if (callKind?.kind === "generate-text") {
      return { kind: "async-result", source: target };
    }
    if (callKind?.kind === "generate-object") {
      // generateObjectStream shares the schema-injection call kind but returns
      // a state object. Only the default generateObject call is itself an
      // AsyncResult.
      if (callKind.exportName !== "generateObjectStream") {
        return { kind: "async-result", source: target };
      }
    }
    if (
      callKind?.kind === "runtime-call" &&
      ASYNC_RUNTIME_EXPORTS.has(callKind.exportName)
    ) {
      return { kind: "async-result", source: target };
    }
  }

  if (ts.isPropertyAccessExpression(target) && target.name.text === "result") {
    if (
      isAdvancedStreamProducer(
        target.expression,
        context,
        new Set(seenSymbols),
      )
    ) {
      return { kind: "async-result", source: target };
    }
  }

  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return initializer
    ? resolveAvailabilityValueProvenance(initializer, context, seenSymbols)
    : undefined;
}

/** Return the source behind a const initialized from resultOf(), if any. */
export function resolveResultOfSource(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.Expression | undefined {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    if (
      detectCallKind(target, context.checker)?.kind === "availability-result"
    ) {
      const source = target.arguments[0];
      return source
        ? resolveResultOfSource(source, context, seenSymbols) ?? source
        : undefined;
    }
    return undefined;
  }
  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return initializer
    ? resolveResultOfSource(initializer, context, seenSymbols)
    : undefined;
}

function captureRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = unwrapAvailabilityExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapAvailabilityExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

interface StableCaptureIdentity {
  readonly root: ts.Symbol;
  readonly path: readonly string[];
}

/**
 * Resolve const aliases while retaining the physical reactive path they name.
 * Calls and dynamic element accesses deliberately stop the walk: only a stable
 * path can safely share one serialized lift input.
 */
function stableCaptureIdentity(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): StableCaptureIdentity | undefined {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isIdentifier(target)) {
    const symbol = valueSymbolAtIdentifier(target, context);
    if (!symbol) return undefined;
    if (!seenSymbols.has(symbol)) {
      seenSymbols.add(symbol);
      const initializer = constInitializer(target, context);
      const initialized = initializer
        ? stableCaptureIdentity(initializer, context, seenSymbols)
        : undefined;
      if (initialized) return initialized;
    }
    return { root: symbol, path: [] };
  }
  if (ts.isPropertyAccessExpression(target)) {
    const parent = stableCaptureIdentity(
      target.expression,
      context,
      seenSymbols,
    );
    return parent
      ? { root: parent.root, path: [...parent.path, target.name.text] }
      : undefined;
  }
  if (ts.isElementAccessExpression(target)) {
    const argument = unwrapAvailabilityExpression(target.argumentExpression);
    if (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) {
      return undefined;
    }
    const parent = stableCaptureIdentity(
      target.expression,
      context,
      seenSymbols,
    );
    return parent
      ? { root: parent.root, path: [...parent.path, argument.text] }
      : undefined;
  }
  return undefined;
}

function sameStableCapture(
  left: StableCaptureIdentity | undefined,
  right: StableCaptureIdentity | undefined,
): boolean {
  return !!left && !!right && left.root === right.root &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index]);
}

export interface CanonicalResultOfCaptures {
  readonly captures: Set<ts.Expression>;
  /** Captured alias symbol -> its one physical resultOf reactive source. */
  readonly aliases: ReadonlyMap<ts.Symbol, ts.Expression>;
}

/**
 * Collapse captured reads through `const usable = resultOf(source)` onto the
 * source itself. The whole source is captured rather than a projected child so
 * a marker stored at the source root reaches runner preflight unchanged.
 */
export function canonicalizeResultOfCaptures(
  captures: Iterable<ts.Expression>,
  context: TransformationContext,
): CanonicalResultOfCaptures {
  const authoredCaptures = [...captures];
  const canonical = new Set<ts.Expression>();
  const aliases = new Map<ts.Symbol, ts.Expression>();
  const resultSources: Array<{
    source: ts.Expression;
    identity: StableCaptureIdentity | undefined;
  }> = [];

  for (const capture of authoredCaptures) {
    const root = captureRootIdentifier(capture);
    const source = root ? resolveResultOfSource(root, context) : undefined;
    if (!source) continue;
    const identity = stableCaptureIdentity(source, context);
    if (
      !resultSources.some((entry) =>
        sameStableCapture(entry.identity, identity)
      )
    ) {
      resultSources.push({ source, identity });
    }
  }

  for (const capture of authoredCaptures) {
    const root = captureRootIdentifier(capture);
    const symbol = root ? valueSymbolAtIdentifier(root, context) : undefined;
    const resultSource = root
      ? resolveResultOfSource(root, context)
      : undefined;
    const identity = resultSource
      ? stableCaptureIdentity(resultSource, context)
      : root
      ? stableCaptureIdentity(root, context)
      : undefined;
    const shared = resultSources.find((entry) =>
      sameStableCapture(entry.identity, identity)
    );
    if (symbol && shared) {
      const sourceRoot = captureRootIdentifier(shared.source);
      const sourceSymbol = sourceRoot
        ? valueSymbolAtIdentifier(sourceRoot, context)
        : undefined;
      if (symbol !== sourceSymbol || resultSource) {
        aliases.set(symbol, shared.source);
      }
      canonical.add(shared.source);
      continue;
    }
    canonical.add(capture);
  }
  return { captures: canonical, aliases };
}

function cloneSourceExpression(
  expression: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isIdentifier(target)) {
    return factory.createIdentifier(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    return factory.createPropertyAccessExpression(
      cloneSourceExpression(target.expression, factory),
      target.name,
    );
  }
  if (ts.isElementAccessExpression(target)) {
    return factory.createElementAccessExpression(
      cloneSourceExpression(target.expression, factory),
      target.argumentExpression,
    );
  }
  // Complex direct producer calls are already captured by dataflow analysis;
  // resultOf alias canonicalization is intentionally limited to stable capture
  // paths so we never duplicate an effectful factory call inside a callback.
  return target;
}

/** Rewrite resultOf alias references in a generated callback to their source. */
export function rewriteResultOfAliasReferences<T extends ts.Node>(
  node: T,
  aliases: ReadonlyMap<ts.Symbol, ts.Expression>,
  context: TransformationContext,
  transformation: ts.TransformationContext,
): T {
  if (aliases.size === 0) return node;
  const replacementFor = (
    identifier: ts.Identifier,
  ): ts.Expression | undefined => {
    const symbol = valueSymbolAtIdentifier(identifier, context);
    const source = symbol ? aliases.get(symbol) : undefined;
    if (!source) return undefined;
    const replacement = cloneSourceExpression(source, context.factory);
    const sourceType = getTypeAtLocationWithFallback(
      source,
      context.checker,
      context.options.state?.typeRegistry,
    );
    if (sourceType) {
      context.options.state?.typeRegistry.set(replacement, sourceType);
    }
    return replacement;
  };
  const visit: ts.Visitor = (current) => {
    if (ts.isShorthandPropertyAssignment(current)) {
      const replacement = replacementFor(current.name);
      if (replacement) {
        // Preserve the authored output key: `{ result }` becomes
        // `{ result: request }`, not `{ request }`.
        return context.factory.createPropertyAssignment(
          current.name,
          replacement,
        );
      }
    }
    if (ts.isIdentifier(current)) {
      return replacementFor(current) ?? current;
    }
    return ts.visitEachChild(current, visit, transformation);
  };
  return ts.visitNode(node, visit) as T;
}

const COMMONFABRIC_AVAILABILITY_CONTAINER_NAMES = new Set([
  "AsyncResult",
  "DataUnavailable",
  "DataUnavailableVariant",
]);

function isCommonFabricAvailabilityContainer(type: ts.Type): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(
    (symbol): symbol is ts.Symbol => !!symbol,
  );
  return symbols.some((symbol) =>
    COMMONFABRIC_AVAILABILITY_CONTAINER_NAMES.has(symbol.getName()) &&
    isCommonFabricSymbol(symbol)
  );
}

export function typeContainsAvailabilityVariant(
  type: ts.Type,
  variant: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return false;
  }

  if (isCommonFabricAvailabilityContainer(type)) {
    return true;
  }

  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return !!constraint && constraint !== type &&
      typeContainsAvailabilityVariant(constraint, variant, checker, seen);
  }

  const members = type.isUnion() ? type.types : [type];
  return members.some((member) =>
    checker.isTypeAssignableTo(member, variant) &&
    checker.isTypeAssignableTo(variant, member)
  );
}

/**
 * Whether a guard may authorize its reason at an explicit compute boundary.
 * Concrete unions use semantic type membership. `any`/`unknown` require a
 * retained async-producer origin so an arbitrary plain value is not silently
 * treated as an availability channel.
 */
export function guardOperandExposesAvailability(
  operand: ts.Expression,
  variant: ts.Type | undefined,
  context: TransformationContext,
): boolean {
  const type = getTypeAtLocationWithFallback(
    operand,
    context.checker,
    context.options.state?.typeRegistry,
  );
  if (!type) return false;

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return resolveAvailabilityValueProvenance(operand, context)?.kind ===
      "async-result";
  }
  return !!variant &&
    typeContainsAvailabilityVariant(type, variant, context.checker);
}

export function parseAvailabilityObservation(
  call: ts.CallExpression,
  context: TransformationContext,
  reportInvalid = false,
): AvailabilityObservation | undefined {
  if (detectCallKind(call, context.checker)?.kind !== "availability-observer") {
    return undefined;
  }

  const source = call.arguments[0];
  if (!source) {
    if (reportInvalid) {
      context.reportDiagnosticOnce({
        type: "availability:invalid-observation",
        message: "observeAvailability() requires a value to observe.",
        node: call,
      });
    }
    return undefined;
  }

  if (call.arguments.length === 1) {
    return { source, reasons: AVAILABILITY_REASONS };
  }

  const reasons: AvailabilityReason[] = [];
  for (const argument of call.arguments.slice(1)) {
    if (
      !ts.isStringLiteralLike(argument) ||
      !isAvailabilityReason(argument.text)
    ) {
      if (reportInvalid) {
        context.reportDiagnosticOnce({
          type: "availability:invalid-observation",
          message:
            "observeAvailability() reasons must be literal pending, error, syncing, or schema-mismatch values.",
          node: argument,
        });
      }
      return undefined;
    }
    if (!reasons.includes(argument.text)) {
      reasons.push(argument.text);
    }
  }

  return { source, reasons };
}

export function resolveAvailabilityObservation(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): AvailabilityObservation | undefined {
  const target = unwrapAvailabilityExpression(expression);
  const recorded = context.lookupAvailabilityObservation(target);
  if (recorded) return recorded;

  if (ts.isCallExpression(target)) {
    return parseAvailabilityObservation(target, context);
  }

  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);

  const symbolObservation = context.lookupAvailabilityObservation(symbol);
  if (symbolObservation) return symbolObservation;

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    return resolveAvailabilityObservation(
      declaration.initializer,
      context,
      seenSymbols,
    );
  }

  return undefined;
}
