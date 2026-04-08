/**
 * Deno version of SHA256. This should not be `import`ed unless the caller
 * knows they are operating in a Deno environment.
 */

import { isDeno } from "@commonfabric/utils/env";
import type { IncrementalHasher } from "./interface.ts";

if (!isDeno()) {
  throw new Error("Do not import `sha256-deno` in a non-Deno environment.");
}

// Can't `import` at the top, because then we couldn't do the check for Deno and
// issue the nice diagnostic message.
const crypto = await import("node:crypto");

export function sha256Deno(payload: Uint8Array): Uint8Array {
  // `node:crypto digest()` returns a `Buffer` (a `Uint8Array` subclass);
  // normalize it to plain `Uint8Array`, so downstream equality checks work
  // correctly.
  const buf = crypto.createHash("sha256").update(payload).digest();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function createHasherDeno(): IncrementalHasher {
  return new DenoHasher();
}

class DenoHasher implements IncrementalHasher {
  #hasher = crypto.createHash("sha256");

  update(data: Uint8Array) {
    this.#hasher.update(data);
  }

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    switch (encoding) {
      case "base64url": {
        return this.#hasher.digest(encoding);
      }
      case undefined: {
        // node:crypto digest() returns Buffer; normalize to plain Uint8Array.
        const buf = this.#hasher.digest();
        return new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        );
      }
      default: {
        throw new Error(`Unknown encoding: ${encoding}`);
      }
    }
  }
}
