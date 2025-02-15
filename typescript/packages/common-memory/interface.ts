import type { Reference } from "merkle-reference";

export type { Reference };

export type SubscriberCommand = {
  watch?: Query;
  unwatch?: Query;
};

export type SubscriptionCommand = {
  transact?: Transaction;
  brief?: Brief;
};

export type Brief = {
  sub: MemorySpace;
  args: {
    selector: Selector;
    selection: Selection;
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

  close(): CloseResult;
}

export interface SpaceSession<Space extends MemorySpace = MemorySpace> extends Session {
  subject: Space;

  transact(transact: Transaction<Space>): Result<Commit<Space>, ConflictError | TransactionError>;
  query(source: Query<Space>): Result<Selection<Space>, QueryError>;
  close(): Result<Unit, SystemError>;
}

export interface MemorySession<Space extends MemorySpace = MemorySpace> extends Session<Space> {
  subscribe(subscriber: Subscriber): SubscribeResult;
}

export type SubscribeResult = AwaitResult<Unit, SystemError>;

export interface Subscription extends TransformStream<SubscriberCommand, SubscriptionCommand> {}
export interface Subscriber extends TransformStream<SubscriptionCommand, SubscriberCommand> {}

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

export type Cause<T = Assertion | Retraction | Unclaimed> = string & { toString(): Cause<T> };

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

// export interface Commit extends Assertion {
//   the: "application/commit+json";
//   is: {
//     since: number;
//     transaction: Transaction;
//   };
// }
export type Commit<Subject extends string = MemorySpace> = {
  [of in Subject]: {
    ["application/commit+json"]: {
      [cause: Cause]: {
        is: CommitData;
      };
    };
  };
};

export type CommitData = {
  since: number;
  transaction: Transaction;
};

export type ClaimFact = true;

// ⚠️ Note we use `void` as opposed to `undefined` because later makes it
// incompatible with JSONValue.
export type RetractFact = { is?: void };
export type AssertFact<Is extends JSONValue = JSONValue> = { is: Is };

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
      [cause: Cause]: RetractFact | AssertFact<Is>;
    };
  };
};

export type Meta = Record<string, string>;

export type Principal = string;

export type Transaction<Space extends MemorySpace = MemorySpace> = {
  iss: Principal;
  sub: Space;
  cmd: "/memory/transact";
  args: { changes: Changes };
  meta?: Meta;
};

export type TransactionResult<Space extends MemorySpace = MemorySpace> = AwaitResult<
  Commit<Space>,
  ConflictError | TransactionError | ConnectionError
>;

export type Query<Space extends MemorySpace = MemorySpace> = {
  iss: Principal;
  sub: Space;
  cmd: "/memory/query";
  args: { select: Selector; since?: number };
};

export type QueryResult<Space extends MemorySpace = MemorySpace> = AwaitResult<
  Selection<Space>,
  QueryError | ConnectionError
>;

export type CloseResult = AwaitResult<Unit, SystemError>;

export type WatchResult = AwaitResult<Unit, QueryError | ConnectionError>;

export type SubscriptionQuery = {
  iss: Principal;
  sub: MemorySpace;
  cmd: "/memory/query";
  args: {
    select: Selector;
    since?: number;
  };
};

export type SelectAll = "_";
export type Select<Key extends string, Match> = {
  [key in Key]: Match;
} & {
  _?: Match;
};

/**
 * Selector that replica can be queried by.
 */
export type Selector = Select<Entity, Select<The, Select<Cause, { is?: Unit }>>>;

export type Selection<Space extends MemorySpace = MemorySpace> = {
  [space in Space]: FactSelection;
};

export type Unit = {};

/**
 * Generic type used to annotate underlying type with a context of the replica.
 */
export type In<T> = { [For: MemorySpace]: T };

export type JSONValue = null | boolean | number | string | JSONObject | JSONArray;

export interface JSONObject extends Record<string, JSONValue> {}

export interface JSONArray extends ArrayLike<JSONValue> {}

export type AsyncResult<T extends Unit = Unit, E extends Error = Error> = Promise<Result<T, E>>;

export type AwaitResult<T extends Unit = Unit, E extends Error = Error> =
  | PromiseLike<Result<T, E>>
  | Result<T, E>;

export type Result<T extends Unit = Unit, E extends Error = Error> = Ok<T> | Fail<E>;

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
  actual: Fact | null;
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
  selector: Selector;
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
  [Key in keyof U]: { [K in Exclude<keyof U, Key>]?: never } & {
    [K in Key]: U[Key];
  };
}[keyof U];
