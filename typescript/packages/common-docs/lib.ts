import { refer } from "npm:merkle-reference";
import * as FS from "jsr:@std/fs";
import * as Replica from "./store.ts";

export interface Command {
  push?: OperationSet<Assertion>;
  pull?: OperationSet<Pull>;

  watch?: OperationSet<Address>;
  unwatch?: OperationSet<Address>;
}

/**
 * Represents an address of the document in the repository.
 */
export interface Address {
  /**
   * Repository containing addressed document.
   */
  from: RepositoryID;

  /**
   * Document being addressed.
   */
  this: DocumentID;
}

export type Reference<Data extends JSONValue = JSONValue> = string & {
  toString(): Reference<Data>;
};

export type BaseRevision = {
  is: { this: DocumentID };
  was?: void;
};

export type SubsequentRevision = {
  is: JSONValue;
  was: Reference<Revision>;
};

export type Revision = BaseRevision | SubsequentRevision;

/**
 * Operation to swap document value in the target repository.
 */
export interface Assertion {
  /**
   * Stable document identifier that uniquely identifies the document.
   */
  of: DocumentID;

  /**
   * New state of the document.
   */
  is: JSONValue;

  /**
   * Assumed state of the document, that needs to be true for push to
   * succeed. Omitting implies new document creation.
   */
  was?: Reference<Revision>;
}

export interface Retraction {
  /**
   * Document being retracted.
   */
  of: DocumentID;

  /**
   * Version of the document being retracted.
   */
  is: Reference<Revision>;
}

export type Transaction =
  | { assert: Assertion; retract?: undefined }
  | { retract: Retraction; assert?: undefined };

export type PushResult = Result<Revision, PushError>;

export type PushError = ReplicaNotFound | EntityNotFound | ConflictError;

export interface ConflictError extends Error {
  name: "ConflictError";
  at: RepositoryID;
  of: DocumentID;
  /**
   * Expected version of the document.
   */
  expected: Reference<Revision>;
  /**
   * Actual document in the repository.
   */
  actual: Revision;
}

/**
 * Operation for pulling latest document state. If `version` is specified and
 * it is current result will be {@link Revision} omitting `value` of the
 * document otherwise it will be {@link DocumentState}.
 *
 * If `value` is desired just omit `version`.
 */
export interface Pull extends Address {
  version?: Checksum;
}

export type InferPullResult<Operation extends Pull> = Result<
  Operation["version"] extends Checksum ? Revision : Revision,
  PullError
>;

export type PullError = ReplicaNotFound | EntityNotFound;

export interface ReplicaNotFound extends Error {
  name: "ReplicaNotFound";
  replica: RepositoryID;
}

export interface EntityNotFound extends Error {
  name: "EntityNotFound";
  replica: RepositoryID;
  entity: DocumentID;
}

export type WatchResult = Result<Transaction, BadAddress>;
export type UnwatchResult = Result<Address, BadAddress>;

export type BadAddress = ReplicaNotFound | EntityNotFound;

export type InferReceipt<Request extends Command> = {
  [Key in keyof Request & keyof Command]: Request[Key] extends OperationSet
    ? InferOperations<Key, Request[Key]>
    : never;
};

export type InferOperations<
  Key extends keyof Command,
  Request extends OperationSet,
> = Key extends "push"
  ? { [K in keyof Request[Key]]: PushResult }
  : Key extends "pull"
    ? { [K in keyof Request[Key]]: InferPullResult<Request[Key] & Pull> }
    : Key extends "watch"
      ? { [K in keyof Request[Key]]: WatchResult }
      : Key extends "unwatch"
        ? { [K in keyof Request[Key]]: UnwatchResult }
        : never;

export type OperationSet<T = unknown> = Record<string, T>;

export interface Resource {
  the: DocumentID;
  of: RepositoryID;
}

export type Result<T extends {} = {}, E extends Error = Error> =
  | Ok<T>
  | Fail<E>;

export interface Ok<T extends {}> {
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

export interface RuntimeError extends Error {}

export type RepositoryID = string;
export type DocumentID = string;

export type Checksum = string;

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONObject
  | JSONArray;

// export interface JSONObject {
//   [key: string]: unknown;
// }

export interface JSONObject extends Record<string, JSONValue> {}

export interface JSONArray extends Array<JSONValue> {}

export interface Open {
  store: StoreOptions;
}

export interface StoreOptions {
  url: URL;
}

// /**
//  * Starts a service at a given path.
//  */
// export const open = async (options: Open) => {
//   await FS.ensureDir(options.store.url);
//   return new Repository(options);
// };

// class Repository {
//   constructor(
//     public options: Open,
//     public connections: Map<RepositoryID, Replica.Session> = new Map(),
//   ) {}

//   /**
//    *
//    */
//   pull(operation: Pull) {
//     return pull(this, operation);
//   }
//   push(operation: Assertion) {
//     return push(this, operation);
//   }
// }

export interface RepositoryModel {
  options: Open;
  connections: Map<RepositoryID, Replica.Session>;
}

// /**
//  * Pulls the entity state from the replica.
//  */
// export const pull = async <Operation extends Pull>(
//   state: RepositoryModel,
//   { replica, entity, version }: Operation,
// ): Promise<InferPullResult<Operation>> => {
//   const connection = await Replica.connect({
//     url: new URL(`${replica}.sqlite`, state.options.store.url),
//     pool: state.connections,
//   });

//   if (connection.error) {
//     return connection;
//   }

//   const select = await Replica.select(connection.ok, { entity });
//   if (select.error) {
//     return select;
//   }

//   // If specific version is current leave out the `value` as sending it would
//   // be redundant.
//   if (select.ok.version === version) {
//     delete (select.ok as Partial<State>).value;
//   }

//   return select;
// };

// /**
//  * Pushes new entity state to the replica. If specified `version` is no longer
//  * current the operation will fail.
//  */
// export const push = async (
//   state: RepositoryModel,
//   { value, version, ...address }: Assertion,
// ): Promise<PushResult> => {
//   // If version is omitted it implies new document creation, in which case we
//   // create replica if it does not exist already which is why we use open in
//   // such case. If version is specified however we should fail if replica does
//   // not exist which is why we use connect in that case.
//   const connection =
//     version === undefined
//       ? await Replica.open({
//           url: new URL(`${address.replica}.sqlite`, state.options.store.url),
//           pool: state.connections,
//         })
//       : await Replica.connect({
//           url: new URL(`${address.replica}.sqlite`, state.options.store.url),
//           pool: state.connections,
//         });

//   if (connection.error) {
//     return connection;
//   }

//   // if we reached this far we have a replica connection which we will use to
//   // assert new state. Assertion will fail if assumed `version` is not a current
//   // version of the document (or if document does not exist).
//   return await Replica.assert(connection.ok, {
//     entity: address.entity,
//     value,
//     version,
//     as: refer(value).toString(),
//   });
// };

// /**
//  *
//  * @param state
//  * @param address
//  */
// export const watch = async (state: RepositoryModel, address: Address) => {};
