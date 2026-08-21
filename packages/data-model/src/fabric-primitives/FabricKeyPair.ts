import type {
  FabricBytes as ApiFabricBytes,
  FabricKeyPair as ApiFabricKeyPair,
  FabricKeyPairConstructor as ApiFabricKeyPairConstructor,
} from "@commonfabric/api";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive } from "@/fabric-bases/BaseFabricPrimitive.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import type { FabricValue } from "@/interface.ts";
import { FabricBytes } from "./FabricBytes.ts";

/**
 * The encoded state of a {@link FabricKeyPair} that holds material: the
 * algorithm name, and the two keys as base64url. This is the only state JSON
 * carries, a pair holding handles having no representation in that format.
 */
type FabricKeyPairMaterialState = {
  algorithm: string;
  publicKey: string;
  privateKey: string;
};

/**
 * The realm-crossing state of a {@link FabricKeyPair} that holds material.
 * Each key is a bare `ArrayBuffer` for the reason `FabricBytes` encodes to
 * one: that is the form `postMessage()` can _transfer_.
 */
type RealmMaterialState = {
  algorithm: string;
  publicKey: ArrayBuffer;
  privateKey: ArrayBuffer;
};

/**
 * The realm-crossing state of a {@link FabricKeyPair} that holds handles. The
 * algorithm is absent because each `CryptoKey` carries its own, which is what
 * the reconstructed pair reads it from.
 */
type RealmHandleState = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

/** Whether the given value is a `CryptoKey` this realm recognizes. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return !!globalThis.CryptoKey && (value instanceof globalThis.CryptoKey);
}

/** Whether the given value is a `CryptoKeyPair` this realm recognizes. */
function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
  return isPlainObject(value) && isCryptoKey(value.publicKey) &&
    isCryptoKey(value.privateKey);
}

/**
 * Immutable asymmetric key pair in the fabric type system.
 *
 * An instance is in one of two states, which its whole surface distinguishes:
 *
 * * It **holds handles**: two `CryptoKey`s, whose material this realm may have
 *   no way to reach. {@link #cryptoKeyPair} returns them.
 * * It **holds material**: the two keys as bytes. {@link #publicKeyBytes} and
 *   {@link #privateKeyBytes} return them.
 *
 * {@link #hasMaterial} says which, and {@link #algorithm} names the algorithm
 * either way.
 *
 * Only a pair holding material has a JSON encoding. A pair holding handles
 * refuses that format: a `CryptoKey`'s material is reachable only through
 * `SubtleCrypto.exportKey()`, which is asynchronous and which a non-extractable
 * key refuses outright, so there is nothing for a synchronous `encode()` to
 * write down. It crosses a realm boundary as itself instead, structured
 * cloning carrying a `CryptoKey` with its extractability intact.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and the
 * material arm holds `FabricBytes`, which own their buffers outright. Instance
 * state is elided by the debug renderer, so a private key does not reach a log
 * through a `console.log()` of the value that holds it.
 */
