import type { FabricValue } from "@commonfabric/api";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";

import type { SchemaPathSelector } from "@commonfabric/api";
export type { SchemaPathSelector };

export type { FabricValue };

/**
 * Some principal identified via DID identifier.
 */
export interface Principal<ID extends DID = DID> {
  did(): ID;
}

export interface Verifier<ID extends DID = DID> extends Principal<ID> {
  verify(authorization: {
    payload: Uint8Array;
    signature: Uint8Array;
  }): AwaitResult<Unit, AuthorizationError>;
}

export interface Signer<ID extends DID = DID> extends Principal<ID> {
  sign<T>(payload: AsBytes<T>): AwaitResult<Signature<T>, Error>;

  verifier: Verifier<ID>;
}

export interface AsBytes<T> extends Uint8Array {
  valueOf(): this & AsBytes<T>;
}

export type AsString<T> = string & {
  valueOf(): AsString<T>;
};

export interface Signature<Payload> extends Uint8Array {
  valueOf(): this & Signature<Payload>;
}

export type UCAN<Command extends Invocation> = {
  invocation: Command;
  authorization: Authorization<Command>;
};

/**
 * Proof of authorization for a given access.
 */
export interface Proof<Access extends FabricValue = FabricValue> {
  [link: AsString<FabricHash>]: Unit;
}

/**
 * Represents a verifiable authorization issued by specific {@link Authority}.
 * It is slightly more abstract notion than signed payload.
 */
export type Authorization<T extends FabricValue = FabricValue> = {
  signature: Signature<Proof<T>>;
  access: Proof<T>;
};

export interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

export type Command<
  Ability extends string = The,
  Of extends DID = DID,
  In extends NonNullable<unknown> = NonNullable<unknown>,
> = {
  cmd: Ability;
  sub: Of;
  args: In;
  meta?: Meta;
  nonce?: Uint8Array;
};

export type Invocation<
  Ability extends string = The,
  Of extends DID = DID,
  In extends NonNullable<unknown> = NonNullable<unknown>,
> = {
  iss: DID;
  aud?: DID;
  cmd: Ability;
  sub: Of;
  args: In;
  meta?: Meta;
  nonce?: Uint8Array;
  exp?: UTCUnixTimestampInSeconds;
  iat?: UTCUnixTimestampInSeconds;
  prf: Delegation[];
  cause?: void;
};

/**
 * In the future this will be a delegation chain, but for now we do not support
 * delegation so it is empty chain implying issuer must be a subject.,
 */
export type Delegation = never;

export type UTCUnixTimestampInSeconds = number;

export type Protocol<Space extends MemorySpace = MemorySpace> = {
  [Subject in Space]: {
    memory: {
      transact(source: {
        changes: Changes;
      }): Task<
        Result<
          Commit<Space>,
          | AuthorizationError
          | ConflictError
          | TransactionError
          | ConnectionError
        >
      >;
      query: {
        (query: { select: Selector; since?: number }): Task<
          Result<Selection<Space>, AuthorizationError | QueryError>,
          Selection<Space>
        >;
        subscribe(
          source: Subscribe<Space>["args"],
        ): Task<
          Result<Unit, SystemError | AuthorizationError>,
          EnhancedCommit<Space>
        >;
        unsubscribe(
          source: Unsubscribe<Space>["args"],
        ): Task<Result<Unit, SystemError | AuthorizationError>>;
      };
      graph: {
        query(
          schemaQuery: {
            selectSchema: SchemaSelector;
            since?: number;
            subscribe?: boolean;
            excludeSent?: boolean;
          },
        ): Task<
          Result<Selection<Space>, AuthorizationError | QueryError>,
          Selection<Space>
        >;
      };
    };
  };
};

export type Proto = {
  [Subject: DID]: {
    [Namespace: string]: NonNullable<unknown>;
  };
};

export type InferProtocol<Protocol extends Proto> = UnionToIntersection<
  InferProtoMethods<Protocol>
>;
export type Abilities<Protocol extends Proto> = keyof InferProtocol<Protocol>;
export type InferProtoMethods<
  Protocol extends Proto,
  Methods = Protocol[keyof Protocol],
  Prefix extends string = "",
