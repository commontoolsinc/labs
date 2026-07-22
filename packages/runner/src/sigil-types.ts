import type { JSONSchema, JSONValue, LinkScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { URI } from "@commonfabric/memory/interface";
import {
  LINK_V1_TAG,
  type LinkRef,
  type WireLinkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { isLinkScope } from "./scope.ts";

export type { URI } from "@commonfabric/memory/interface";

// The link-ref envelope (`{ "/": { "link@1": … } }`) and its tag are owned by
// `data-model/cell-rep`, the chokepoint that will later flag-dispatch the form.
// Re-exported here (the historical home) for existing importers.
export { LINK_V1_TAG };

/**
 * The payload of a cell-link {@link LinkRef} — the object at the
 * {@link LINK_V1_TAG} key. (The `link@1` tag versions the wire envelope; this
 * payload shape is version-agnostic and expected to outlive it.)
 */
export type CellLinkRefPayload = {
  id?: URI;
  path?: readonly string[];
  space?: MemorySpace;
  scope?: LinkScope;
  schema?: JSONSchema;
  overwrite?: "redirect" | "this"; // default is "this"
};

/**
 * The subset of a {@link CellLinkRefPayload} that is safe to carry across a
 * string boundary (the webhook wire): only the addressing fields, every one of
 * which is a string or an array of strings. `schema` is dropped — it can carry
 * an arbitrary `FabricValue` default (not plain JSON), and the webhook consumer
 * imposes its own schema regardless. cfc's `cfcLabelView` is likewise absent (it
 * is not part of the base payload, and stream/set operations never read it).
 */
export type WebhookCellLinkRefPayload = Omit<CellLinkRefPayload, "schema">;

const WEBHOOK_LINK_KEYS = [
  "id",
  "space",
  "scope",
  "path",
  "overwrite",
] as const;

/**
 * Validates the field-level shape of a decoded {@link WireLinkRefPayload} as a
 * {@link WebhookCellLinkRefPayload}: only the known addressing keys, each of the
 * expected kind — `id`/`space` strings, `path` an array, and `scope`/`overwrite`
 * actual enum members. This layers on top of cell-rep's generic guard, which has
 * already ensured every value is a plain string or array of strings.
 */
export function assertWebhookCellLinkRefPayload(
  payload: WireLinkRefPayload,
): asserts payload is WebhookCellLinkRefPayload {
  for (const key of Object.keys(payload)) {
    if (!(WEBHOOK_LINK_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unexpected cell-link field: "${key}".`);
    }
  }
  if (payload.path !== undefined && !Array.isArray(payload.path)) {
    throw new Error('Cell-link "path" must be an array of strings.');
  }
  for (const key of ["id", "space"] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw new Error(`Cell-link "${key}" must be a string.`);
    }
  }
  // Validate the enum-valued fields against their actual members, not merely
  // "is a string" — otherwise this assertion would be unsound (e.g. a bogus
  // `scope` would pass and then be typed as a valid `LinkScope`).
  if (payload.scope !== undefined && !isLinkScope(payload.scope)) {
    throw new Error(
      'Cell-link "scope" must be one of "inherit", "space", "user", "session".',
    );
  }
  if (
    payload.overwrite !== undefined &&
    payload.overwrite !== "redirect" && payload.overwrite !== "this"
  ) {
    throw new Error('Cell-link "overwrite" must be "redirect" or "this".');
  }
}

/**
 * Sigil link type.
 *
 * Transitional alias for {@link LinkRef}: structurally the same envelope, but
 * named through the chokepoint that will later flag-dispatch the form. Once a
 * modern (non-envelope) representation exists, `SigilLink` (which _is_ the
 * envelope) and `LinkRef` (which spans both forms) diverge and this alias gets
 * cleaned up.
 *
 * Parameterized on the payload so a producer can advertise a richer payload
 * (e.g. cfc's `CfcCellLinkRefPayload`); defaults to the base
 * {@link CellLinkRefPayload}, so bare `SigilLink` is unchanged.
 */
export type SigilLink<P extends CellLinkRefPayload = CellLinkRefPayload> =
  LinkRef<P>;
/**
 * A {@link SigilLink} whose payload is a write redirect (an alias) — its
 * `overwrite` is fixed to `"redirect"`.
 */
export type SigilWriteRedirectLink = LinkRef<
  CellLinkRefPayload & { overwrite: "redirect" }
>;

/**
 * `$alias` Pattern binding.
 *
 * These are used in intermediate bindings at runtime and are persisted in
 * saved patterns, like the map op. They are not links: in data, an `$alias`
 * record is a plain value.
 */
type AliasBindingBase = {
  path: readonly string[];
  scope?: LinkScope;
  schema?: JSONSchema;
};

type AliasBindingNamedCell = AliasBindingBase & {
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
type AliasBindingPartialCause = AliasBindingBase & {
  cell?: never;
  partialCause: JSONValue;
  defer?: number;
};

export type AliasBinding = {
  $alias:
    | AliasBindingNamedCell
    | AliasBindingPartialCause;
};
