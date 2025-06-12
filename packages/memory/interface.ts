import type { Reference } from "merkle-reference";
import { JSONValue, SchemaContext } from "@commontools/builder";
import { SchemaPathSelector } from "@commontools/builder/traverse";

export type { Reference, SchemaPathSelector };

export interface Clock {
  now(): UTCUnixTimestampInSeconds;
}

export type SubscriberCommand = {
  watch?: Query;
  unwatch?: Query;
};

/**
 * Some principal identified via DID identifier.
 */
export interface Principal<ID extends DID = DID> {
  did(): ID;
}

/**
 * Principal capable of issuing an {@link Authorization}.
 */
export interface Authority extends Principal {
  authorize<T extends JSONValue>(
    access: Iterable<Reference<T> | T>,
  ): AwaitResult<Authorization<T>, AuthorizationError>;
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
export interface Proof<Access extends JSONValue> {
  [link: AsString<Reference<Access>>]: Unit;
}

/**
 * Represents a verifiable authorization issued by specific {@link Authority}.
 * It is slightly more abstract notion than signed payload.
 */
export type Authorization<T extends JSONValue = JSONValue> = {
  signature: Signature<Proof<T>>;
  access: Proof<T>;
};

export interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

export type Call<
  Ability extends The = The,
  Of extends DID = DID,
  Args extends NonNullable<unknown> = NonNullable<unknown>,
> = {
  cmd: Ability;
  sub: Of;
  args: Command;
  nonce?: Uint8Array;
};

export type Command<
  Ability extends The = The,
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
  Ability extends The = The,
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
export type Seconds = number;

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
          Commit<Space>
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
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends
  (k: infer I) => void ? I
  : never;

export type Provider<Protocol extends NonNullable<unknown>> = {
  perform(command: ProviderCommand<Protocol>): AwaitResult<Unit, SystemError>;
};

export interface ConsumerSession<TheProtocol extends Proto>
  extends
    TransformStream<
      ProviderCommand<Protocol>,
      UCAN<ConsumerCommandInvocation<Protocol>>
    > {
}

export interface ProviderChannel<Protocol extends Proto>
  extends
    TransformStream<
      UCAN<ConsumerCommandInvocation<Protocol>>,
      ProviderCommand<Protocol>
    > {
}
export interface ProviderSession<Protocol extends Proto>
  extends ProviderChannel<Protocol> {
  close(): CloseResult;
}

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

export type ConsumerCommandFor<Ability, Protocol extends Proto> =
  & MethodFor<
    Ability,
    Protocol
  >["ConsumerCommand"]
  & { cmd: Ability };

export type ProviderCommandFor<Ability, Protocol extends Proto> = MethodFor<
  Ability,
  Protocol
>["ProviderCommand"];

export type ConsumerInvocationFor<Ability, Protocol extends Proto> =
  & MethodFor<
    Ability,
    Protocol
  >["ConsumerInvocation"]
  & { cmd: Ability };

export type ConsumerInputFor<Ability, Protocol extends Proto> = MethodFor<
  Ability,
  Protocol
>["In"];

export type ConsumerEffectFor<Ability, Protocol extends Proto> = MethodFor<
  Ability,
  Protocol
>["Effect"];

export type ConsumerSpaceFor<Ability, Protocol extends Proto> = MethodFor<
  Ability,
  Protocol
>["Of"];

export type MethodFor<
  Ability,
  Protocol extends Proto,
  Case = ProtocolMethod<Protocol>,
> = Case extends
  Method<Protocol, Ability & The, infer In, infer Out, infer Effect>
  ? Method<Protocol, Ability & The, In, Out, Effect>
  : never;

export type ConsumerResultFor<Ability, Protocol extends Proto> = MethodFor<
  Ability,
  Protocol
>["Out"];

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

export type Job<
  Command extends NonNullable<unknown> = NonNullable<unknown>,
  Return extends NonNullable<unknown> | null = NonNullable<unknown> | null,
  Effect = unknown,
> = {
  invoke: Command;
  return: Return;
  effect: Effect;
};

export type WatchTask<Space extends MemorySpace> = Job<
  { watch: Query<Space>; unwatch?: undefined },
  QueryResult<Space>,
  Transaction<Space>
>;

export type UnwatchTask<Space extends MemorySpace> = Job<
  { unwatch: Query<Space>; watch?: undefined },
  Unit,
  never
>;

export type SessionTask<Space extends MemorySpace> =
  | UnwatchTask<Space>
  | WatchTask<Space>;

export type Receipt<
  Command extends NonNullable<unknown>,
  Result extends NonNullable<unknown> | null,
  Effect,
> =
  | {
    the: "task/return";
    of: InvocationURL<Reference<Command>>;
    is: Awaited<Result>;
  }
  | (Effect extends never ? never
    : {
      the: "task/effect";
      of: InvocationURL<Reference<Command>>;
      is: Effect;
    });

export type Effect<Of extends NonNullable<unknown>, Command> = {
  of: Reference<Of>;
  run: Command;
  is?: undefined;
};

export type Return<
  Of extends NonNullable<unknown>,
  Result extends NonNullable<unknown> | null,
> = {
  of: Reference<Of>;
  is: Result;
  run?: undefined;
};

export type SubscriptionCommand<Space extends MemorySpace = MemorySpace> = {
  transact?: Transaction<Space>;
  brief?: Brief<Space>;
};

export type Brief<Space extends MemorySpace = MemorySpace> = {
  sub: Space;
  args: {
    selector: Selector;
    selection: Selection<Space>;
  };
  meta?: Meta;
};

export interface Session<Space extends MemorySpace = MemorySpace> {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact(transact: Transaction<Space>): TransactionResult<Space>;

