import { Database, Transaction as DBTransaction, SqliteError } from "jsr:@db/sqlite";
import { fromString, refer, Reference } from "npm:merkle-reference";
import type {
  Result,
  ReplicaID,
  Entity,
  Fact,
  Statement,
  Retraction,
  JSONValue,
  ConflictError,
  TransactionError,
  QueryError,
  ToJSON,
  ConnectionError,
  Unclaimed,
  Transaction,
  Assertion,
  Claim,
  AsyncResult,
  SystemError,
} from "./interface.ts";
import * as Error from "./error.ts";

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

CREATE TABLE IF NOT EXISTS fact (
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
  fact  TEXT NOT NULL,          -- Link to the fact,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

CREATE VIEW IF NOT EXISTS state AS
SELECT 
  memory.the as the,
  memory.of as of,
  maybe_datum.source as 'is',
  fact.cause as cause,
  memory.fact as fact,
  maybe_datum.this as proof
FROM
  memory
JOIN
  fact ON memory.fact = fact.this
JOIN
  maybe_datum ON fact.'is' = maybe_datum.this OR (fact.'is' IS NULL AND maybe_datum.this IS NULL);

COMMIT;
`;

const IMPORT_DATUM = `INSERT OR IGNORE INTO datum (this, source) VALUES (:this, :source);`;

const IMPORT_FACT = `INSERT OR IGNORE INTO fact (this, the, of, 'is', cause) VALUES (:this, :the, :of, :is, :cause);`;

const IMPORT_MEMORY = `INSERT OR IGNORE INTO memory (the, of, fact) VALUES (:the, :of, :fact);`;

const SWAP = `UPDATE memory SET fact = :fact
WHERE 
(:cause IS NULL AND fact IS NULL) OR fact = :cause;`;

const EXPORT = `SELECT 
  memory.the as the,
  memory.of as of,
  memory.fact as fact,
  maybe_datum.source as 'is',
  fact.cause as cause
FROM
  memory
JOIN
  fact ON memory.fact = fact.this
JOIN
  maybe_datum ON fact.'is' = maybe_datum.this OR (fact.'is' IS NULL AND maybe_datum.this IS NULL)
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

export interface Session {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact(transact: Transaction): Result<Fact, ToJSON<ConflictError> | ToJSON<TransactionError>>;

  /**
   * Query can be used to retrieve a document from the store. At the moment
   * you can only pass the `entity` selector.
   */
  query(selector: Selector): Result<Fact | Unclaimed, ToJSON<QueryError>>;

  close(): AsyncResult<{}, SystemError>;
}

export class Store implements Model, Session {
  constructor(public id: ReplicaID, public store: Database) {}

  transact<In extends Transaction>(transaction: In) {
    return transact(this, transaction);
  }

  query(selector: Selector) {
    return query(this, selector);
  }

  close(): AsyncResult<{}, SystemError> {
    return close(this);
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
 * Creates a connection to the existing replica. Errors if replica does not
 * exist.
 */
export const connect = async ({ url }: Options): AsyncResult<Store, ToJSON<ConnectionError>> => {
  const address = readAddress(url);
  try {
    const database = await new Database(address.location, { create: false });
    database.exec(PREPARE);
    const session = new Store(address.id, database);
    return { ok: session };
  } catch (cause) {
    return { error: Error.connection(url, cause as SqliteError) };
  }
};

export const open = async ({ url }: Options): AsyncResult<Store, ToJSON<ConnectionError>> => {
  try {
    const { location, id } = readAddress(url);
    const database = await new Database(location, { create: true });
    database.exec(PREPARE);
    const session = new Store(id, database);
    return { ok: session };
  } catch (cause) {
    throw Error.connection(url, cause as SqliteError);
  }
};

export const close = async ({ store }: Model): AsyncResult<{}, SystemError> => {
  try {
    await store.close();
    return { ok: {} };
  } catch (cause) {
    return { error: cause as SqliteError };
  }
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
export const init = ({ the, of }: { the: string; of: Entity }): Reference<Assertion> =>
  refer(implicit({ the, of }));

const pull = ({ store }: Model, { the, of }: Selector): Fact | undefined => {
  const row = store.prepare(EXPORT).get({ the, entity: of }) as MemoryView | undefined;

  // If we do not have matching memory we return implicit fact.
  if (row === undefined) {
    return undefined;
  }
  // If we do have a row we parse and return it.
  else {
    const is = row.is ? JSON.parse(row.is) : undefined;
    // If `cause` is `null` it implies reference to the implicit fact.
    const cause = row.cause
      ? (fromString(row.cause) as Reference<Assertion>)
      : refer(implicit({ the, of }));

    // If `is` is `undefined` it implies that fact was retracted so we return
    // defunct fact.
    return is === undefined ? { the, of, cause } : { the, of, is, cause };
  }
};

const importDatum = (session: Model, source: Fact): Reference<JSONValue> | null => {
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

const swap = <Fact extends Assertion | Retraction>(session: Model, source: Fact): Fact => {
  const { the, of } = source;
  // Derive the merkle reference for the provided factor which is expected to
  // be in normalized form.
  const fact = refer(source).toString();
  // We do not store implicit facts like `{ the, of }` in the database and
  // we represent causal reference to such implicit facts as `NULL`, therefore
  // we asses if causal reference is to an implicit and if so substitute it
  // with `null`. We also use `null` for an implicit `cause` in the
  // `RevisionError`, that is because callers aren't expected to specify them
  // explicitly and telling in the error that hash to implicit was expected
  // would be confusing.
  const expected =
    source.cause?.toString() === init(source).toString() ? null : (source.cause as Reference<Fact>);
  const cause = expected?.toString() ?? null;

  // First we import JSON value in the `is` field into the `datum` table and
  // then we import the fact into the `factor` table. If `datum` already exists
  // we ignore as we key those by the merkle reference. Same is true for the
  // `factor` table where we key by the merkle reference of the fact so if
  // conflicting record exists it is the same record and we ignore.
  session.store.run(IMPORT_FACT, {
    this: fact,
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
      fact,
    });
  }

  // Here we finally perform a memory swap. Note that update is conditional and
  // will only update if current record has the same `cause` reference. If that
  // is not the case 0 records will be updated indicating a conflict handled
  // below.
  const updated = session.store.run(SWAP, {
    fact,
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
    if (refer(actual).toString() !== fact) {
      throw Error.conflict({
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
  Fact extends Assertion | Retraction,
  Tr extends DBTransaction<(session: Model, fact: Fact) => Fact>,
>(
  transaction: Tr,
  session: Model,
  fact: Fact,
): Result<Fact, ToJSON<ConflictError> | ToJSON<TransactionError>> => {
  try {
    return {
      ok: transaction(session, fact),
    };
  } catch (error) {
    return (error as Error).name === "ConflictError"
      ? { error: error as ToJSON<ConflictError> }
      : // SQLite transactions may produce various errors when DB is busy, locked
        // or file is corrupt. We wrap those in a generic store error.
        // @see https://www.sqlite.org/rescode.html
        {
          error: Error.transaction({ ...fact, in: session.id }, error as SqliteError),
        };
  }
};

export const assert = (
  session: Model,
  { the, of, is, cause }: Claim,
): Result<Assertion, ToJSON<ConflictError> | ToJSON<TransactionError>> =>
  execute(session.store.transaction(swap), session, {
    the,
    of,
    is,
    cause: cause == null ? init({ the, of }) : cause,
  });

export const retract = (
  session: Model,
  { the, of, cause, ...source }: Statement,
): Result<Retraction, ToJSON<ConflictError> | ToJSON<TransactionError>> =>
  execute(session.store.transaction(swap), session, {
    the,
    of,
    cause: cause == null ? init({ the, of }) : refer({ ...source, the, of, cause }),
  });

export const transact = (model: Model, transact: Transaction) =>
  transact.assert ? assert(model, transact.assert) : retract(model, transact.retract);

export const query = (
  { id, store }: Model,
  { the, of }: Selector,
): Result<Fact | Unclaimed, ToJSON<QueryError>> => {
  try {
    return { ok: pull({ id, store }, { the, of }) ?? implicit({ the, of }) };
  } catch (error) {
    return { error: Error.query({ the, of, in: id }, error as SqliteError) };
  }
};
