/**
 * A deep-frozen container pairing a `JSONSchema` with its content hash.
 * Ensures that schemas are always stored in their canonical deep-frozen
 * form and that the hash is computed once.
 *
 * To create instances, use `internSchema()` from `schema-hash.ts` —
 * it handles freezing, hashing, and caching. The constructor is public
 * for direct use when both the frozen schema and hash are already in hand.
 */
import type { JSONSchema } from "@commontools/api";
import { isDeepFrozen } from "./deep-freeze.ts";
import type { FabricHash } from "./fabric-hash.ts";

export class SchemaAndHash {
  readonly #schema: JSONSchema;
  readonly #hash: FabricHash;

  /**
   * Constructs a `SchemaAndHash` from an already-deep-frozen schema and
   * its pre-computed hash. Throws if the schema is not deep-frozen.
   * Prefer `internSchema()` from `schema-hash.ts` for the friendly entry
   * point that handles freezing, hashing, and interning.
   */
  constructor(schema: JSONSchema, hash: FabricHash) {
    if (!isDeepFrozen(schema)) {
      throw new Error("SchemaAndHash: schema must be deep-frozen");
    }
    this.#schema = schema;
    this.#hash = hash;
    Object.freeze(this);
  }

  /** The deep-frozen schema. */
  get schema(): JSONSchema {
    return this.#schema;
  }

  /** The content hash of the schema as a `FabricHash`. */
  get hash(): FabricHash {
    return this.#hash;
  }

  /** The hash as a string (delegates to `FabricHash.toString()`). */
  get hashString(): string {
    return this.#hash.toString();
  }
}
