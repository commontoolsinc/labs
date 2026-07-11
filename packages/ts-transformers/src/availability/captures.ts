import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import type { TransformationContext } from "../core/context.ts";
import { parseCaptureExpression } from "../utils/capture-tree.ts";
import {
  guardOperandExposesAvailability,
  resolveAvailabilityObservation,
} from "./analysis.ts";
import type { AvailabilityObservation, AvailabilityReason } from "./types.ts";

export interface AvailabilityVariantType {
  readonly name:
    | "IsPending"
    | "HasError"
    | "IsSyncing"
    | "HasSchemaMismatch";
  readonly type?: ts.Type;
}

export interface AvailabilityCaptureOverride {
  readonly path: readonly string[];
  /** The pre-cast expression whose ordinary data type forms the union base. */
  readonly source?: ts.Expression;
  readonly reasons: readonly AvailabilityReason[];
  readonly variants: readonly AvailabilityVariantType[];
}

const VARIANT_NAME_BY_REASON = {
  pending: "IsPending",
  error: "HasError",
  syncing: "IsSyncing",
  "schema-mismatch": "HasSchemaMismatch",
} as const satisfies Record<
  AvailabilityReason,
  AvailabilityVariantType["name"]
>;

export function availabilityPathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function predicateTypeForCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const signature = checker.getResolvedSignature(call);
  if (!signature) return undefined;
  return checker.getTypePredicateOfSignature(signature)?.type;
}

function availabilityVariantsForReasons(
  reasons: readonly AvailabilityReason[],
  context: TransformationContext,
): readonly AvailabilityVariantType[] {
  return reasons.map((reason) => {
    const name = VARIANT_NAME_BY_REASON[reason];
    const type = context.lookupAvailabilityVariantType(name);
    return { name, ...(type ? { type } : {}) };
  });
}

export function availabilityOverrideForObservation(
  path: readonly string[],
  observation: AvailabilityObservation,
  context: TransformationContext,
): AvailabilityCaptureOverride {
  return {
    path,
    source: observation.source,
    reasons: observation.reasons,
    variants: availabilityVariantsForReasons(observation.reasons, context),
  };
}

/**
 * Resolve observation provenance on closure captures. Paths remain in their
 * authored, pre-collision-renaming form so capture type construction can match
 * the capture tree exactly.
 */
export function collectObservedAvailabilityCaptures(
  captures: Iterable<ts.Expression>,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  const entries = new Map<string, AvailabilityCaptureOverride>();
  for (const captureExpression of captures) {
    const observation = resolveAvailabilityObservation(
      captureExpression,
      context,
    );
    if (!observation) continue;
    const capture = parseCaptureExpression(captureExpression);
    if (!capture) continue;
    const path = [capture.root, ...capture.path];
    entries.set(
      availabilityPathKey(path),
      availabilityOverrideForObservation(path, observation, context),
    );
  }
  return [...entries.values()];
}

function unwrapObservedInputExpression(
  expression: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.Symbol> = new Set(),
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return current;
  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return current;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration && ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ? unwrapObservedInputExpression(declaration.initializer, context, seen)
    : current;
}

function propertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/**
 * Find observed leaves inside an applied lift input. Object/array literals are
 * traversed because destructured callbacks expose those leaves as independent
 * exact policy paths.
 */
export function collectObservedAvailabilityInputPaths(
  expression: ts.Expression,
  context: TransformationContext,
  path: readonly string[] = [],
): readonly AvailabilityCaptureOverride[] {
  const observation = resolveAvailabilityObservation(expression, context);
  if (observation) {
    return [availabilityOverrideForObservation(path, observation, context)];
  }

  const target = unwrapObservedInputExpression(expression, context);
  if (ts.isObjectLiteralExpression(target)) {
    const entries: AvailabilityCaptureOverride[] = [];
    for (const property of target.properties) {
      if (ts.isPropertyAssignment(property)) {
        const segment = propertyNameText(property.name);
        if (segment !== undefined) {
          entries.push(...collectObservedAvailabilityInputPaths(
            property.initializer,
            context,
            [...path, segment],
          ));
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        entries.push(...collectObservedAvailabilityInputPaths(
          property.name,
          context,
          [...path, property.name.text],
        ));
      }
    }
    return entries;
  }

  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element, index) =>
      ts.isExpression(element)
        ? collectObservedAvailabilityInputPaths(
          element,
          context,
          [...path, String(index)],
        )
        : []
    );
  }
  return [];
}

