import { isObjectOrArray } from "@commonfabric/utils/types";

export type DID = `did:${string}:${string}`;
export type DIDKey = `did:key:${string}`;
export function isDID(input: unknown): input is DID {
  // minimum string of `did:x:y`
  if (
    typeof input === "string" &&
    input.length >= 7
  ) {
    const secondColon = input.indexOf(":", 4);
    return input.startsWith("did:") &&
      // has second colon
      secondColon !== -1 &&
      // does not have a third colon
      input.indexOf(":", secondColon + 1) === -1;
  }
  return false;
}

/**
 * Some principal identified via DID identifier.
 */
export interface Principal<ID extends DID = DID> {
  did(): ID;
}

/**
 * This is just byte array that captures data type it encodes as a phantom type,
 * this allows decoder to infer what the type of the decoded value will be.
 */
export interface AsBytes<T> extends Uint8Array {
  valueOf(): this & AsBytes<T>;
}

/**
 * Represents signed payload as a byte array. Captures type of the the payload
 * to allow TS infer it.
 */
export interface Signature<Payload> extends Uint8Array {
  valueOf(): this & Signature<Payload>;
}

export type Unit = NonNullable<unknown>;

export type Await<T> = PromiseLike<T> | T;
export type AwaitResult<T extends Unit = Unit, E extends Error = Error> = Await<
  Result<T, E>
>;

export type Result<T extends Unit = Unit, E extends Error = Error> =
  | Ok<T>
  | Fail<E>;

export interface Ok<T extends Unit> {
  ok: T;
  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  error?: undefined;
}

export interface Fail<E extends Error> {
  error: E;
  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  ok?: undefined;
}

export interface Signer<ID extends DID = DID> extends Principal<ID> {
  sign<T>(payload: AsBytes<T>): AwaitResult<Signature<T>, Error>;

  verifier: Verifier<ID>;

  /**
   * Returns this signer's key material in a form no holder can use to reach or
   * alter this signer. Callers may rely on that rather than defending
   * themselves.
   *
   * Note what is _not_ promised: that two calls return different values. The
   * requirement is unreachability, and the two key forms meet it by different
   * means. A `CryptoKeyPair` carries opaque platform keys with no reachable
   * material, so one frozen pair can serve every call. An
   * `InsecureCryptoKeyPair` carries the raw private key -- the signing secret
   * itself -- and freezing does not reach `ArrayBuffer` contents, so its arrays
   * must instead be freshly allocated per call, and a caller mutating what it
   * receives harms only itself.
   *
   * The result is plain by design: a value of this shape travels as an IPC
   * payload, and structured cloning does not preserve a class.
   */
  serialize(): KeyPairRaw;
}

export interface Verifier<ID extends DID = DID> extends Principal<ID> {
  verify(authorization: {
    payload: Uint8Array;
    signature: Uint8Array;
  }): AwaitResult<Unit, AuthorizationError>;
}

export interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

/**
 * Raw ed25519 key material. Deliberately plain arrays rather than a richer
 * byte type: a value of this shape crosses worker boundaries as an IPC
 * payload, and structured cloning does not preserve a class.
 *
 * TODO(danfuzz): Change these properties to `FabricBytes` once `codec-realm`
 * exists and is used to carry this across that boundary. The bytes would then
 * be immutable end to end, instead of only within a signer.
 */
export type InsecureCryptoKeyPair = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export type TransferrableInsecureCryptoKeyPair = {
  privateKey: Array<number>;
  publicKey: Array<number>;
};

export type KeyPairRaw = CryptoKeyPair | InsecureCryptoKeyPair;

export function isCryptoKeyPair(input: unknown): input is CryptoKeyPair {
  return !!(
    globalThis.CryptoKey &&
    isObjectOrArray(input) &&
    input.privateKey instanceof globalThis.CryptoKey &&
    input.publicKey instanceof globalThis.CryptoKey
  );
}

export function isInsecureCryptoKeyPair(
  input: unknown,
): input is InsecureCryptoKeyPair {
  return !!(
    isObjectOrArray(input) &&
    input.privateKey instanceof Uint8Array &&
    input.publicKey instanceof Uint8Array
  );
}

export function isKeyPairRaw(value: unknown): value is KeyPairRaw {
  return isCryptoKeyPair(value) || isInsecureCryptoKeyPair(value);
}

export function serializeKeyPairRaw(
  keyPairRaw: KeyPairRaw,
): TransferrableInsecureCryptoKeyPair | null {
  return isInsecureCryptoKeyPair(keyPairRaw)
    ? {
      privateKey: Array.from(keyPairRaw.privateKey),
      publicKey: Array.from(keyPairRaw.publicKey),
    }
    : null;
}

export function deserializeKeyPairRaw(
  transferrable: TransferrableInsecureCryptoKeyPair,
): InsecureCryptoKeyPair {
  return {
    privateKey: Uint8Array.from(transferrable.privateKey),
    publicKey: Uint8Array.from(transferrable.publicKey),
  };
}
