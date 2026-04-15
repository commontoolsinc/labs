import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

/**
 * Base implementation for the `IncrementalHasher` interface.
 */
export abstract class BaseIncrementalHasher implements IncrementalHasher {
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string;
  digest(encoding?: string | undefined): Uint8Array | string {
    const result = this._rawDigest();

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

  abstract update(data: Uint8Array): void;
  protected abstract _rawDigest(): Uint8Array;
}
