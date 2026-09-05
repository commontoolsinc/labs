/**
 * Value-aligned array position matching (2020-12 semantics): a tuple slot
 * (`prefixItems[i]`) governs exactly index i, and the uniform `items` schema
 * governs only the indices past the slots.
 *
 * Shared by the narrow value matchers (`matchesConcreteValue` in schema.ts,
 * `policySchemaMatchesValue` in cfc/prepare.ts) so the position rule cannot
 * drift between them again — CT-1895 fixed the same prefixItems fall-through
 * in each matcher separately; CT-1899 tracks consolidating the matchers
 * themselves. The `matches` callback owns recursion and ref semantics: the
 * matchers differ exactly there ($defs threading vs fail-closed policy refs).
 */

import type { JSONSchema, JSONSchemaObj } from "./builder/types.ts";

/**
 * The greatest number of elements a schema's tuple closure admits, or
 * `undefined` where it admits any number. `items: false` closes the tuple:
 * nothing is allowed past the `prefixItems` slots, so a schema with no slots
 * admits only the empty array.
 *
 * Separate from the positional match because a shallow prefilter — the anyOf
 * pre-check in traverse.ts, and the per-branch precomputation beside it —
 * decides on length alone and never descends to the elements.
 */
export const closedArrayLength = (
  schema: JSONSchemaObj,
): number | undefined => {
  if (schema.items !== false) return undefined;
  return Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
};

export const arrayMatchesPositionally = (
  schema: JSONSchemaObj,
  value: readonly unknown[],
  matches: (childSchema: JSONSchema, childValue: unknown) => boolean,
): boolean => {
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : undefined;
  if (prefixItems !== undefined) {
    const slots = Math.min(prefixItems.length, value.length);
    for (let index = 0; index < slots; index++) {
      if (!matches(prefixItems[index], value[index])) return false;
    }
  }
  const closed = closedArrayLength(schema);
  if (closed !== undefined) {
    if (value.length > closed) return false;
  } else if (typeof schema.items === "object" && schema.items !== null) {
    for (
      let index = prefixItems?.length ?? 0;
      index < value.length;
      index++
    ) {
      if (!matches(schema.items, value[index])) return false;
    }
  }
  return true;
};
