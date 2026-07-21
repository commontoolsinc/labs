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
  return { type: "unknown", asCell: ["cell"] };
}

/** Schema of the state object emitted by `wish()` for a result schema. */
export function wishStateSchemaForResult(
  schema: unknown,
): JSONSchema | undefined {
  // Untyped wishes retain their legacy schemaless state. Fabric instances are
  // self-describing there, while adding a generic `asCell` arm would change
  // how existing untyped result links are traversed.
  if (schema === undefined) return undefined;
  // Materialize once and share the instance for both slots — internSchema
  // canonicalizes the wrapper, so the duplicate reference is fine.
  const resultSchema = schemaAsCell(schema);
  const candidateSchema = resultSchema;
  // Local refs are resolved from the schema root. Hoist authored definitions
  // so paths selected through the WishState wrapper retain that root context.
  const rootDefs = typeof resultSchema === "object" && resultSchema !== null
    ? resultSchema.$defs
    : undefined;
  return internSchema({
    type: "object",
    properties: {
      result: {
        anyOf: [
          // Persisted pre-AsyncResult failures stored undefined here. New
          // states put every unavailable value behind the result link below.
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
    ...(rootDefs !== undefined && { $defs: rootDefs }),
  });
}