export class FabricKeyPair extends BaseFabricPrimitive
  implements ApiFabricKeyPair {
  /** The algorithm name. */
  readonly #algorithm: string;

  /** The public key, in whichever form this instance holds. */
  readonly #publicKey: CryptoKey | FabricBytes;

  /** The private key, in the same form as {@link #publicKey}. */
  readonly #privateKey: CryptoKey | FabricBytes;

  /**
   * Constructs an instance, either from a `CryptoKeyPair` -- whose two keys
   * must be a public/private pair agreeing on their algorithm -- or from an
   * algorithm name and the two keys' bytes. A `Uint8Array` argument is copied;
   * a caller wishing to cede its buffer wraps it in a `FabricBytes` first.
   *
   * The algorithm name follows Web Crypto's normalized spelling (e.g.
   * `"Ed25519"`), which is what the `CryptoKeyPair` form reports.
   */
  constructor(pair: CryptoKeyPair);
  constructor(
    algorithm: string,
    publicKey: ApiFabricBytes | Uint8Array,
    privateKey: ApiFabricBytes | Uint8Array,
  );
  constructor(
    pairOrAlgorithm: CryptoKeyPair | string,
    publicKey?: ApiFabricBytes | Uint8Array,
    privateKey?: ApiFabricBytes | Uint8Array,
  ) {
    super();

    if (typeof pairOrAlgorithm === "string") {
      if (pairOrAlgorithm === "") {
        throw new Error("Cannot construct a key pair with no algorithm name.");
      }
      this.#algorithm = pairOrAlgorithm;
      this.#publicKey = FabricKeyPair.#toFabricBytes(publicKey, "publicKey");
      this.#privateKey = FabricKeyPair.#toFabricBytes(
        privateKey,
        "privateKey",
      );
    } else {
      const { publicKey: pub, privateKey: priv } = FabricKeyPair.#validPair(
        pairOrAlgorithm,
      );
      this.#algorithm = pub.algorithm.name;
      this.#publicKey = pub;
      this.#privateKey = priv;
    }

    Object.freeze(this);
  }

  //
  // Instance members
  //

  /** The algorithm name (e.g. `"Ed25519"`). */
  get algorithm(): string {
    return this.#algorithm;
  }

  /** Whether this instance holds key material, as opposed to handles. */
  get hasMaterial(): boolean {
    return this.#publicKey instanceof FabricBytes;
  }

  /**
   * A fresh `CryptoKeyPair` holding this instance's two keys, returned anew on
   * each call so the record is never aliased out. Throws when this instance
   * holds material.
   */
  get cryptoKeyPair(): CryptoKeyPair {
    if (this.hasMaterial) {
      throw new Error(
        "Cannot produce a `CryptoKeyPair`: this key pair holds material.",
      );
    }

    return {
      publicKey: this.#publicKey as CryptoKey,
      privateKey: this.#privateKey as CryptoKey,
    };
  }

  /** The public key's bytes. Throws when this instance holds handles. */
  get publicKeyBytes(): FabricBytes {
    return this.#materialOf(this.#publicKey);
  }

  /** The private key's bytes. Throws when this instance holds handles. */
  get privateKeyBytes(): FabricBytes {
    return this.#materialOf(this.#privateKey);
  }

  /**
   * Returns the given key as bytes.
   *
   * @throws If this instance holds handles.
   */
  #materialOf(key: CryptoKey | FabricBytes): FabricBytes {
    if (!(key instanceof FabricBytes)) {
      throw new Error(
        "Cannot produce key material: this key pair holds handles.",
      );
    }

    return key;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class KeyPairCodec
      extends BaseNonterminalCodec<FabricKeyPairMaterialState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.KeyPair, FabricKeyPair);
      }

      /**
       * @inheritDoc
       *
       * @throws If `value` holds handles, that state having no representation
       *   in this format.
       */
      encode(value: FabricKeyPair): FabricKeyPairMaterialState {
        if (!value.hasMaterial) {
          throw new Error(
            "Cannot encode a key pair that holds handles: a `CryptoKey` has " +
              "no JSON representation.",
          );
        }

        return {
          algorithm: value.#algorithm,
          publicKey: toUnpaddedBase64url(value.publicKeyBytes.slice()),
          privateKey: toUnpaddedBase64url(value.privateKeyBytes.slice()),
        };
      }

      /** @inheritDoc */
      canDecode(state: FabricValue): state is FabricKeyPairMaterialState {
        return isPlainObject(state) &&
          (typeof state.algorithm === "string") &&
          (typeof state.publicKey === "string") &&
          (typeof state.privateKey === "string");
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricKeyPairMaterialState,
        _env: LiveEnvironment,
      ): FabricValue {
        const { algorithm, publicKey, privateKey } = state;

        try {
          return new FabricKeyPair(
            algorithm,
            new FabricBytes(fromBase64url(publicKey), true),
            new FabricBytes(fromBase64url(privateKey), true),
          );
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `KeyPair: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class KeyPairCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.KeyPair, FabricKeyPair);
      }

      /**
       * @inheritDoc
       *
       * Each state names its arm by shape: a `CryptoKey` in the key slots for
       * handles, an `ArrayBuffer` and an algorithm for material.
       */
      encode(value: FabricKeyPair): RealmCodecValue {
        if (!value.hasMaterial) {
          return {
            publicKey: value.#publicKey as CryptoKey,
            privateKey: value.#privateKey as CryptoKey,
          };
        }

        return {
          algorithm: value.#algorithm,
          publicKey: value.publicKeyBytes.sliceBuffer(),
          privateKey: value.privateKeyBytes.sliceBuffer(),
        };
      }

      /** @inheritDoc */
      canDecode(
        state: RealmCodecValue,
      ): state is RealmMaterialState | RealmHandleState {
        if (!isPlainObject(state)) {
          return false;
        }

        const { algorithm, publicKey, privateKey } = state as {
          algorithm?: unknown;
          publicKey?: unknown;
          privateKey?: unknown;
        };

        if (isCryptoKey(publicKey) && isCryptoKey(privateKey)) {
          return algorithm === undefined;
        }

        // Non-empty, which is the one thing the constructor refuses about an
        // algorithm name. Left to `decode()` it would arrive as a constructor
        // throw, which that method reports as a detached buffer -- the only
        // other way its construction can fail.
        return (typeof algorithm === "string") && (algorithm !== "") &&
          (publicKey instanceof ArrayBuffer) &&
          (privateKey instanceof ArrayBuffer);
      }

      /**
       * @inheritDoc
       *
       * A detached buffer throws rather than being reported, as on
       * `FabricHash`: it is a well-formed state this tree already spent.
       */
      decode(
        _typeTag: string,
        state: RealmMaterialState | RealmHandleState,
        _env: LiveEnvironment,
      ): FabricValue {
        if (isCryptoKey(state.publicKey)) {
          return new FabricKeyPair(state as RealmHandleState);
        }

        const { algorithm, publicKey, privateKey } =
          state as RealmMaterialState;

        // Taken over rather than copied, as `FabricBytes` does: each buffer
        // arrived either by being cloned, making it this realm's own, or by
        // being transferred, which detached the sender's.
        try {
          return new FabricKeyPair(
            algorithm,
            new FabricBytes(new Uint8Array(publicKey), true),
            new FabricBytes(new Uint8Array(privateKey), true),
          );
        } catch (e) {
          throw new Error(
            "The state's buffer is detached, this tree having been decoded " +
              "already.",
            { cause: e },
          );
        }
      }
    })(),
  );

  /**
   * The codec for instances of this class.
   *
   * Nonterminal: the state is three strings, each a `FabricValue` the walker
   * expands in turn.
   */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, and it is the keys that make it so rather than the record around
   * them: a `CryptoKey` and an `ArrayBuffer` are both in this format's domain
   * and neither is a `FabricValue`, so a state holding either has no
   * nonterminal reading.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }

  /**
   * Returns the given key pair's two keys, checked as a public/private pair
   * whose `algorithm` records agree in full, parameters included.
   *
   * The check does not establish that the two keys are counterparts, which no
   * synchronous check can: two independently generated keys of the same
   * algorithm and parameters are indistinguishable from a genuine pair by
   * anything but a sign/verify round trip, which is asynchronous. What it
   * establishes is that they *could* be counterparts.
   */
  static #validPair(pair: CryptoKeyPair): CryptoKeyPair {
    if (!isCryptoKeyPair(pair)) {
      throw new Error("Not a `CryptoKeyPair`: both keys must be `CryptoKey`s.");
    }

    const { publicKey, privateKey } = pair;

    if ((publicKey.type !== "public") || (privateKey.type !== "private")) {
      throw new Error(
        `Not a key pair: keys are of type ${
          backtickQuote(publicKey.type)
        } and ${backtickQuote(privateKey.type)}.`,
      );
    } else if (publicKey.algorithm.name !== privateKey.algorithm.name) {
      throw new Error(
        `Mismatched algorithms: ${
          backtickQuote(publicKey.algorithm.name)
        } and ${backtickQuote(privateKey.algorithm.name)}.`,
      );
    } else if (!deepEqual(publicKey.algorithm, privateKey.algorithm)) {
      // The whole record rather than a per-algorithm list of the parameters
      // that matter: a genuine pair reports the same `algorithm` on both keys
      // for every algorithm Web Crypto defines, so nothing here has to know
      // which fields a given one carries, and an algorithm added later is
      // covered as it stands.
      throw new Error(
        `Mismatched ${
          backtickQuote(publicKey.algorithm.name)
        } algorithm parameters between the two keys.`,
      );
    }

    return { publicKey, privateKey };
  }

  /**
   * Returns the given key bytes as a `FabricBytes`, copying a `Uint8Array`. The
   * `instanceof` is the real admission test: the declared parameter is the api
   * package's structural `FabricBytes`, and only this class's own is accepted.
   */
  static #toFabricBytes(
    bytes: ApiFabricBytes | Uint8Array | undefined,
    name: string,
  ): FabricBytes {
    if (bytes instanceof FabricBytes) {
      return bytes;
    } else if (bytes instanceof Uint8Array) {
      return new FabricBytes(bytes);
    }

    throw new Error(
      `Not key material: ${
        backtickQuote(name)
      } must be a \`FabricBytes\` or a ` +
        "`Uint8Array`.",
    );
  }
}

// Compile-time check that the exported `FabricKeyPair` constructor matches the
// `FabricKeyPairConstructor` declared in `@commonfabric/api`. This catches
// drift between the public type contract and this implementation.
FabricKeyPair satisfies ApiFabricKeyPairConstructor;
