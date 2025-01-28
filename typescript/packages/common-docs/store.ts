import { Database, Transaction as DBTransaction } from "jsr:@db/sqlite";
import type {
  Result,
  Entity,
  RepositoryID,
  ReplicaNotFound,
  MemoryNotFound,
  JSONValue,
} from "./lib.ts";
import { fromString, refer, Reference } from "npm:merkle-reference";

export type {
  RepositoryID,
  Entity,
  ReplicaNotFound,
  MemoryNotFound,
  Reference,
};

export const PREPARE = `
BEGIN TRANSACTION;

-- Create table for storing JSON data.
CREATE TABLE IF NOT EXISTS datum (
  this    TEXT PRIMARY KEY,     -- Merkle reference for this JSON
  source  JSON NOT NULL         -- Source for this JSON
);

CREATE VIEW IF NOT EXISTS maybe_datum AS
SELECT * FROM datum
UNION ALL
SELECT NULL AS this, NULL AS source;

CREATE TABLE IF NOT EXISTS factor (
  this    TEXT PRIMARY KEY,     -- Merkle reference for { the, of, is, cause }
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  'is'    TEXT,                 -- Value entity is claimed to have
  cause   TEXT,                 -- Causal reference to prior fact
  FOREIGN KEY('is') REFERENCES datum(this)
);

CREATE TABLE IF NOT EXISTS memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  factor  TEXT NOT NULL,        -- Link to the fact,
  FOREIGN KEY(factor) REFERENCES factor(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);
`;

const IMPORT_DATUM = `INSERT OR IGNORE INTO datum (this, source) VALUES (:this, :source);`;

const IMPORT_FACTOR = `INSERT OR IGNORE INTO factor (this, the, of, 'is', cause) VALUES (:this, :the, :of, :is, :cause);`;

const IMPORT_MEMORY = `INSERT OR IGNORE INTO memory (the, of, factor) VALUES (:the, :of, :factor);`;

const SWAP = `UPDATE memory SET factor = :factor
WHERE 
(:cause IS NULL AND factor IS NULL) OR factor = :cause;`;

const EXPORT = `SELECT 
  memory.the as the,
  memory.of as of,
  memory.factor as factor,
  maybe_datum.source as 'is',
  factor.cause as cause
FROM
  memory
JOIN
  factor ON memory.factor = factor.this
JOIN
  maybe_datum ON factor.'is' = maybe_datum.this OR (factor.'is' IS NULL AND maybe_datum.this IS NULL)
WHERE
  memory.the = :the
  AND
  memory.of = :entity;
`;

export type Options = {
  url: URL;
};

export interface Model {
  id: RepositoryID;
  store: Database;
}

export interface Selector {
  the: string;
  of: Entity;
}

export type SelectError = MemoryNotFound;

export interface ConflictError extends Error {
  name: "ConflictError";
  in: RepositoryID;
  the: string;
  of: Entity;
  /**
   * Expected version of the document.
   */
  expected: Reference<Factor> | null;
  /**
   * Actual document in the repository.
   */
  actual: Factor | null;
}
export interface Session {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact<In extends Transaction>(transact: In): InferTransactionResult<In>;
  /**
   * Query can be used to retrieve a document from the store. At the moment
   * you can only pass the `entity` selector.
   */
  query(selector: Selector): Result<Factor, MemoryNotFound | StoreError>;
}

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
  the: string;

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

export type Cause =
  | Reference<{ the: string; of: Entity }>
  | Reference<{ is: JSONValue; cause: Cause }>
  | Reference<{ cause: Cause }>;

export interface ImplicitFact extends Fact {
  cause?: undefined;
}

/**
 * Represents retracted {@link Fact} and is like tombstone denoting prior
 * existence of the fact.
 */
export type Defunct = {
  the: string;
  of: Entity;
  is?: undefined;
  cause: Reference<Fact>;
};

export const isImplicit = (factor: Factor): factor is ImplicitFact =>
  factor.cause === undefined;
export const isFact = (factor: Factor): factor is Fact =>
  factor.is !== undefined;

export type Factor = Fact | Defunct;

/**
 * `Factor` is similar to `Fact` but instead of holding current value under
 * `is` field it holds a reference to it. This allows more compact transmission
 * when recipient is expected to have referenced value or simply does not need
 * to have one.
 */
export type FactReference = {
  the: string;
  of: Entity;
  is: Reference<JSONValue>;
  cause?: Reference<Factor>;
};

export class Store implements Model, Session {
  constructor(
    public id: RepositoryID,
    public store: Database,
  ) {}

  transact<In extends Transaction>(transaction: In) {
    return transact(this, transaction);
  }

  query(selector: Selector) {
    return query(this, selector);
  }
}

/**
 * Takes store URL which is expected to be either `file:` or `memory:` protocol
 * and extracts store name and location (expected by the {@link Database}).
 *
 * Store URL may have following forms
 * @example
 *
 * ```js
 * new URL('file:///Users/ct/.store/did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi.sqlite')
 * new URL('memory:did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi')
 * ```
 *
 * In both cases `id` of the store is `did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi` while
 * location in first instance is URL itself but `:memory:` in the second, which
 * is what {@link Database} expects.
 */
