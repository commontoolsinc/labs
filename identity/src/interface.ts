export type DID = `did:${string}:${string}`;
export type DIDKey = `did:key:${string}`;

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

export type InsecureCryptoKeyPair = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export type KeyPairRaw = CryptoKeyPair | InsecureCryptoKeyPair;

export function isCryptoKeyPair(input: any): input is CryptoKeyPair {
  return !!(
    globalThis.CryptoKey &&
    typeof input === "object" &&
    input.privateKey instanceof globalThis.CryptoKey &&
    input.publicKey instanceof globalThis.CryptoKey
  );
}

export function isInsecureCryptoKeyPair(input: any): input is CryptoKeyPair {
  return !!(
    typeof input === "object" &&
    input.privateKey instanceof Uint8Array &&
    input.publicKey instanceof Uint8Array
  );
}