/** Map authored capture roots to their collision-safe emitted names. */
export function renameAvailabilityCapturePaths(
  entries: readonly AvailabilityCaptureOverride[],
  renameMap: ReadonlyMap<string, string>,
): readonly AvailabilityCaptureOverride[] {
  return entries.map((entry) => {
    const [root, ...rest] = entry.path;
    if (!root) return entry;
    return {
      ...entry,
      path: [renameMap.get(root) ?? root, ...rest],
    };
  });
}

export function collectAvailabilityGuardCaptures(
  expression: ts.Expression,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  const byPath = new Map<string, {
    path: readonly string[];
    reasons: AvailabilityReason[];
    variants: AvailabilityVariantType[];
  }>();

  const visit = (node: ts.Node): void => {
    if (node !== expression && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (callKind?.kind === "availability-guard") {
        const operand = node.arguments[0];
        const capture = operand ? parseCaptureExpression(operand) : undefined;
        if (!capture) {
          context.reportDiagnosticOnce({
            type: "availability:unsupported-guard-operand",
            message:
              "Availability guards in pattern context require a direct reactive capture path.",
            node,
          });
        } else {
          const path = [capture.root, ...capture.path];
          const key = availabilityPathKey(path);
          let entry = byPath.get(key);
          if (!entry) {
            entry = { path, reasons: [], variants: [] };
            byPath.set(key, entry);
          }
          if (!entry.reasons.includes(callKind.reason)) {
            entry.reasons.push(callKind.reason);
          }
          if (
            !entry.variants.some((variant) =>
              variant.name === callKind.variantTypeName
            )
          ) {
            const predicateType = predicateTypeForCall(node, context.checker);
            if (predicateType) {
              context.recordAvailabilityVariantType(
                callKind.variantTypeName,
                predicateType,
              );
            }
            entry.variants.push({
              name: callKind.variantTypeName,
              ...(predicateType ? { type: predicateType } : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);

  return [...byPath.values()];
}

/**
 * Guard policy for an existing compute boundary. Unlike direct pattern guard
 * lowering, this never widens a plain capture: the operand must already expose
 * the requested variant (including retained async provenance for `any`). The
 * existing capture type therefore supplies the schema arm and `variants` stays
 * empty; only exact-path policy is added here.
 */
export function collectExplicitAvailabilityGuardCaptures(
  expression: ts.Expression | ts.Block,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  const byPath = new Map<string, {
    path: readonly string[];
    reasons: AvailabilityReason[];
  }>();

  const visit = (node: ts.Node): void => {
    if (node !== expression && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (callKind?.kind === "availability-guard") {
        const operand = node.arguments[0];
        const predicateType = predicateTypeForCall(node, context.checker) ??
          context.lookupAvailabilityVariantType(callKind.variantTypeName);
        if (
          operand &&
          guardOperandExposesAvailability(operand, predicateType, context)
        ) {
          if (predicateType) {
            context.recordAvailabilityVariantType(
              callKind.variantTypeName,
              predicateType,
            );
          }
          const capture = parseCaptureExpression(operand);
          if (capture) {
            const path = [capture.root, ...capture.path];
            const key = availabilityPathKey(path);
            const entry = byPath.get(key) ?? { path, reasons: [] };
            if (!entry.reasons.includes(callKind.reason)) {
              entry.reasons.push(callKind.reason);
            }
            byPath.set(key, entry);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);

  return [...byPath.values()].map((entry) => ({
    ...entry,
    variants: [],
  }));
}

/** Merge policy/type overrides which target the same exact capture path. */
export function mergeAvailabilityCaptureOverrides(
  entries: readonly AvailabilityCaptureOverride[],
): readonly AvailabilityCaptureOverride[] {
  const merged = new Map<string, AvailabilityCaptureOverride>();
  for (const entry of entries) {
    const key = availabilityPathKey(entry.path);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, entry);
      continue;
    }
    merged.set(key, {
      path: existing.path,
      source: existing.source ?? entry.source,
      reasons: [
        ...existing.reasons,
        ...entry.reasons.filter((reason) => !existing.reasons.includes(reason)),
      ],
      variants: [
        ...existing.variants,
        ...entry.variants.filter((variant) =>
          !existing.variants.some((item) => item.name === variant.name)
        ),
      ],
    });
  }
  return [...merged.values()];
}

function bindingPathForIdentifier(
  identifier: ts.Identifier,
  binding: ts.BindingName,
  path: readonly string[] = [],
): readonly string[] | undefined {
  if (ts.isIdentifier(binding)) {
    return binding.text === identifier.text ? path : undefined;
  }
  const elements = ts.isObjectBindingPattern(binding)
    ? binding.elements
    : binding.elements.filter(ts.isBindingElement);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element || !ts.isBindingElement(element)) continue;
    const segment = ts.isObjectBindingPattern(binding)
      ? propertyNameText(element.propertyName ?? element.name)
      : String(index);
    if (segment === undefined) continue;
    const nested = bindingPathForIdentifier(
      identifier,
      element.name,
      [...path, segment],
    );
    if (nested) return nested;
  }
  return undefined;
}

/** Translate guard paths rooted at a callback parameter to module-input paths. */
export function mapGuardCapturesToCallbackInput(
  entries: readonly AvailabilityCaptureOverride[],
  callback: ts.ArrowFunction | ts.FunctionExpression,
): readonly AvailabilityCaptureOverride[] {
  const parameter = callback.parameters[0];
  if (!parameter) return entries;
  return entries.flatMap((entry) => {
    const [root, ...rest] = entry.path;
    if (!root) return [entry];
    const rootIdentifier = ts.factory.createIdentifier(root);
    const bindingPath = bindingPathForIdentifier(
      rootIdentifier,
      parameter.name,
    );
    return bindingPath
      ? [{ ...entry, path: [...bindingPath, ...rest] }]
      : [entry];
  });
}

export function availabilityOverridesByPath(
  overrides: readonly AvailabilityCaptureOverride[],
): ReadonlyMap<string, AvailabilityCaptureOverride> {
  return new Map(overrides.map((override) => [
    availabilityPathKey(override.path),
    override,
  ]));
}

export function createUnavailableInputPolicyOptions(
  entries: readonly AvailabilityCaptureOverride[],
  factory: ts.NodeFactory,
  additionalProperties: readonly ts.ObjectLiteralElementLike[] = [],
): ts.ObjectLiteralExpression | undefined {
  if (entries.length === 0 && additionalProperties.length === 0) {
    return undefined;
  }

  const properties: ts.ObjectLiteralElementLike[] = [...additionalProperties];
  if (entries.length > 0) {
    properties.push(
      factory.createPropertyAssignment(
        "unavailableInputPolicy",
        factory.createArrayLiteralExpression(
          entries.map((entry) =>
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                "path",
                factory.createArrayLiteralExpression(
                  entry.path.map((segment) =>
                    factory.createStringLiteral(segment)
                  ),
                  false,
                ),
              ),
              factory.createPropertyAssignment(
                "reasons",
                factory.createArrayLiteralExpression(
                  entry.reasons.map((reason) =>
                    factory.createStringLiteral(reason)
                  ),
                  false,
                ),
              ),
            ], false)
          ),
          false,
        ),
      ),
    );
  }
  return factory.createObjectLiteralExpression(properties, false);
}
