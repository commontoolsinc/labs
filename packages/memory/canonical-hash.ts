/**
 * Canonical hash of an arbitrary value, producing a deterministic digest
 * based on the value's logical structure.
 *
 * Replaces merkle-reference's CID-based hashing. Traverses the value tree
 * directly (no intermediate serialization) and feeds type-tagged data into
 * the hash. See Section 6 of the formal spec for the full algorithm.
 *
 * Not yet implemented. Gated behind `ExperimentalOptions.canonicalHashing`.
 */
export function canonicalHash(_value: unknown): Uint8Array {
  throw new Error("canonicalHashing not yet implemented");
}