  /**
   * Queries space for matching entities based on provided selector.
   */
  query(source: Query<Space>): QueryResult<Space>;

  /**
   * Queries space for matching entities based on provided selector.
   */
  querySchema(source: SchemaQuery<Space>): QueryResult<Space>;

  close(): CloseResult;
}

export interface SpaceSession<Space extends MemorySpace = MemorySpace>
  extends Session {
  subject: Space;

  transact(
    transact: Transaction<Space>,
  ): Result<Commit<Space>, ConflictError | TransactionError>;
  query(source: Query<Space>): Result<Selection<Space>, QueryError>;
  close(): Result<Unit, SystemError>;
}

export interface MemorySession<Space extends MemorySpace = MemorySpace>
  extends Session<Space> {
  subscribe(subscriber: Subscriber<Space>): SubscribeResult;
  unsubscribe(subscriber: Subscriber<Space>): SubscribeResult;
  serviceDid(): DID;
}

export interface Subscriber<Space extends MemorySpace = MemorySpace> {
  commit(commit: Commit<Space>): AwaitResult<Unit, SystemError>;
  close(): AwaitResult<Unit, SystemError>;
}

export type SubscribeResult = AwaitResult<Unit, SystemError>;

/**
 * Represents a subscription controller that can be used to publish commands or
 * to close subscription.
 */
export interface SubscriptionController {
  open: boolean;
  close(): void;
  transact(source: Transaction): void;
  brief(source: Brief): void;
}

/**
 * Unique identifier for the memory space.
 */
export type MemorySpace = `did:${string}:${string}`;

/**
 * Unique identifier for the mutable entity.
 */
export type Entity = `${string}:${string}`;

/**
 * Type of the fact, usually formatted as media type. By default we expect
 * this to be  "application/json", but in the future we may support other
 * data types.
 */
export type The = string & { toString(): The };

export type Cause<T = Assertion | Retraction | Unclaimed> = string & {
  toString(): Cause<T>;
};

export type InvocationURL<T> = `job:${string}` & {
  toString(): InvocationURL<T>;
};

export interface FactAddress {
  the: The;
  of: Entity;
}

/**
 * Describes not yet claimed memory. It describes a lack of fact about memory.
 */
export interface Unclaimed<T extends The = The, Of extends Entity = Entity> {
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
 * `Assertion` is just like a {@link Statement} except the value MUST be inline
 * {@link JSONValue} as opposed to reference to one. {@link Assertion}s are used
 * to assert facts, wile {@link Statement}s are used to retract them. This allows
 * retracting over the wire without having to sending JSON values back and forth.
 */
export interface Assertion<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> {
  the: T;
  of: Of;
  is: Is;
  cause:
    | Reference<Assertion<T, Of, Is>>
    | Reference<Retraction<T, Of, Is>>
    | Reference<Unclaimed<T, Of>>;
}

/**
 * Represents retracted {@link Assertion}. It is effectively a tombstone
 * denoting assertion that no longer hold and is a fact in itself.
 */
export interface Retraction<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> {
  the: T;
  of: Of;
  is?: undefined;
  cause: Reference<Assertion<T, Of, Is>>;
}

export interface Invariant<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> {
  the: T;
  of: Of;
  fact: Reference<Fact<T, Of, Is>>;

