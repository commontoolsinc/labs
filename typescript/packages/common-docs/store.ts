import {
  Database,
  Transaction as DBTransaction,
  SqliteError,
} from "jsr:@db/sqlite";
import type { Result, ReplicaNotFound, MemoryNotFound } from "./lib.ts";
import { fromString, refer, Reference } from "npm:merkle-reference";
import type {
  ReplicaID,
  Entity,
  Factor,
  Defunct,
  Fact,
  FactReference,
  JSONValue,
  ConflictError,
} from "./interface.ts";
import { conflict, raise } from "./error.ts";

export type { ReplicaNotFound, MemoryNotFound, Reference };

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
  id: ReplicaID;
  store: Database;
}

export interface Selector {
  the: string;
  of: Entity;
}

export type SelectError = MemoryNotFound;

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

export class Store implements Model, Session {
  constructor(
    public id: ReplicaID,
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
}): Reference<Fact> => refer(implicit({ the, of }));

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
    of,
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
      throw conflict({
        in: session.id,
        the,
        of,
        expected,
        actual,
      });
    }
  }

  return source;
};

const execute = <
  Factor extends Required<Fact> | Defunct,
  Tr extends DBTransaction<(session: Model, factor: Factor) => Factor>,
>(
  transaction: Tr,
  session: Model,
  factor: Factor,
): Result<Factor, ConflictError | StoreError> => {
  try {
    return {
      ok: transaction(session, factor),
    };
  } catch (error) {
    return (error as Error).name === "ConflictError"
      ? { error: error as ConflictError }
      : // SQLite transactions may produce various errors when DB is busy, locked
        // or file is corrupt. We wrap those in a generic store error.
        // @see https://www.sqlite.org/rescode.html
        { error: raise({ ...factor, in: session.id }, error as SqliteError) };
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
  constructor(public replica: ReplicaID) {
    super(`Replica not found: ${replica}`);
  }
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
