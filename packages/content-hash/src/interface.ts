/**
 * Incremental SHA-256 hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
}

/**
 * All-at-once SHA-256: `(payload) => digest`.
 */
export type Sha256Fn = (payload: Uint8Array) => Uint8Array;
