/**
 * A deep-frozen container pairing a `JSONSchema` with a hash string
 * computed from it. Ensures that schemas are always stored in their
 * canonical deep-frozen form and that the hash is computed once.
 */
import type { JSONSchema } from "@commontools/api";
import { hashSchema } from "./schema-hash.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";

export class SchemaAndHash {
  /** The deep-frozen schema. */
  readonly schema: JSONSchema;

  /** The canonical hash of the schema. */
  readonly hash: string;

  private constructor(schema: JSONSchema) {
    this.schema = toDeepFrozenSchema(schema);
    this.hash = hashSchema(this.schema);
    Object.freeze(this);
  }

  /**
   * Create a `SchemaAndHash` from a schema. The schema is deep-frozen via
   * `toDeepFrozenSchema()` in the constructor, so the caller's original
   * object is not modified.
   */
  static from(schema: JSONSchema): SchemaAndHash {
    return new SchemaAndHash(schema);
  }
}
