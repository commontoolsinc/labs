/**
 * A deep-frozen container pairing a `JSONSchema` with its content hash.
 * Ensures that schemas are always stored in their canonical deep-frozen
 * form and that the hash is computed once.
 */
import type { JSONSchema } from "@commontools/api";
import { FabricHash } from "./fabric-hash.ts";
import { hashSchema } from "./schema-hash.ts";
import { toDeepFrozenSchema } from "./schema-utils.ts";

export class SchemaAndHash {
  /** The deep-frozen schema. */
  readonly schema: JSONSchema;

  /** The content hash of the schema as a `FabricHash`. */
  readonly hash: FabricHash;

  constructor(schema: JSONSchema, hash: FabricHash) {
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
   * `toDeepFrozenSchema()`, and the hash is computed via `hashSchema()`
   * then parsed into a `FabricHash`.
   */
  static from(schema: JSONSchema): SchemaAndHash {
    const frozen = toDeepFrozenSchema(schema);
    const hash = FabricHash.fromString(hashSchema(frozen));
    return new SchemaAndHash(frozen, hash);
  }
}
