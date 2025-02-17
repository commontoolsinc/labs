import type { Reference } from "merkle-reference";

export type { Reference };

export type SubscriberCommand = {
  watch?: Query;
  unwatch?: Query;
};

export type Invocation<
  Subject extends Principal = Principal,
  Ability extends The = The,
  Command extends {} = {},
> = {
  cmd: Ability;
  iss: Principal;
  sub: Subject;
  args: Command;
  meta?: Meta;
};

export interface MemoryProtocol<Space extends MemorySpace = MemorySpace> {
  watch(
    source: Watch<Space>["args"],
  ): Task<Result<Selection<Space>, QueryError | ConnectionError>, Transaction<Space>>;
  unwatch(source: Unwatch<Space>["args"]): Task<Result<Unit, ConflictError>>;

  query(query: { select: Selector; since?: number }): Task<Result<Selection<Space>, QueryError>>;
  transact(source: {
    changes: Changes;
  }): Task<Result<Commit<Space>, ConflictError | TransactionError | ConnectionError>>;
}

export type Protocol<Space extends MemorySpace = MemorySpace> = {
  memory: MemoryProtocol<Space>;
};

export type Provider<Protocol extends {}> = {
  perform(command: ProviderCommand<Protocol>): AwaitResult<Unit, SystemError>;
};

export interface ConsumerSession<Protocol extends {}>
  extends TransformStream<ProviderCommand<Protocol>, ConsumerCommand<Protocol>> {}

export interface ProviderSession<Protocol extends {}>
  extends TransformStream<ConsumerCommand<Protocol>, ProviderCommand<Protocol>> {
  close(): CloseResult;
}

export interface Channel<Protocol extends {}>
  extends TransformStream<ProviderCommand<Protocol>, ConsumerCommand<Protocol>> {}

export type ProviderCommand<Protocol extends {} = {}> = {
  [Prefix in keyof Protocol]: {
    [Command in keyof Protocol[Prefix]]: InferProviderCommand<
      `/${Prefix & string}/${Command & string}`,
      Protocol[Prefix][Command]
    >;
  }[keyof Protocol[keyof Protocol]];
  // {
  //   [Key in keyof S]: Key extends Command
  //     ? S[Command] extends (input: infer In) => Task<infer Return, infer Effect>
  //       ? Receipt<In & {}, Return & {}, Effect>
  //       : undefined
  //     : undefined;
  // }[keyof S];
}[keyof Protocol];

export type InferProviderCommand<Ability extends The, Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? Receipt<Invocation<Principal, Ability, Command & {}>, Return & {}, Effect>
  : never;

export type ProviderEffect<Protocol extends {} = {}> = {
  [Prefix in keyof Protocol]: {
    [Command in keyof Protocol[Prefix]]: InferProviderEffect<Protocol[Prefix][Command]>;
    // {
    //   [Key in keyof S]: Key extends Command
    //     ? S[Command] extends (input: infer In) => Task<infer Return, infer Effect>
    //       ? Receipt<In & {}, Return & {}, Effect>
    //       : undefined
    //     : undefined;
    // }[keyof S];
  }[keyof Protocol[keyof Protocol]];
}[keyof Protocol];

export type InferProviderEffect<Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? Effect
  : never;

export type ProviderReturn<Protocol extends {} = {}> = {
  [Prefix in keyof Protocol]: {
    [Command in keyof Protocol[Prefix]]: InferProviderReturn<Protocol[Prefix][Command]>;
  }[keyof Protocol[keyof Protocol]];
}[keyof Protocol];

export type InferProviderReturn<Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? Return
  : never;

export type Consumer<Protocol> = Perform<
  {
    [Command in keyof Protocol]: InferEffect<Protocol[Command]>;
  }[keyof Protocol]
>;

export type Perform<T extends { Effect: any; Command: any }> = {
  perform(command: T["Effect"]): AwaitResult<T["Command"][], never>;
};

export type InferEffect<Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? { Command: Command; Effect: Effect }
  : never;

export type ConsumerCommand<Protocol extends {} = {}> = {
  [Prefix in keyof Protocol]: {
    // [Command in keyof Service]: { [Key in Command]: InferConsumerCommand<Service[Command]> } & {
    //   [Key in Exclude<keyof Service, Command>]?: undefined;
    // };
    [Command in keyof Protocol[Prefix]]: InferConsumerCommand<
      `/${Prefix & string}/${Command & string}`,
      Protocol[Prefix][Command]
    >;
  }[keyof Protocol[keyof Protocol]];
}[keyof Protocol];