> = {
  [Name in keyof Methods & string]: Methods[Name] extends (
    input: infer In extends NonNullable<unknown>,
  ) => Task<infer Out extends NonNullable<unknown>, infer Effect> ?
      | {
        [The in `${Prefix}/${Name}`]: Method<
          Protocol,
          `${Prefix}/${Name}`,
          In,
          Awaited<Out>,
          Effect
        >;
      }
      | InferProtoMethods<Protocol, Methods[Name], `${Prefix}/${Name}`>
    : Methods[Name] extends object
      ? InferProtoMethods<Protocol, Methods[Name], `${Prefix}/${Name}`>
    : never;
}[keyof Methods & string];

export type Method<
  Protocol,
  Ability extends The,
  In extends NonNullable<unknown>,
  Out extends NonNullable<unknown>,
  Effect,
> = {
  The: Ability;
  Protocol: Protocol;
  Of: InferOf<Protocol>;
  In: In;
  Out: Out;
  Effect: Effect;
  Method: (input: In) => Task<Out, Effect>;
  ConsumerCommand: {
    cmd: Ability;
    // sub: InferOf<Protocol> & MemorySpace;
    sub: MemorySpace;
    args: In;
    meta?: Meta;
    nonce?: Uint8Array;
  };
  ConsumerInvocation: Invocation<Ability, InferOf<Protocol>, In>;
  ProviderCommand: Receipt<
    Invocation<Ability, InferOf<Protocol>, In>,
    Out,
    Effect
  >;
  Invocation: InvocationView<
    Invocation<Ability, InferOf<Protocol>, In>,
    Out,
    Effect
  >;
  Pending: {
    return(result: Out): boolean;
    perform(effect: Effect): void;
  };
};

export type InferOf<T> = keyof T extends DID ? keyof T : never;

/**
 * Utility type that takes union type `U` and produces intersection type of it's members.
 */
// Can `U extends any` ever be falsy?
// FIXME: typing
// deno-lint-ignore no-explicit-any
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends
  (k: infer I) => void ? I
  : never;

export type ProviderCommand<Protocol extends Proto> =
  ProtocolMethod<Protocol> extends {
    ProviderCommand: Receipt<infer Command, infer Result, infer Effect>;
  } ? Receipt<Command, Result, Effect>
    : never;

export type ProtocolMethod<Protocol extends Proto> = InferProtocol<
  Protocol
>[Abilities<Protocol>];

export type ConsumerCommand<Protocol extends Proto> =
  ProtocolMethod<Protocol> extends {
    ConsumerCommand: Command<infer Ability, infer Of, infer In>;
  } ? Command<Ability, Of, In>
    : never;

export type ConsumerCommandInvocation<
  Protocol extends Proto,
  Method = ProtocolMethod<Protocol>,
> = Method extends {
  ConsumerInvocation: Invocation;
} ? Method["ConsumerInvocation"]
  : never;

export interface InvocationView<
  Source extends Invocation,
  Return extends NonNullable<unknown>,
  Effect,
> extends Invocation<Source["cmd"], Source["sub"], Source["args"]> {
  // Return false to remove listener
  return(result: Await<Return>): boolean;
  perform(effect: Effect): void;

  toJSON(): Source;
}

export type Task<Return, Command = never> = Iterable<Command, Return>;

export type Receipt<
  Command extends NonNullable<unknown>,
  Result extends FabricValue,
  Effect,
> =
  | {
    the: "task/return";
    of: InvocationURL<FabricHash>;
    is: Awaited<Result>;
  }
  | (Effect extends never ? never
    : {
      the: "task/effect";
      of: InvocationURL<FabricHash>;
      is: Effect;
    });

export type Effect<Of extends NonNullable<unknown>, Command> = {
  of: FabricHash;
  run: Command;
  is?: undefined;
};

export type Return<
  Of extends NonNullable<unknown>,
  Result extends FabricValue,
