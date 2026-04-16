/**
 * Incremental hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
}

/**
 * All-at-once hash digest function, which takes a payload array and returns
 * the digest.
 */
export type DigestFn = (payload: Uint8Array) => Uint8Array;
