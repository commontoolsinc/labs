import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "@/interface.ts";

/**
 * Base implementation for the `IncrementalHasher` interface. This takes
 * care of:
 *
 * * Disallowing use of an instance after `digest()`.
 * * Converting an array result of `_rawDigest()` into a string when so
 *   requested.
 */
export abstract class BaseIncrementalHasher implements IncrementalHasher {
  #done: boolean = false;

  /** @inheritDoc */
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding: string | undefined): Uint8Array | string;
  digest(encoding?: string | undefined): Uint8Array | string {
    this.#throwIfDone();

    const result = this._rawDigest(encoding);
    this.#done = true;

    if (typeof result === "string") {
      // `_rawDigest()` handles encoding.
      return result;
    }

    switch (encoding) {
      case "base64url": {
        return toUnpaddedBase64url(result);
      }
      case undefined: {
        return result;
      }
      default: {
        throw new Error(`Unknown encoding: ${encoding}`);
      }
    }
  }

  /** @inheritDoc */
  update(data: Uint8Array) {
    this.#throwIfDone();
    this._rawUpdate(data);
  }

  /**
   * Helper for `digest()` and `update()`, which throws if this instance
   * has already been finalized via `digest()`.
   */
  #throwIfDone() {
    if (this.#done) {
      throw new Error("Cannot use instance: `digest()` already done.");
    }
  }

  /**
   * Passes data to the underlying hash implementation. Called by the base
   * class when there is data to be hashed.
   */
  protected abstract _rawUpdate(data: Uint8Array): void;

  /**
   * Performs a digest operation using the underlying hash implementation.
   * Called by the base class. May ignore the `encoding` and always return a
   * `Uint8Array`.
   */
  protected abstract _rawDigest(
    encoding: string | undefined,
  ): Uint8Array | string;
}
