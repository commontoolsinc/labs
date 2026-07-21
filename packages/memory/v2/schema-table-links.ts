import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import type { FabricPlainObject } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/utils/types";

export const REQUEST_SCHEMA_CAS_REF_PREFIX = "schema-cas@1:";

/** Optional request-local accounting for recursive schema-bearing values. */
export interface LinkSchemaTraversal {
  visitNode(depth: number): void;
  visitSchemaPosition(): void;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

/**
 * Maps schemas only in link-payload and legacy `$alias` schema positions.
 *
 * Link recognition and reconstruction go through the `cell-rep` chokepoint
 * ({@link isLinkRef} / {@link linkRefPayload} / {@link linkRefFrom}), so both
 * `modernCellRep` regimes are handled transparently — legacy envelope or
 * `FabricLink` instance alike. The `$alias` form predates the chokepoint and
 * is never regime-dispatched, so it is recognized locally here.
 */
export const mapLinkSchemas = (
  value: unknown,
  mapSchema: (schema: unknown) => unknown,
  traversal?: LinkSchemaTraversal,
  depth = 0,
): unknown => {
  traversal?.visitNode(depth);
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = mapLinkSchemas(item, mapSchema, traversal, depth + 1);
      changed ||= next !== item;
      return next;
    });
    return changed ? mapped : value;
  }

  if (isLinkRef(value)) {
    const payload = linkRefPayload(value);
    let mappedPayload: FabricPlainObject = payload;
    let changed = false;
    if (Object.hasOwn(payload, "schema")) {
      traversal?.visitSchemaPosition();
      const schema = mapSchema(payload.schema);
      if (schema !== payload.schema) {
        mappedPayload = { ...payload, schema } as FabricPlainObject;
        changed = true;
      }
    }
    const walked = mapRecordChildren(
      mappedPayload as Record<string, unknown>,
      mapSchema,
      traversal,
      depth,
    );
    if (walked !== mappedPayload) {
      mappedPayload = walked as FabricPlainObject;
      changed = true;
    }
    return changed ? linkRefFrom(mappedPayload) : value;
  }

  if (!isPlainRecord(value)) return value;

  let mappedValue = value;
  let changed = false;
  const alias = value.$alias;
  if (isPlainRecord(alias) && Object.hasOwn(alias, "schema")) {
    traversal?.visitSchemaPosition();
    const schema = mapSchema(alias.schema);
    if (schema !== alias.schema) {
      mappedValue = { ...mappedValue, $alias: { ...alias, schema } };
      changed = true;
    }
  }

  const walked = mapRecordChildren(mappedValue, mapSchema, traversal, depth);
  if (walked !== mappedValue) return walked;
  return changed ? mappedValue : value;
};

/** Walks every own entry of a record, allocating a copy only on change.
 *  Plain assignment is safe for every key except "__proto__", whose
 *  assignment would hit the prototype accessor instead of creating an own
 *  property. */
const mapRecordChildren = (
  record: Record<string, unknown>,
  mapSchema: (schema: unknown) => unknown,
  traversal: LinkSchemaTraversal | undefined,
  depth: number,
): Record<string, unknown> => {
  const entries = Object.entries(record);
  const mappedChildren: unknown[] = new Array(entries.length);
  let childChanged = false;
  for (let index = 0; index < entries.length; index += 1) {
    const child = entries[index][1];
    const next = mapLinkSchemas(child, mapSchema, traversal, depth + 1);
    mappedChildren[index] = next;
    childChanged ||= next !== child;
  }
  if (!childChanged) return record;

  const mapped: Record<string, unknown> = {};
  for (let index = 0; index < entries.length; index += 1) {
    const key = entries[index][0];
    const next = mappedChildren[index];
    if (key === "__proto__") {
      Object.defineProperty(mapped, key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      mapped[key] = next;
    }
  }
  return mapped;
};
