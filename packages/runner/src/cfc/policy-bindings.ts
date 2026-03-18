import { deepEqual } from "@commontools/utils/deep-equal";

export type CfcPatternBindingValue =
  | null
  | string
  | number
  | boolean
  | readonly CfcPatternBindingValue[]
  | { readonly [key: string]: CfcPatternBindingValue };

export type CfcPatternBindings = Readonly<
  Record<string, CfcPatternBindingValue>
>;

const unresolvedBinding = Symbol("cfcPolicyBindingUnresolved");

type ResolvedBindingValue = CfcPatternBindingValue | typeof unresolvedBinding;

function isBindingPattern(
  value: unknown,
): value is { readonly var: string } {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { readonly var?: unknown }).var === "string" &&
    (value as { readonly var: string }).var.startsWith("$");
}

function isContainsPattern(
  value: unknown,
): value is { readonly contains: unknown } {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "contains" in value;
}

function isBindingValue(value: unknown): value is CfcPatternBindingValue {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isBindingValue(entry));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).every((entry) => isBindingValue(entry));
}

export function matchPatternWithBindings(
  actual: unknown,
  pattern: unknown,
  bindings: CfcPatternBindings = {},
): CfcPatternBindings | undefined {
  if (isBindingPattern(pattern)) {
    if (!isBindingValue(actual)) {
      return undefined;
    }
    const existing = bindings[pattern.var];
    if (existing !== undefined) {
      return deepEqual(existing, actual) ? bindings : undefined;
    }
    return {
      ...bindings,
      [pattern.var]: actual,
    };
  }

  if (isContainsPattern(pattern)) {
    if (!Array.isArray(actual)) {
      return undefined;
    }
    for (const entry of actual) {
      const matched = matchPatternWithBindings(
        entry,
        pattern.contains,
        bindings,
      );
      if (matched) {
        return matched;
      }
    }
    return undefined;
  }

  if (
    pattern === null || typeof pattern === "string" ||
    typeof pattern === "number" || typeof pattern === "boolean"
  ) {
    return deepEqual(actual, pattern) ? bindings : undefined;
  }

  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual) || actual.length !== pattern.length) {
      return undefined;
    }

    let nextBindings = bindings;
    for (let index = 0; index < pattern.length; index++) {
      const matched = matchPatternWithBindings(
        actual[index],
        pattern[index],
        nextBindings,
      );
      if (!matched) {
        return undefined;
      }
      nextBindings = matched;
    }
    return nextBindings;
  }

  if (!pattern || typeof pattern !== "object") {
    return undefined;
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return undefined;
  }

  let nextBindings = bindings;
  for (const [key, value] of Object.entries(pattern)) {
    const matched = matchPatternWithBindings(
      (actual as Record<string, unknown>)[key],
      value,
      nextBindings,
    );
    if (!matched) {
      return undefined;
    }
    nextBindings = matched;
  }
  return nextBindings;
}

function resolvePatternWithBindingsInner(
  pattern: unknown,
  bindings: CfcPatternBindings,
): ResolvedBindingValue {
  if (isBindingPattern(pattern)) {
    const resolved = bindings[pattern.var];
    return resolved === undefined ? unresolvedBinding : resolved;
  }

  if (
    pattern === null || typeof pattern === "string" ||
    typeof pattern === "number" || typeof pattern === "boolean"
  ) {
    return pattern;
  }

  if (Array.isArray(pattern)) {
    const resolvedEntries: CfcPatternBindingValue[] = [];
    for (const entry of pattern) {
      const resolved = resolvePatternWithBindingsInner(entry, bindings);
      if (resolved === unresolvedBinding) {
        return unresolvedBinding;
      }
      resolvedEntries.push(resolved);
    }
    return resolvedEntries;
  }

  if (!pattern || typeof pattern !== "object") {
    return unresolvedBinding;
  }

  const resolvedObject: Record<string, CfcPatternBindingValue> = {};
  for (const [key, value] of Object.entries(pattern)) {
    const resolved = resolvePatternWithBindingsInner(value, bindings);
    if (resolved === unresolvedBinding) {
      return unresolvedBinding;
    }
    resolvedObject[key] = resolved;
  }
  return resolvedObject;
}

export function resolvePatternWithBindings<T>(
  pattern: T,
  bindings: CfcPatternBindings,
): T | undefined {
  const resolved = resolvePatternWithBindingsInner(pattern, bindings);
  return resolved === unresolvedBinding ? undefined : resolved as T;
}