export type Test = ConsumerCommand<{ memory: MemoryProtocol }>;
export type InferMethod<Service extends {} = {}> = {
  [Command in keyof Service]: InferTask<Command, Service[Command]>;
}[keyof Service];

export type InferTask<Label extends PropertyKey, Method> = Method extends (
  input: infer In,
) => Task<infer Return, infer Effect>
  ? { Command: { [Key in Label]: In }; Task: Task<Return, Effect>; Return: Return }
  : never;

export type InferConsumerCommand<Ability extends The, Method> = Method extends (
  command: infer Command extends {},
) => Task<infer Return, infer Effect>
  ? Invocation<Principal, Ability, Command>
  : never;

export type InferConsumerReturn<Service, Run extends Invocation> = {
  [Prefix in keyof Service]: {
    [Method in keyof Service[Prefix]]: `/${Prefix & string}/${Method & string}` extends Run["cmd"]
      ? InferConsumerCommandReturn<Service[Prefix][Method]>
      : never;
  }[keyof Service[keyof Service]];
}[keyof Service];

export type InferConsumerCommandReturn<Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? Return
  : never;

export type InferConsumerEffect<Service, Run extends Invocation> = {
  [Prefix in keyof Service]: {
    [Method in keyof Service[Prefix]]: `/${Prefix & string}/${Method & string}` extends Run["cmd"]
      ? InferConsumerCommandEffect<Service[Prefix][Method]>
      : never;
  }[keyof Service[keyof Service]];
}[keyof Service];

export type InferConsumerCommandEffect<Method> = Method extends (
  command: infer Command,
) => Task<infer Return, infer Effect>
  ? Effect
  : never;

export interface Interpreter<Protocol, Run extends Invocation> {
  interpret(command: InferConsumerEffect<Protocol, Run>): AwaitResult<Unit, SystemError>;
}

export interface InvokedTask<Protocol, Run extends Invocation> {
  perform(interpret: Interpreter<Protocol, Run>): InferConsumerReturn<Protocol, Run>;
}

export type Task<Return, Command = never> = Iterable<Command, Return>;

export type Job<Command extends {} = {}, Return extends {} | null = {} | null, Effect = unknown> = {
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

export type SessionTask<Space extends MemorySpace> = UnwatchTask<Space> | WatchTask<Space>;

export type Receipt<Of extends {}, Result extends {} | null, Command> =
  | { the: "task/return"; of: Reference<Of>; is: Result }
  | (Command extends never ? never : { the: "task/effect"; of: Reference<Of>; is: Command });

export type Effect<Of extends {}, Command> = {
  of: Reference<Of>;
  run: Command;
  is?: undefined;
};

export type Return<Of extends {}, Result extends {} | null> = {
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

  close(): CloseResult;
}

export interface SpaceSession<Space extends MemorySpace = MemorySpace> extends Session {
  subject: Space;

  transact(transact: Transaction<Space>): Result<Commit<Space>, ConflictError | TransactionError>;
  query(source: Query<Space>): Result<Selection<Space>, QueryError>;
  close(): Result<Unit, SystemError>;
}

export interface MemorySession<Space extends MemorySpace = MemorySpace> extends Session<Space> {
  subscribe(subscriber: Subscriber<Space>): SubscribeResult;
  unsubscribe(subscriber: Subscriber<Space>): SubscribeResult;
}

export interface Subscriber<Space extends MemorySpace = MemorySpace> {
  transact(transaction: Transaction<Space>): AwaitResult<Unit, SystemError>;
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

export type Principal = `did:${string}:${string}`;

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

export type Watch<Space extends MemorySpace = MemorySpace> = {
  iss: Principal;
  sub: Space;
  cmd: "/memory/watch";
  args: { select: Selector; since?: number };
};

export type Unwatch<Space extends MemorySpace = MemorySpace> = {
  iss: Principal;
  sub: Space;
  cmd: "/memory/unwatch";
  args: { source: Reference<Watch<Space>> };
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

export type Await<T> = PromiseLike<T> | T;

export type AwaitResult<T extends Unit = Unit, E extends Error = Error> = Await<Result<T, E>>;

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
