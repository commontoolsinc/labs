import type { Pattern } from "../builder/types.ts";
import type { ContextualFlowControl } from "../cfc.ts";

export type ListOpArgumentUsage = {
  usesElement: boolean;
  usesIndex: boolean;
  usesArray: boolean;
  usesParams: boolean;
};

const usageCache = new WeakMap<object, ListOpArgumentUsage>();

function hasArgumentSchema(
  cfc: ContextualFlowControl,
  pattern: Pattern,
  path: readonly string[],
): boolean {
  return cfc.getSchemaAtPath(pattern.argumentSchema, [...path]) !== undefined;
}

/** Infer the public `{ element, index, array, params }` projection used only by
 * stored legacy list nodes. Canonical bound factories receive the fixed public
 * triple and carry closure params in their invocation-owned params cell. */
export function inferListOpArgumentUsage(
  cfc: ContextualFlowControl,
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
    usesElement: hasArgumentSchema(cfc, pattern, ["element"]),
    usesIndex: hasArgumentSchema(cfc, pattern, ["index"]),
    usesArray: hasArgumentSchema(cfc, pattern, ["array"]),
    usesParams: hasArgumentSchema(cfc, pattern, ["params"]),
  } satisfies ListOpArgumentUsage;

  usageCache.set(pattern as object, usage);
  return usage;
}
