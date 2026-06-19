import type { JSONSchema, JSONValue, LinkScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { URI } from "@commonfabric/memory/interface";
import { LINK_V1_TAG, type LinkRef } from "@commonfabric/data-model/cell-rep";

export type { URI } from "@commonfabric/memory/interface";

/**
 * Generic sigil value type for future extensions
 */
export type SigilValue<T> = { "/": T };

/**
 * Link sigil value v1
 */

// The link-ref envelope (`{ "/": { "link@1": … } }`) and its tag are owned by
// `data-model/cell-rep`, the chokepoint that will later flag-dispatch the form.
// Re-exported here (the historical home) for existing importers.
export { LINK_V1_TAG };

/**
 * Inner value of a LinkV1 sigil (the object at the LINK_V1_TAG key)
 */
export type LinkV1Inner = {
  id?: URI;
  path?: readonly string[];
  space?: MemorySpace;
  scope?: LinkScope;
  schema?: JSONSchema;
  overwrite?: "redirect" | "this"; // default is "this"
};

export type LinkV1 = {
  [LINK_V1_TAG]: LinkV1Inner;
};

export type WriteRedirectV1 = LinkV1 & {
  [LINK_V1_TAG]: { overwrite: "redirect" };
};
/**
 * Sigil link type.
 *
 * Transitional alias for {@link LinkRef}: structurally the same envelope, but
 * named through the chokepoint that will later flag-dispatch the form. Once a
 * modern (non-envelope) representation exists, `SigilLink` (which _is_ the
 * envelope) and `LinkRef` (which spans both forms) diverge and this alias gets
 * cleaned up.
 */
export type SigilLink = LinkRef<LinkV1Inner>;
/**
 * Sigil alias type - uses LinkV1 with overwrite field
 */

export type SigilWriteRedirectLink = SigilValue<WriteRedirectV1>;

/****************
 * Legacy types *
 ****************/

/**
 * Legacy alias.
 *
 * These are used in intermediate bindings at runtime.
 * They are persisted in saved patterns, like the map op.
 */
type LegacyAliasBase = {
  path: readonly string[];
  scope?: LinkScope;
  schema?: JSONSchema;
};

type LegacyAliasNamedCell = LegacyAliasBase & {
  cell?: "result" | "argument";
  partialCause?: never;
  defer?: number;
};

/**
 * These are partial bindings that may not be applicable to the current
 * pattern. We track the defer count, and each time we unwrap bindings,
 * we decrement that. Once it's 0, we know that it's associated with the
 * current pattern, and we can generate real cells based ont the combination
 * of the pattern's result (parent) and the partialCause.
 */
type LegacyAliasPartialCause = LegacyAliasBase & {
  cell?: never;
  partialCause: JSONValue;
  defer?: number;
};

export type LegacyAlias = {
  $alias:
    | LegacyAliasNamedCell
    | LegacyAliasPartialCause;
};