const readAddress = (url: URL) => {
  const { pathname } = url;
  const base = pathname.split("/").pop() as string;
  const id = base.endsWith(".sqlite") ? base.slice(0, -".sqlite".length) : base;

  return { location: url.protocol === "file:" ? url : ":memory:", id };
};

/**
 * It is similar to `Fact` except instead of passing inline `is` a reference to
 * it could be passed. This is transmission more efficient.
 */
export interface Retraction {
  the: string;
  of: Entity;
  is: Reference<JSONValue> | JSONValue;
  cause?: Reference<Fact>;
}

export type Transaction =
  | { assert: Fact; retract?: undefined }
  | { retract: Fact | FactReference; assert?: undefined };

export type InferTransactionResult<Transaction> = Transaction extends {
  assert: Fact;
}
  ? Result<Fact, ConflictError | StoreError>
  : Result<Defunct, ConflictError | StoreError>;

/**
 * Creates a connection to the existing replica. Errors if replica does not
 * exist.
 */
export const connect = async ({
  url,
}: Options): Promise<Result<Store, ReplicaNotFound>> => {
  const address = readAddress(url);
  try {
    const database = await new Database(address.location, { create: false });
    database.exec(PREPARE);
    const session = new Store(address.id, database);
    return { ok: session };
  } catch {
    return { error: new ReplicaNotFoundError(address.id) };
  }
};

export const open = async ({ url }: Options): Promise<Result<Store, never>> => {
  const { location, id } = readAddress(url);
  const database = await new Database(location, { create: true });
  database.exec(PREPARE);
  const session = new Store(id, database);
  return { ok: session };
};

export const close = async ({ store }: Model) => {
  await store.close();
};

type MemoryView = {
  id: string;
  the: string;
  of: Entity;
  is: string;
  cause: string | null;
};

/**
 * Creates an implicit fact.
 *
 * @param {object} source
 * @param {string} source.the
 * @param {Entity} source.of
 * @returns {ImplicitFact}
 */
export const implicit = ({ the, of }: { the: string; of: Entity }) => ({
  the,
  of,
});

/**
 * Creates a reference to an implicit fact.
 */
export const init = ({ the, of }: ImplicitFact): Reference<ImplicitFact> =>
  refer(implicit({ the, of }));

const pull = ({ store }: Model, { the, of }: Selector): Factor => {
  const row = store.prepare(EXPORT).get({ the, entity: of }) as
    | MemoryView
    | undefined;

  // If we do not have matching memory we return implicit fact.
  if (row === undefined) {
    return implicit({ the, of });
  }
  // If we do have a row we parse and return it.
  else {
    const is = row.is ? JSON.parse(row.is) : undefined;
    // If `cause` is `null` it implies reference to the implicit fact.
    const cause = row.cause
      ? (fromString(row.cause) as Reference<Fact>)
      : refer(implicit({ the, of }));

    // If `is` is `undefined` it implies that fact was retracted so we return
    // defunct fact.
    return is === undefined ? { the, of, cause } : { the, of, is, cause };
  }
};

const selectCause = (
  { the, of, cause }: { the: string; of: Entity; cause?: Reference<Factor> },
  implicit: Reference<Factor> = init({ the, of }),
): { cause?: Reference<Factor> } => ({
  cause: cause ?? implicit,
});

const selectIs = ({ is }: { is?: JSONValue | Reference<JSONValue> }) =>
  is === undefined ? {} : { is: refer(is) };

const swap = ({ store, id }: Model, source: Fact): Fact => {
  const { the, of } = source;
  const implicit = init({ the, of });
  const proof = {
    the,
    of,
    is: refer(source.is) as Reference<JSONValue>,
    cause: source.cause ?? implicit,
  };

  const is = proof.is.toString();
  const fact = refer(proof).toString();
  const cause =
    proof.cause.toString() === implicit.toString()
      ? null
      : proof.cause.toString();

  // First we try to import JSON into a datum table.
  store.run(IMPORT_DATUM, {
    this: is,
    source: JSON.stringify(source.is),
  });

  // Then we try to import a asserted fact into a fact table.
  store.run(IMPORT_FACTOR, {
    this: fact,
    the,
    of,
    is,
    cause,
  });

  // If no prior fact was expected we will have either no memory record for it
  // or we will have a record for `implicit` but created explicitly. If it is
  // former we will create a desired record, but if it is the latter operation
  // will be ignored due to primary key constraint.
  if (!cause) {
    store.run(IMPORT_MEMORY, { the, of, factor: fact });
  }

  // Finally we will swap memory record to point from expected prior fact `cause`
  // to a derived fact. If no causal reference was expected we use an `implicit`
  // this way if `implicit` was explicitly created it will be updated but if no
  // memory record existed previous step would have created desired record and
  // this update will have no effect. However memory references different fact
  // this will update 0 records and in such case we likely have a conflict.
  const updated = store.run(SWAP, { factor: fact, cause });

  if (updated === 0) {
    const expected = cause === null ? null : proof.cause;
    const actual = pull({ id, store }, { the, of }) ?? null;

    // If actual state matches desired state update was just duplicate call,
    // while technically this is a conflict we do not treat it as such as
    // there is no point to error if asserted state is an actual state.
    if (refer(actual).toString() !== fact.toString()) {
      throw new RevisionError(id, the, of, expected, actual);
    }
  }

  return { the, of, is: source.is, cause: proof.cause };
};

