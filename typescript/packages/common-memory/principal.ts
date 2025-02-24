import { DIDKey, AsyncResult, Unit, Issuer, Result, AuthorizationError } from "./interface.ts";
import { base58btc } from "multiformats/bases/base58";
import { varint } from "multiformats";
import { unauthorized } from "./error.ts";

const DID_PREFIX = "did:";
const DID_KEY_PREFIX = `did:key:`;
const DID_KEY_PREFIX_SIZE = DID_KEY_PREFIX.length;

/**
 * Parses a DID string into a DID buffer view
 *
 * @template {DID} ID
 * @param {ID|string} did
 * @returns {Issuer}
 */
export const fromDID = (id: string): Result<Issuer, SyntaxError> => {
  if (!id.startsWith(DID_PREFIX)) {
    throw new RangeError(`Invalid DID "${id}", must start with 'did:'`);
  } else if (id.startsWith(DID_KEY_PREFIX)) {
    return fromDIDKey(id as DIDKey);
  } else {
    return { error: new SyntaxError(`Expected did identifier instead got ${id}`) };
  }
};

const fromDIDKey = (source: DIDKey) => {
  const key = base58btc.decode(source.slice(DID_KEY_PREFIX_SIZE));
  const [code] = varint.decode(key);
  switch (code) {
    case ED25519.CODE:
      return ED25519Issuer.fromBytes(key);
    default:
      return {
        error: new RangeError(
          `Unsupported key algorithm denoted by multicode 0x${code.toString(16)}.`,
        ),
      };
  }
};

class ED25519 {
  static CODE = 0xed;
  static ALG = "Ed25519";
  static PUB_KEY_RAW_SIZE = 32;
  static PUB_KEY_TAG_SIZE = varint.encodingLength(this.CODE);
  static PUB_KEY_TAGGED_SIZE = this.PUB_KEY_RAW_SIZE + this.PUB_KEY_TAG_SIZE;
}

class ED25519Issuer extends ED25519 implements Issuer {
  #rawKey: Uint8Array;
  #did: DIDKey;
  #key: CryptoKey | null = null;

  static fromBytes(bytes: Uint8Array) {
    const [algorithm] = varint.decode(bytes);
    if (algorithm !== ED25519.CODE) {
      return {
        error: new RangeError(
          `Unsupported key algorithm expected 0x${ED25519.CODE.toString(
            16,
          )}, instead of 0x${algorithm.toString(16)}`,
        ),
      };
    }

    if (bytes.length !== ED25519.PUB_KEY_TAGGED_SIZE) {
      return {
        error: RangeError(
          `Expected Uint8Array with byteLength ${ED25519.PUB_KEY_TAGGED_SIZE}, instead got Uint8Array with byteLength ${bytes.byteLength}`,
        ),
      };
    }

    return { ok: new this(bytes) };
  }
  constructor(key: Uint8Array) {
    super();
    this.#rawKey = key;
    this.#did = `did:key:${base58btc.encode(key)}`;
  }
  get id() {
    return this.#did;
  }
  async verify(payload: Uint8Array, signature: Uint8Array): AsyncResult<Unit, AuthorizationError> {
    if (this.#key == null) {
      this.#key = await crypto.subtle.importKey(
        "raw",
        this.#rawKey.subarray(ED25519Issuer.PUB_KEY_TAG_SIZE),
        ED25519.ALG,
        true,
        ["verify"],
      );
    }

    if (await crypto.subtle.verify(ED25519.ALG, this.#key, signature, payload)) {
      return { ok: {} };
    } else {
      return { error: unauthorized(`Invalid signature`) };
    }
  }
}
