/**
 * Type definitions for SHA-256 hashing: the incremental hasher interface
 * and the all-at-once digest function type used by the package.
 */

/**
 * Incremental hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  /**
   * Feeds the given data into the hasher. Must not be called after
   * `digest()`.
   */
  update(data: Uint8Array): void;

  /** Finalizes the hash and returns the digest as a `Uint8Array`. */
  digest(): Uint8Array;

  /**
   * Finalizes the hash and returns the digest as a string in the given
   * encoding. Currently only `"base64url"` (unpadded) is supported.
   */
  digest(encoding: "base64url"): string;
}

/**
 * All-at-once hash digest function, which takes a payload array and returns
 * the digest.
 */
export type DigestFn = (payload: Uint8Array) => Uint8Array;
