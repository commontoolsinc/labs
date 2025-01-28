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
export const init = ({
  the,
  of,
}: {
  the: string;
  of: Entity;
}): Reference<ImplicitFact> => refer(implicit({ the, of }));

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

const importDatum = (
  session: Model,
  source: Factor,
): Reference<JSONValue> | null => {
  // If source is a {@link Defunct}, then `is` field and we will be `undefined`
  // so we will not need to import any data into the `datum` table.
  if (source.is === undefined) {
    return null;
  } else {
    const is = refer(source.is);
    session.store.run(IMPORT_DATUM, {
      this: is.toString(),
      source: JSON.stringify(source.is),
    });
    return is;
  }
};

const swap = <T extends Required<Fact> | Defunct>(
  session: Model,
  source: T,
): T => {
  const { the, of } = source;
  // Derive the merkle reference for the provided factor which is expected to
  // be in normalized form.
  const factor = refer(source).toString();
  // We do not store implicit facts like `{ the, of }` in the database and
  // we represent causal reference to such implicit facts as `NULL`, therefore
  // we asses if causal reference is to an implicit and if so substitute it
  // with `null`. We also use `null` for an implicit `cause` in the
  // `RevisionError`, that is because callers aren't expected to specify them
  // explicitly and telling in the error that hash to implicit was expected
  // would be confusing.
  const expected =
    source.cause.toString() === init(source).toString() ? null : source.cause;
  const cause = expected?.toString() ?? null;

  // First we import JSON value in the `is` field into the `datum` table and
  // then we import the fact into the `factor` table. If `datum` already exists
  // we ignore as we key those by the merkle reference. Same is true for the
  // `factor` table where we key by the merkle reference of the fact so if
  // conflicting record exists it is the same record and we ignore.
  session.store.run(IMPORT_FACTOR, {
    this: factor,
    the,
    of: of,
    is: importDatum(session, source)?.toString() ?? null,
    cause,
  });

  // Now if referenced cause is for an implicit fact, we will not have a record
  // for it in the memory table to update in the next step. We also can not
  // create such record as we don't have corresponding records in the `factor`
  // or `datum` tables. Therefore instead we try to create a record for the
  // desired update. If conflicting record exists this will be ignored, but that
  // is fine as update in the next step will update it to the desired state.
  if (expected == null) {
    session.store.run(IMPORT_MEMORY, {
      the,
      of,
      factor,
    });
  }

  // Here we finally perform a memory swap. Note that update is conditional and
  // will only update if current record has the same `cause` reference. If that
  // is not the case 0 records will be updated indicating a conflict handled
  // below.
  const updated = session.store.run(SWAP, {
    factor,
    cause,
  });

  // If no records were updated it implies that there was no record with
  // matching `cause`. It may be because `cause` referenced implicit fact
  // in which case which case `IMPORT_MEMORY` provisioned desired record and
  // update would not have applied. Or it could be that `cause` in the database
  // is different from the one being asserted. We will asses this by pulling
  // the record and comparing it to desired state.
  if (updated === 0) {
    const actual = pull(session, source) ?? null;
    // If actual state matches desired state it is either was inserted by the
    // `IMPORT_MEMORY` or this was a duplicate call. Either way we do not treat
    // it as a conflict as current state is the asserted one.
    if (refer(actual).toString() !== factor) {
      throw new RevisionError(session.id, the, of, expected, actual);
    }
  }

  return source;
};

const execute = <
  Out extends {},
  Input extends unknown[],
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
  { the, of, is, cause = init({ the, of }) }: Fact,
): Result<Fact, ConflictError | StoreError> =>
  execute(session.store.transaction(swap), session, {
    the,
    of,
    is,
    cause,
  });

export const retract = (
  session: Model,
  { the, of, cause, ...source }: Fact | FactReference,
): Result<Defunct, ConflictError | StoreError> =>
  execute(session.store.transaction(swap<Defunct>), session, {
    the,
    of,
    cause:
      cause == null ? init({ the, of }) : refer({ ...source, the, of, cause }),
  });

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
