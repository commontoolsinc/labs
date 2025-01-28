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
 * Fact denotes a memory state. It describes immutable value currently assigned
 * held by the mutable reference identified by `of`. It references a prior fact
 * or a defunct (retracted fact) it supersedes.
 */
export type Fact = {
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
   * Current state of the memory as JSON value.
   */
  is?: JSONValue;

  /**
   * Reference to the previous `Fact`, `Defunct` or `ImplicitFact` being
   * superseded by this fact. If omitted it implies reference to the implicit
   * fact corresponding to `{the, of, is:{}}`.
   */
  cause?: Reference<Factor>;
};

/**
 * `Factor` is similar to `Fact` but instead of holding current value under
 * `is` field it holds a reference to it. This allows more compact transmission
 * when recipient is expected to have referenced value or simply does not need
 * to have one.
 */
export type FactReference = {
  the: The;
  of: Entity;
  is: Reference<JSONValue>;
  cause?: Reference<Factor>;
};

/**
 * Represents retracted {@link Fact} and is like tombstone denoting prior
 * existence of the fact.
 */
export type Defunct = {
  the: The;
  of: Entity;
  is?: undefined;
  cause: Reference<Fact>;
};

export type Factor = Fact | Defunct;

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
  expected: Reference<Factor> | null;

  /**
   * Actual memory state in the replica repository.
   */
  actual: Factor | null;
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
  fact: In<Required<Fact> | Defunct>;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;
  selector: In<Selector>;
}