const revoke = (
  { id, store }: Model,
  source: Fact | FactReference,
): Defunct => {
  const { the, of } = source;
  const expected =
    // If there is no `is` nor `cause` we're retracting implicit fact.
    source.is === undefined && source.cause === undefined
      ? { the, of }
      : { the, of, ...selectIs(source), ...selectCause(source) };

  const defunct = { the, of, cause: refer(expected) };
  const cause = defunct.cause.toString();
  const factor = refer(defunct).toString();

  // Try to import the defunct into the factor table.
  store.run(IMPORT_FACTOR, {
    this: factor,
    the,
    of,
    is: null,
    cause,
  });

  if (!expected.cause) {
    store.run(IMPORT_MEMORY, { the, of, factor });
  }

  // Finally we will swap memory record to point from expected prior fact to
  // a derived factor. However if memory references different fact from one
  // being revoked 0 records will be updated and in such case we likely have
  // likely have a conflict.
  const updated = store.run(SWAP, { factor, cause });

  if (updated === 0) {
    const actual = pull({ id, store }, { the, of }) ?? null;

    // If actual state matches desired state update was just duplicate call,
    // while technically this is a conflict we do not treat it as such as
    // there is no point to error if asserted state is an actual state.
    if (refer(actual).toString() !== factor) {
      throw new RevisionError(id, the, of, defunct.cause, actual);
    }
  }

  return defunct;
};

const execute = <
  Input extends unknown[],
  Out extends {},
  Tr extends DBTransaction<(...input: Input) => Out>,
>(
  transaction: Tr,
  ...input: Input
): Result<Out, ConflictError | StoreError> => {
  try {
    return {
      ok: transaction(...input),
    };
  } catch (error) {
    return error instanceof RevisionError
      ? { error }
      : // SQLite transactions may produce various errors when DB is busy, locked
        // or file is corrupt. We wrap those in a generic store error.
        // @see https://www.sqlite.org/rescode.html
        { error: new StoreError((error as Error).message) };
  }
};

export const assert = (
  session: Model,
  fact: Fact,
): Result<Fact, ConflictError | StoreError> =>
  execute(session.store.transaction(swap), session, fact);

export const retract = (
  session: Model,
  source: Fact | FactReference,
): Result<Defunct, ConflictError | StoreError> =>
  execute(session.store.transaction(revoke), session, source);

export const transact = <In extends Transaction>(
  model: Model,
  transact: In,
): InferTransactionResult<In> =>
  transact.assert
    ? (assert(model, transact.assert) as InferTransactionResult<In>)
    : (retract(model, transact.retract) as InferTransactionResult<In>);

export class ReplicaNotFoundError extends Error implements ReplicaNotFound {
  override name = "ReplicaNotFound" as const;
  constructor(public replica: RepositoryID) {
    super(`Replica not found: ${replica}`);
  }
}

export class RevisionError extends Error implements ConflictError {
  override name = "ConflictError" as const;
  in: string;
  constructor(
    at: RepositoryID,
    public the: string,
    public of: Entity,
    public expected: Reference<Fact | Defunct> | null,
    public actual: Fact | Defunct | null,
  ) {
    super(
      expected == null
        ? `The ${the} of ${of} in ${at} already exists as ${refer(actual)}`
        : actual == null
          ? `The ${the} of ${of} in ${at} was expected to be ${expected}, but it does not exists`
          : `The ${the} of ${of} in ${at} was expected to be ${expected}, but it is ${refer(actual)}`,
    );

    this.in = at;
  }

  toJSON() {}
}

export const query = (
  { id, store }: Model,
  { the, of }: Selector,
): Result<Factor, StoreError> => {
  try {
    return { ok: pull({ id, store }, { the, of }) };
  } catch (error) {
    return { error: new StoreError((error as Error).message) };
  }
};

export class StoreError extends Error {
  override name = "StoreError" as const;
  constructor(message: string) {
    super(message);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
    };
  }
}

class MemoryNotFoundError extends Error implements MemoryNotFound {
  override name = "MemoryNotFound" as const;
  in: string;
  constructor(
    public the: string,
    public of: Entity,
    at: RepositoryID,
    message: string = `No ${the} for ${of} found in ${at}`,
  ) {
    super(message);
    this.in = at;
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,

      the: this.the,
      of: this.of,
      in: this.in,
    };
  }
}
