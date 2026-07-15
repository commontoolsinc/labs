import { LINK_V1_TAG } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";

export const REQUEST_SCHEMA_CAS_REF_PREFIX = "schema-cas@1:";

/** Optional request-local accounting for recursive schema-bearing values. */
export interface LinkSchemaTraversal {
  visitNode(depth: number): void;
  visitSchemaPosition(): void;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value);

/** Maps schemas only in modern and legacy link payload positions. */
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

  if (!isPlainRecord(value)) return value;

  let mappedValue = value;
  let changed = false;
  const linkEnvelope = value["/"];
  if (isPlainRecord(linkEnvelope)) {
    const payload = linkEnvelope[LINK_V1_TAG];
    if (isPlainRecord(payload) && Object.hasOwn(payload, "schema")) {
      traversal?.visitSchemaPosition();
      const schema = mapSchema(payload.schema);
      if (schema !== payload.schema) {
        mappedValue = {
          ...mappedValue,
          "/": { ...linkEnvelope, [LINK_V1_TAG]: { ...payload, schema } },
        };
        changed = true;
      }
    }
  }

  const alias = value.$alias;
  if (isPlainRecord(alias) && Object.hasOwn(alias, "schema")) {
    traversal?.visitSchemaPosition();
    const schema = mapSchema(alias.schema);
    if (schema !== alias.schema) {
      mappedValue = { ...mappedValue, $alias: { ...alias, schema } };
      changed = true;
    }
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(mappedValue)) {
    const next = mapLinkSchemas(child, mapSchema, traversal, depth + 1);
    changed ||= next !== child;
    Object.defineProperty(mapped, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return changed ? mapped : value;
};