  is?: undefined;
  cause?: undefined;
}

/**
 * Facts represent a memory in the replica. They are either current and
 * represented as {@link Assertion} or since retracted and therefor represented
 * by {@link Retraction}.
 */
export type Fact<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> = Assertion<T, Of, Is> | Retraction<T, Of, Is>;

export type Statement<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> = Assertion<T, Of, Is> | Retraction<T, Of, Is> | Invariant<T, Of, Is>;

export type State = Fact | Unclaimed;

export type Revision<T = Unit> = T & { since: number };

export type Assert = {
  assert: Assertion;
  retract?: undefined;
  claim?: undefined;
};

export type Retract = {
  retract: Retraction;
  assert?: undefined;
  claim?: undefined;
};

export type Claim = {
  claim: Invariant;
  assert?: undefined;
  retract?: undefined;
};

// This is essentially an OfTheCause tree with one special record whose value is another OfTheCause tree.
export type Commit<Subject extends string = MemorySpace> = {
  [of in Subject]: {
    ["application/commit+json"]: {
      [cause: Cause]: {
        is: CommitData;
      };
    };
  };
};

// We include labels here so we can use the commit data to redact the transaction
// results before sending them to subscribers with insufficient access.
export type CommitData = {
  since: number;
  transaction: Transaction;
  labels?: FactSelection;
};

export type CommitFact<Subject extends MemorySpace = MemorySpace> = Assertion<
  "application/commit+json",
  Subject,
  CommitData
>;

// This allows a consumer to check that their entities match the current cause
// state before making local changes that would be discarded on conflict.
export type ClaimFact = true;

// ⚠️ Note we use `void` as opposed to `undefined` because the latter makes it
// incompatible with JSONValue.
export type RetractFact = { is?: void };
export type AssertFact<Is extends JSONValue = JSONValue> = { is: Is };

// This is the structure of a bunch of our objects
export type OfTheCause<T> = {
  [of in Entity]: {
    [the in The]: {
      [cause: Cause]: T;
    };
  };
};

export type Changes<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> = {
  [of in Of]: {
    [the in T]: {
      [cause: Cause]: RetractFact | AssertFact<Is> | ClaimFact;
    };
  };
};

export type FactSelection<
  T extends The = The,
  Of extends Entity = Entity,
  Is extends JSONValue = JSONValue,
> = {
  [of in Of]: {
    [the in T]: {
      [cause: Cause]: {
        is?: Is;
        since: number;
      };
    };
  };
};

export type Meta = Record<string, string>;

export type DID = `did:${string}:${string}`;

export type DIDKey = `did:key:${string}`;

export type URI = `${string}:${string}`;
export type MIME = `${string}/${string}`;

export type Transaction<Space extends MemorySpace = MemorySpace> = Invocation<
  "/memory/transact",
  Space,
  { changes: Changes }
>;

export type TransactionResult<Space extends MemorySpace = MemorySpace> =
  AwaitResult<
    Commit<Space>,
    ConflictError | TransactionError | ConnectionError | AuthorizationError
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
  { source: InvocationURL<Reference<Subscribe<Space>>> }
>;

export type SchemaQueryArgs = {
  selectSchema: SchemaSelector;
  since?: number;
  subscribe?: boolean; // set to true to be notified of changes to any reachable entities
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
//         schemaContext: {
//           schema: { "type": "object" },
//           rootSchema: { "type": "object" }
//         }
//       }
//     }
//   }
// }

export type SchemaSelector = Select<
  Entity,
  Select<The, Select<Cause, SchemaPathSelector>>
>;

export type Operation =
  | Transaction
  | Query
  | SchemaQuery
  | Subscribe
  | Unsubscribe;

export type QueryResult<Space extends MemorySpace = MemorySpace> = AwaitResult<
  Selection<Space>,
  AuthorizationError | QueryError | ConnectionError
>;

export type CloseResult = AwaitResult<Unit, SystemError>;

export type WatchResult = AwaitResult<Unit, QueryError | ConnectionError>;

export type SubscriptionQuery = {
  iss: DID;
  sub: MemorySpace;
  cmd: "/memory/query";
  args: {
    select: Selector;
    since?: number;
  };
};

export type SelectAll = "_";
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
  Entity,
  Select<The, Select<Cause, { is?: Unit }>>
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
  expected: Reference<Fact> | null;

  /**
   * Actual memory state in the replica repository.
   */
  actual: Revision<Fact> | null;
};

export type ToJSON<T> = T & {
  toJSON(): T;
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

// This will match every doc reachable by the specified set of documents
export const SchemaAll: SchemaContext = { schema: true, rootSchema: true };

// This is equivalent to a standard query, and will only match the specified documents
export const SchemaNone: SchemaContext = { schema: false, rootSchema: false };

export const SelectAllString = "_";
