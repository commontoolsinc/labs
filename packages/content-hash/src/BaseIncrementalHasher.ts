import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

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

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding: string | undefined): Uint8Array | string;
  digest(encoding?: string | undefined): Uint8Array | string {
    this.#throwIfDone();

    const result = this._rawDigest();
    this.#done = true;

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

  update(data: Uint8Array) {
    this.#throwIfDone();
    this._rawUpdate(data);
  }

  #throwIfDone() {
    if (this.#done) {
      throw new Error("Cannot use instance: `digest()` already done.");
    }
  }

  /**
   * This is called by the base class when there is data to be passed to the
   * underlying hash implementation.
   */
  protected abstract _rawUpdate(data: Uint8Array): void;

  /**
   * This is called by the base class to perform a digest operation on the
   * underlying hash implementation.
   */
  protected abstract _rawDigest(): Uint8Array;
}
