/**
 * A deep-frozen container pairing a `JSONSchema` with its content hash.
 * Ensures that schemas are always stored in their canonical deep-frozen
 * form and that the hash is computed once.
 */
import type { JSONSchema } from "@commontools/api";
import { isDeepFrozen } from "./deep-freeze.ts";
import type { FabricHash } from "./fabric-hash.ts";
import { hashSchema } from "./schema-hash.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";

export class SchemaAndHash {
  /** The deep-frozen schema. */
  readonly schema: JSONSchema;

  /** The content hash of the schema as a `FabricHash`. */
  readonly hash: FabricHash;

  /**
   * Constructs a `SchemaAndHash` from an already-deep-frozen schema and
   * its pre-computed hash. Throws if the schema is not deep-frozen.
   * Use `SchemaAndHash.from()` for the friendly entry point that handles
   * freezing and hash computation.
   */
  constructor(schema: JSONSchema, hash: FabricHash) {
    if (!isDeepFrozen(schema)) {
      throw new Error("SchemaAndHash: schema must be deep-frozen");
    }
    this.schema = schema;
    this.hash = hash;
    Object.freeze(this);
  }

  /** The hash as a string (delegates to `FabricHash.toString()`). */
  get hashString(): string {
    return this.hash.toString();
  }

  /**
   * Create a `SchemaAndHash` from a schema. The schema is deep-frozen via
   * `toDeepFrozenSchema()`, and the hash is computed via `hashSchema()`.
   */
  static from(schema: JSONSchema): SchemaAndHash {
    const frozen = toDeepFrozenSchema(schema);
    return new SchemaAndHash(frozen, hashSchema(frozen));
  }
}
