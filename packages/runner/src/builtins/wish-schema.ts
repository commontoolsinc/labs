import type { JSONSchema } from "../builder/types.ts";
import { UI } from "../builder/types.ts";
import {
  deepFrozenCloneAndInternSchema,
  hashSchema,
  internSchema,
} from "@commonfabric/data-model/schema-hash";
import { LRUCache } from "@commonfabric/utils/cache";

// asCell-wrapped schemas keyed by content hash. `hashSchema()` is one
// unavoidable walk (through a query-result proxy when the input is one) and
// is the cache key: it is `FabricValue`-aware, so schemas that differ only in
// non-JSON `FabricValue` content (e.g. a `FabricBytes` default) get distinct
// keys — a `JSON.stringify()` key would collide them. The clone-and-intern
// repeats for the same content on every wish send, so cache it.
const schemaAsCellCache = new LRUCache<string, JSONSchema>({ capacity: 256 });

function schemaAsCell(schema: unknown): JSONSchema {
  if (schema && typeof schema === "object") {
    const key = hashSchema(schema as JSONSchema);
    let result = schemaAsCellCache.get(key);
    if (result === undefined) {
      // `schema` may be a query-result proxy, so deep-frozen-clone rather than
      // freeze in place; the clone de-proxies and preserves `FabricValue`
      // leaves that a JSON round-trip would mangle.
      result = deepFrozenCloneAndInternSchema({
        ...(schema as Record<string, unknown>),
        asCell: ["cell"],
      });
      schemaAsCellCache.put(key, result);
    }
    return result;
  }
  return { asCell: ["cell"] };
}

/** Schema of the state object emitted by `wish()` for a result schema. */
export function wishStateSchemaForResult(
  schema: unknown,
): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  // Materialize once and share the instance for both slots — internSchema
  // canonicalizes the wrapper, so the duplicate reference is fine.
  const resultSchema = schemaAsCell(schema);
  const candidateSchema = resultSchema;
  return internSchema({
    type: "object",
    properties: {
      result: {
        anyOf: [
          { type: "undefined" },
          resultSchema,
        ],
      },
      candidates: {
        type: "array",
        items: candidateSchema,
      },
      error: true,
      [UI]: true,
    },
    required: ["result", "candidates"],
  });
}
