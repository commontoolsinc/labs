import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import type { Signer as IdentitySigner } from "@commonfabric/identity";
import type { ClientCommit } from "./v2.ts";

export type {
  AsBytes,
  AuthorizationError,
  Principal,
  Signature,
  Verifier,
} from "@commonfabric/identity";

/**
 * The signing half of the principal contract as the memory protocol uses it:
 * an {@link IdentitySigner} without the `serialize()` method that hands back
 * raw key material.
 */
export type Signer<ID extends DID = DID> = Omit<
  IdentitySigner<ID>,
  "serialize"
>;

export type AsString<T> = string & {
  valueOf(): AsString<T>;
};

/**
 * Unique identifier for the memory space.
 */
export type MemorySpace = `did:${string}:${string}`;

/**
 * Unique identifier for the mutable entity.
 */
export type Entity = URI;

/**
 * Type of the fact, usually formatted as media type. By default we expect
 * this to be  "application/json", but in the future we may support other
 * data types.
 */
export type The = MIME;

/**
 * Describes not yet claimed memory. It describes a lack of fact about memory.
 */
export type Unclaimed<T extends string = MIME, Of extends string = URI> = {
  /**
   * Type of the fact, usually formatted as media type. By default we expect
   * this to be  "application/json", but in the future we may support other
   * data types.
   */
  the: T;

  /**
   * Stable memory identifier that uniquely identifies it.
   */
  of: Of;

  is?: undefined;
  cause?: undefined;
};

/**
 * Asserts a fact: the value MUST be an inline {@link FabricValue} as opposed to
 * a reference to one.
 */
export type Assertion<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = {
  the: T;
  of: Of;
  is: Is;
  cause: FabricHash;
};

/**
 * Represents retracted {@link Assertion}. It is effectively a tombstone
 * denoting assertion that no longer hold and is a fact in itself.
 */
export type Retraction<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = {
  the: T;
  of: Of;
  is?: undefined;
  cause: FabricHash;
};

export type Invariant<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = {
  the: T;
  of: Of;
  fact: FabricHash;

  is?: undefined;
  cause?: undefined;
};

/**
 * Facts represent a memory in the replica. They are either current and
 * represented as {@link Assertion} or since retracted and therefor represented
 * by {@link Retraction}.
 */
export type Fact<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = Assertion<T, Of, Is> | Retraction<T, Of, Is>;

export type State = Fact | Unclaimed;

export type Revision<T = Unit> = T & { since: number };

export type DID = `did:${string}:${string}`;

export type DIDKey = `did:key:${string}`;

export type ANYONE = "*";

export type ACLUser = DID | ANYONE;

/**
 * Capability levels for space access control.
 * - READ: Can query and read data from the space
 * - WRITE: Can read and transact (write) data to the space
 * - OWNER: Full control including ACL management
 */
export type Capability = "READ" | "WRITE" | "OWNER";

/**
 * Access Control List entry mapping DIDs to their capabilities
 */
export type ACL = {
  [user in ACLUser]?: Capability;
};

// Entity identifier (typically `of:<base32-digest>`, but sometimes `did:<something>`).
export type URI = `${string}:${string}`;
// Mime type or Media Type -- often called 'the'
export type MIME = `${string}/${string}`;

export type Unit = NonNullable<unknown>;

export type AsyncResult<T extends Unit = Unit, E extends Error = Error> =
  Promise<Result<T, E>>;

export type Await<T> = PromiseLike<T> | T;

export type AwaitResult<T extends Unit = Unit, E extends Error = Error> = Await<
  Result<T, E>
>;

export type Result<T extends Unit = Unit, E extends Error = Error> =
  | Ok<T>
  | Fail<E>;

export type Ok<T extends Unit> = {
  ok: T;
  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  error?: undefined;
};

export type Fail<E extends Error> = {
  error: E;
  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  ok?: undefined;
};

export type Conflict = {
  /**
   * Identifier of the replica where conflict occurred.
   */
  space: MemorySpace;

  /**
   * Type of the fact where a conflict occurred.
   */
  the: The;

  /**
   * Identifier of the entity where conflict occurred.
   */
  of: Entity;

  /**
   * Expected state in the replica.
   */
  expected: FabricHash | null;

  /**
   * Actual memory state in the replica repository.
   */
  actual: Revision<Fact> | null;

  /**
   * Whether the fact exists in the history of the entity.
   */
  existsInHistory: boolean;

  /**
   * Actual history
   */
  history: Revision<Fact>[];
};

export interface ConflictError extends Error {
  name: "ConflictError";

  /** The commit that was rejected. */
  transaction: ClientCommit;
  conflict: Conflict;
  retryAfterSeq?: number;
  readyToRetry?: () => Promise<void>;
}

export interface SystemError extends Error {
  code: number;
}

export interface ConnectionError extends Error {
  name: "ConnectionError";
  cause: SystemError;
  address: string;
}

/**
 * Error from the underlying storage.
 */
export interface TransactionError extends Error {
  name: "TransactionError";
  cause: SystemError;
  /**
   * The commit being stored when the error occurred.
   */
  transaction: ClientCommit;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;

  space: MemorySpace;
  selector: SchemaPathSelector;
}

/**
 * Utility type for defining a [keyed union] type as in IPLD Schema. In practice
 * this just works around typescript limitation that requires discriminant field
 * on all variants.
 *
 * ```ts
 * type Result<T, X> =
 *   | { ok: T }
 *   | { error: X }
 *
 * const demo = (result: Result<string, Error>) => {
 *   if (result.ok) {
 *   //  ^^^^^^^^^ Property 'ok' does not exist on type '{ error: Error; }`
 *   }
 * }
 * ```
 *
 * Using `Variant` type we can define same union type that works as expected:
 *
 * ```ts
 * type Result<T, X> = Variant<{
 *   ok: T
 *   error: X
 * }>
 *
 * const demo = (result: Result<string, Error>) => {
 *   if (result.ok) {
 *     result.ok.toUpperCase()
 *   }
 * }
 * ```
 *
 * [keyed union]:https://ipld.io/docs/schemas/features/representation-strategies/#union-keyed-representation
 */
export type Variant<U extends Record<string, unknown>> = {
  [Key in keyof U]:
    & { [K in Exclude<keyof U, Key>]?: never }
    & {
      [K in Key]: U[Key];
    };
}[keyof U];
