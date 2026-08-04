import type { Pattern } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";

export type ListOpArgumentUsage = {
  usesElement: boolean;
  usesIndex: boolean;
  usesArray: boolean;
  usesParams: boolean;
};

const usageCache = new WeakMap<object, ListOpArgumentUsage>();

function hasArgumentSchema(
  pattern: Pattern,
  path: readonly string[],
): boolean {
  return ContextualFlowControl.getSchemaAtPath(pattern.argumentSchema, [
    ...path,
  ]) !== undefined;
}

export function inferListOpArgumentUsage(
  pattern: Pattern,
): ListOpArgumentUsage {
  const cached = usageCache.get(pattern as object);
  if (cached) return cached;

  if (pattern.argumentSchema === undefined) {
    const legacyUsage = {
      usesElement: true,
      usesIndex: true,
      usesArray: true,
      usesParams: true,
    } satisfies ListOpArgumentUsage;
    usageCache.set(pattern as object, legacyUsage);
    return legacyUsage;
  }

  const usage = {
    usesElement: hasArgumentSchema(pattern, ["element"]),
    usesIndex: hasArgumentSchema(pattern, ["index"]),
    usesArray: hasArgumentSchema(pattern, ["array"]),
    usesParams: hasArgumentSchema(pattern, ["params"]),
  } satisfies ListOpArgumentUsage;

  usageCache.set(pattern as object, usage);
  return usage;
}
