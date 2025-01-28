import type { Reference } from "npm:merkle-reference";

export type { Reference };

/**
 * Unique identifier for the store.
 */
export type ReplicaID = string & { toString(): ReplicaID };

/**
 * Unique identifier for the mutable entity.
 */
export type Entity = string & { toString(): Entity };

/**
 * Type of the fact, usually formatted as media type. By default we expect
 * this to be  "application/json", but in the future we may support other
 * data types.
 */
export type The = string & { toString(): The };

/**
 * Describes not yet claimed memory. It describes a lack of fact about memory.
 */
export interface Unclaimed {
  /**
   * Type of the fact, usually formatted as media type. By default we expect
   * this to be  "application/json", but in the future we may support other
   * data types.
   */
  the: The;

  /**
   * Stable memory identifier that uniquely identifies it.
   */
  of: Entity;

  is?: undefined;
  cause?: undefined;
}

/**
 * Claim denotes a memory state. It describes an immutable value (is) being
 * assigned to the mutable entity (of) of a specific type (the) at given
 * succession denoted by causal reference (cause) to a prior fact about the
 * same memory ({the, of}).
 */
export interface Claim {
  /**
   * Type of the fact, usually formatted as media type. By default we expect
   * this to be  "application/json", but in the future we may support other
   * data types.
   */
  the: The;

  /**
   * Stable memory identifier that uniquely identifies it.
   */
  of: Entity;

  /**
   * Current value held by the memory. It can be inlined `JSON` value or a
   * merkle reference to one.
   */
  is: JSONValue | Reference<JSONValue>;

  /**
   * Reference to the previous `Fact` this one succeeds. When omitted or set
   * to `null` it implies that this is the first assertion made about the
   * `{the, of}` and in such case
   */
  cause?: Reference<Fact> | Reference<Unclaimed> | null;
}

/**
 * `Assertion` is just like a {@link Claim} except the value MUST be inline
 * {@link JSONValue} as opposed to reference to one. {@link Assertion}s are used
 * to assert facts, wile {@link Claim}s are used to retract them. This allows
 * retracting over the wire without having to sending JSON values back and forth.
 */
export interface Assertion extends Claim {
  is: JSONValue;
  cause: Reference<Fact> | Reference<Unclaimed>;
}

/**
 * Represents retracted {@link Assertion}. It is effectively a tombstone
 * denoting assertion that no longer hold and is a fact in itself.
 */
export type Retraction = {
  the: The;
  of: Entity;
  is?: undefined;
  cause: Reference<Assertion>;
};

/**
 * Facts represent a memory in the replica. They are either current and
 * represented as {@link Assertion} or since retracted and therefor represented
 * by {@link Retraction}.
 */
export type Fact = Assertion | Retraction;

/**
 * Selector that replica can be queried by.
 */
export interface Selector {
  the: The;
  of: Entity;
}

/**
 * Generic type used to annotate underlying type with a context of the replica.
 */
export type In<T> = T & { in: ReplicaID };

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONObject
  | JSONArray;

export interface JSONObject extends Record<string, JSONValue> {}

export interface JSONArray extends Array<JSONValue> {}

export type Conflict = {
  /**
   * Identifier of the replica where conflict occurred.
   */
  in: ReplicaID;

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
  name: "StoreError";
  cause: SystemError;
  /**
   * Fact being stored when the error occurred.
   */
  fact: In<Fact>;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;
  selector: In<Selector>;
}
