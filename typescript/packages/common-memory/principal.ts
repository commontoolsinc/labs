import {
  DIDKey,
  AsyncResult,
  Unit,
  Verifier,
  Result,
  AuthorizationError,
  AsBytes,
  Signer,
  DID,
} from "./interface.ts";
import { base58btc } from "multiformats/bases/base58";
import { base64pad } from "multiformats/bases/base64";
import { varint } from "multiformats";
import { unauthorized } from "./error.ts";

const DID_PREFIX = "did:";
const DID_KEY_PREFIX = `did:key:`;
const DID_KEY_PREFIX_SIZE = DID_KEY_PREFIX.length;

/**
 * Parses a DID string into a DID buffer view
 */
export const fromDID = <ID extends DIDKey>(
  id: ID | DID | string,
): Result<ED25519Verifier<ID>, SyntaxError> => {
  if (!id.startsWith(DID_PREFIX)) {
    throw new RangeError(`Invalid DID "${id}", must start with 'did:'`);
  } else if (id.startsWith(DID_KEY_PREFIX)) {
    return fromDIDKey(id as ID);
  } else {
    return { error: new SyntaxError(`Expected did identifier instead got ${id}`) };
  }
};

const fromDIDKey = <ID extends DIDKey>(source: ID) => {
  const key = base58btc.decode(source.slice(DID_KEY_PREFIX_SIZE));
  const [code] = varint.decode(key);
  switch (code) {
    case ED25519Verifier.code:
      return ED25519Verifier.fromBytes<ID>(key);
    default:
      return {
        error: new RangeError(
          `Unsupported key algorithm denoted by multicode 0x${code.toString(16)}.`,
        ),
      };
  }
};

const ALG = "Ed25519";

export class ED25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  static code = 0xed;
  static tagSize = varint.encodingLength(this.code);
  static keySize = 32;
  static taggedSize = this.tagSize + this.keySize;

  #rawKey: Uint8Array;
  #did: ID;
  #key: CryptoKey | null = null;

  static fromString<ID extends DIDKey>(key: string): Result<ED25519Verifier<ID>, Error> {
    return this.fromBytes(base64pad.decode(key));
  }

  static fromBytes<ID extends DIDKey>(bytes: Uint8Array): Result<ED25519Verifier<ID>, Error> {
    const [algorithm] = varint.decode(bytes);
    if (algorithm !== this.code) {
      return {
        error: new RangeError(
          `Unsupported key algorithm expected 0x${this.code.toString(
            16,
          )}, instead of 0x${algorithm.toString(16)}`,
        ),
      };
    }

    if (bytes.length !== this.taggedSize) {
      return {
        error: RangeError(
          `Expected Uint8Array with byteLength ${this.keySize}, instead got Uint8Array with byteLength ${bytes.byteLength}`,
        ),
      };
    }

    return { ok: new this(bytes) };
  }
  constructor(key: Uint8Array) {
    this.#rawKey = key;
    this.#did = `did:key:${base58btc.encode(key)}` as ID;
  }
  did() {
    return this.#did;
  }
  async verify({
    payload,
    signature,
  }: {
    payload: Uint8Array;
    signature: Uint8Array;
  }): AsyncResult<Unit, AuthorizationError> {
    if (this.#key == null) {
      this.#key = await crypto.subtle.importKey(
        "raw",
        this.#rawKey.subarray(ED25519Verifier.tagSize),
        ALG,
        false,
        ["verify"],
      );
    }

    if (await crypto.subtle.verify(ALG, this.#key, signature, payload)) {
      return { ok: {} };
    } else {
      return { error: unauthorized(`Invalid signature`) };
    }
  }
}

export class ED25519Signer<ID extends DIDKey> implements Signer<ID> {
  static code = 0x1300;
  static tagSize = varint.encodingLength(this.code);
  static keySize = 32;
  static publicOffset = this.tagSize + this.keySize;
  static size = this.tagSize + this.keySize + ED25519Verifier.tagSize + ED25519Verifier.keySize;

  static fromString<ID extends DIDKey>(key: string): ED25519Signer<ID> {
    return this.fromBytes<ID>(base64pad.decode(key));
  }
  // 0x302e020100300506032b657004220420
  // via https://stackoverflow.com/a/79135112
  static PKCS8_PREFIX = new Uint8Array([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);

  static fromBytes<ID extends DIDKey>(bytes: Uint8Array): ED25519Signer<ID> {
    if (bytes.byteLength !== this.size) {
      throw new Error(
        `Expected Uint8Array with byteLength of ${this.size} instead not ${bytes.byteLength}`,
      );
    }

    {
      const [keyCode] = varint.decode(bytes);
      if (keyCode !== this.code) {
        throw new Error(`Given bytes must be a multiformat with ${this.code} tag`);
      }
    }

    {
      const [code] = varint.decode(bytes.subarray(this.publicOffset));
      if (code !== ED25519Verifier.code) {
        throw new Error(
          `Given bytes must contain public key in multiformats with ${ED25519Verifier.code} tag`,
        );
      }
    }

    return new this(bytes);
  }
  #rawKey: Uint8Array;
  #key: CryptoKey | null = null;
  verifier: ED25519Verifier<ID>;
  constructor(key: Uint8Array) {
    this.#rawKey = key;
    this.verifier = new ED25519Verifier<ID>(this.#rawKey.subarray(ED25519Signer.publicOffset));
  }
  did() {
    return this.verifier.did();
  }

  static async importKey(raw: Uint8Array): AsyncResult<CryptoKey, Error> {
    try {
      const pkcs8 = new Uint8Array(this.PKCS8_PREFIX.length + this.keySize);
      pkcs8.set(this.PKCS8_PREFIX);
      pkcs8.set(raw.subarray(this.tagSize, this.publicOffset), this.PKCS8_PREFIX.length);

      const key = await crypto.subtle.importKey("pkcs8", pkcs8, ALG, false, ["sign"]);
      return { ok: key };
    } catch (reason) {
      return { error: reason as Error };
    }
  }
  async sign<T>(payload: AsBytes<T>) {
    if (this.#key == null) {
      const result = await ED25519Signer.importKey(this.#rawKey);
      if (result.error) {
        return result;
      } else {
        this.#key = result.ok;
      }
    }

    const buffer = await crypto.subtle.sign(ALG, this.#key, payload);
    return { ok: new Uint8Array(buffer) };
  }
}
