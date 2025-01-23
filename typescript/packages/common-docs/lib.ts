import { Database } from "jsr:@db/sqlite";
import { refer } from "npm:merkle-reference";
import * as FS from "@std/fs";
import * as Replica from "./replica.ts";

export interface Command {
  push?: OperationSet<Push>;
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
  replica: RepositoryID;
  /**
   * Document being addressed.
   */
  entity: DocumentID;
}

/**
 * Represents a revision of the document in the repository.
 */
export interface Revision extends Address {
  version: Checksum;
}

/**
 * Represents a state of the document in the repository.
 */
export interface State extends Revision {
  value: JSONValue;
}

/**
 * Operation to swap document value in the target repository.
 */
export interface Push extends Address {
  /**
   * New state of the document.
   */
  value: JSONValue;

  /**
   * Assumed state of the document, that needs to be true for push to
   * succeed. Omitting implies new document creation.
   */
  version?: Checksum;
}

export type PushResult = Result<Revision, PushError>;

export type PushError = ReplicaNotFound | EntityNotFound | ConflictError;

export interface ConflictError extends Error {
  name: "ConflictError";
  replica: RepositoryID;
  entity: DocumentID;
  /**
   * Expected version of the document.
   */
  expected?: Checksum;
  /**
   * Actual version of the document.
   */
  actual: Checksum;
  /**
   * Current state of the document.
   */
  value: JSONValue;
}

/**
 * Operation for pulling latest document state. If `version` is specified and
 * it is current result will be {@link Revision} omitting `value` of the
 * document otherwise it will be {@link State}.
 *
 * If `value` is desired just omit `version`.
 */
export interface Pull extends Address {
  version?: Checksum;
}

export type InferPullResult<Operation extends Pull> = Result<
  Operation["version"] extends Checksum ? Revision | State : State,
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

export type WatchResult = Result<State, BadAddress>;
export type UnwatchResult = Result<Revision, BadAddress>;

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

export interface JSONObject {
  [key: string]: JSONValue;
}

export interface JSONArray extends Array<JSONValue> {}

export interface Open {
  store: StoreOptions;
}

export interface StoreOptions {
  url: URL;
}

/**
 * Starts a service at a given path.
 */
export const open = async (options: Open) => {
  await FS.ensureDir(options.store.url);
  return new Service(options);
};

class Service {
  constructor(
    public options: Open,
    public connections: Map<RepositoryID, Replica.Replica> = new Map(),
  ) {}

  /**
   *
   */
  pull(operation: Pull) {
    return pull(this, operation);
  }
}

export interface ServiceState {
  options: Open;
  connections: Map<RepositoryID, Replica.Replica>;
}

/**
 * Pulls the entity from the replica.
 */
export const pull = async <Operation extends Pull>(
  state: ServiceState,
  { replica, entity, version }: Operation,
): Promise<InferPullResult<Operation>> => {
  const connection = await Replica.connect({
    url: state.options.store.url,
    pool: state.connections,
  });

  if (connection.error) {
    return connection;
  }

  const { ok, error } = await Replica.select(connection.ok, { entity });
  if (error) {
    return { error };
  }

  // If specific version is current leave out the `value` as sending it would
  // be redundant.
  if (ok.version === version) {
    delete (ok as Partial<State>).value;
  }

  return { ok };
};

export const push = async (
  state: ServiceState,
  { value, version, ...address }: Push,
): Promise<PushResult> => {
  const checksum = refer(value).toString();
  const connection =
    version === undefined
      ? await Replica.open({
          url: new URL(`${address.replica}.sqlite`, state.options.store.url),
          pool: state.connections,
        })
      : await Replica.connect({
          url: new URL(`${address.replica}.sqlite`, state.options.store.url),
          pool: state.connections,
        });

  if (connection.error) {
    return connection;
  }

  return await Replica.assert(connection.ok, {
    entity: address.entity,
    value,
    version,
    as: checksum,
  });
};