> = {
  of: FabricHash;
  is: Result;
  run?: undefined;
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

export type InvocationURL<T> = `job:${string}` & {
  toString(): InvocationURL<T>;
};

/**
 * Describes not yet claimed memory. It describes a lack of fact about memory.
 */
export interface Unclaimed<T extends string = MIME, Of extends string = URI> {
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
}

/**
 * Asserts a fact: the value MUST be an inline {@link FabricValue} as opposed to
 * a reference to one.
 */
export interface Assertion<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> {
  the: T;
  of: Of;
  is: Is;
  cause: FabricHash;
}

/**
 * Represents retracted {@link Assertion}. It is effectively a tombstone
 * denoting assertion that no longer hold and is a fact in itself.
 */
export interface Retraction<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> {
  the: T;
  of: Of;
  is?: undefined;
  cause: FabricHash;
}

export interface Invariant<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> {
  the: T;
  of: Of;
  fact: FabricHash;

  is?: undefined;
  cause?: undefined;
}

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

// This is essentially an OfTheCause tree with one special record whose value is another OfTheCause tree.
export type Commit<Subject extends string = MemorySpace> = {
  [of in Subject]: {
    ["application/commit+json"]: {
      [cause in CauseString]: {
        is: CommitData;
      };
    };
  };
};

export type EnhancedCommit<Subject extends string = MemorySpace> = {
  revisions: Revision<State>[];
  commit: Commit<Subject>;
};

export type CommitData = {
  since: number;
  transaction: Transaction;
};

// This allows a consumer to check that their entities match the current cause
// state before making local changes that would be discarded on conflict.
export type ClaimFact = true;

// ⚠️ Note we use `void` as opposed to `undefined` because the latter makes it
// incompatible with the `Is` type parameter (which defaults to `FabricValue`).
export type RetractFact = { is?: void };
export type AssertFact<Is extends FabricValue = FabricValue> = { is: Is };

export type Changes<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = {
  [of in Of]: {
    [the in T]: {
      [cause in CauseString]: RetractFact | AssertFact<Is> | ClaimFact;
    };
  };
};

export type FactSelection<
  T extends string = MIME,
  Of extends string = URI,
  Is extends FabricValue = FabricValue,
> = {
  [of in Of]: {
    [the in T]: {
      [cause in CauseString]: {
        is?: Is;
        since: number;
      };
    };
  };
};

export type Meta = Record<string, string>;

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
// Fact cause. Matches the content hash string format defined by `data-model`.
export type CauseString = `fid1:${string}`;

export type Transaction<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/transact",
  Space,
  { changes: Changes }
>;

export type QueryArgs = { select: Selector; since?: number };

export type Query<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/query",
  Space,
  QueryArgs
>;

export type Subscribe<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/query/subscribe",
  Space,
  | { select: Selector; since?: number }
  | { selectSchema: SchemaSelector; since?: number }
>;

export type Unsubscribe<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/query/unsubscribe",
  Space,
  { source: InvocationURL<FabricHash> }
>;

export type SchemaQueryArgs = {
  selectSchema: SchemaSelector;
  since?: number;
  subscribe?: boolean; // set to true to be notified of changes to any reachable entities
  excludeSent?: boolean; // set to true to remove entities already sent in this session
  classification?: string[]; // classifications to claim for access
};

export type SchemaQuery<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/graph/query",
  Space,
  SchemaQueryArgs
>;

// A normal Selector looks like this (with _ as wildcard cause):
// {
//   "of:ba4jcbvpq3k5sooggkwwosy6sqd3fhr5md7hroyf3bq3vrambqm4xkkus": {
//     "application/json": {
//       _: {
//         is: {}
//       }
//     }
//   }
// }

// A SchemaSelector looks like this (with _ as wildcard cause):
// {
//   "of:ba4jcbvpq3k5sooggkwwosy6sqd3fhr5md7hroyf3bq3vrambqm4xkkus": {
//     "application/json": {
//       _: {
//         path: [],
//         schema: { "type": "object" },
//       }
//     }
//   }
// }

// The SchemaPathSelector objects contained by the SchemaSelector have their
// path relative to fact.is.value, unlike standard SchemaPathSelectors.
export type SchemaSelector = Select<
  URI,
  Select<MIME, Select<CauseString, SchemaPathSelector>>
>;

export type Select<Key extends string, Match> =
  & {
    [key in Key]: Match;
  }
  & {
    _?: Match;
  };

/**
 * Selector that replica can be queried by.
 */
export type Selector = Select<
  URI,
  Select<MIME, Select<CauseString, { is?: Unit }>>
>;

export type Selection<Space extends MemorySpace = MemorySpace> = {
  [space in Space]: FactSelection;
};

export type Unit = NonNullable<unknown>;

/**
 * Generic type used to annotate underlying type with a context of the replica.
 */
export type In<T> = { [For: MemorySpace]: T };

export type AsyncResult<T extends Unit = Unit, E extends Error = Error> =
  Promise<Result<T, E>>;

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

  transaction: Transaction;
  conflict: Conflict;
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
   * Fact being stored when the error occurred.
   */
  transaction: Transaction;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;

  space: MemorySpace;
  selector: Selector | SchemaSelector;
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
