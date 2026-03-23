/**
 * A deep-frozen container pairing a `JSONSchema` with a `FabricHash`
 * computed from it. Ensures that schemas are always stored in their
 * canonical deep-frozen form and that the hash is computed once.
 */
import type { JSONSchema } from "@commontools/api";
import { FabricHash } from "./fabric-hash.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";
import { modernHash } from "./value-hash-modern.ts";

export class SchemaAndHash {
  /** The deep-frozen schema. */
  readonly schema: JSONSchema;

  /** The canonical hash of the schema. */
  readonly hash: FabricHash;

  private constructor(schema: JSONSchema, hash: FabricHash) {
    this.schema = schema;
    this.hash = hash;
    Object.freeze(this);
  }

  /**
   * Create a `SchemaAndHash` from a schema. The schema is deep-frozen via
   * `toDeepFrozenSchema()` before hashing, so the caller's original object
   * is not modified.
   */
  static from(schema: JSONSchema): SchemaAndHash {
    const frozen = toDeepFrozenSchema(schema);
    const hash = modernHash(frozen);
    return new SchemaAndHash(frozen, hash);
  }
}
