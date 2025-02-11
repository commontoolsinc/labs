import { Database, Transaction as DBTransaction, SqliteError } from "jsr:@db/sqlite";
import { fromString, refer, Reference } from "npm:merkle-reference";
import type {
  Result,
  Space,
  Entity,
  The,
  Fact,
  Transaction,
  JSONValue,
  ConflictError,
  TransactionError,
  QueryError,
  ToJSON,
  ConnectionError,
  Unclaimed,
  Commit,
  Assertion,
  AsyncResult,
  SystemError,
  Retract,
  Assert,
  Confirm,
  ListError,
  Principal,
  Query,
  Changes,
  State,
  Meta,
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
  since   INTEGER NOT NULL,     -- Lamport clock since when this fact was in effect
  FOREIGN KEY('is') REFERENCES datum(this)
);

CREATE TABLE IF NOT EXISTS memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  fact  TEXT NOT NULL,          -- Link to the fact,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

CREATE INDEX memory_the ON memory (the); -- Index to filter by "the" field
CREATE INDEX memory_of ON memory (of);   -- Index to query by "of" field

CREATE VIEW IF NOT EXISTS state AS
SELECT
  memory.the as the,
  memory.of as of,
  maybe_datum.source as 'is',
  fact.cause as cause,
  memory.fact as fact,
  maybe_datum.this as proof,
  fact.since as since
FROM
  memory
JOIN
  fact ON memory.fact = fact.this
JOIN
  maybe_datum ON fact.'is' = maybe_datum.this OR (fact.'is' IS NULL AND maybe_datum.this IS NULL);

COMMIT;
`;

const IMPORT_DATUM = `INSERT OR IGNORE INTO datum (this, source) VALUES (:this, :source);`;

const IMPORT_FACT = `INSERT OR IGNORE INTO fact (this, the, of, 'is', cause, since) VALUES (:this, :the, :of, :is, :cause, :since);`;

const IMPORT_MEMORY = `INSERT OR IGNORE INTO memory (the, of, fact) VALUES (:the, :of, :fact);`;

const SWAP = `UPDATE memory SET fact = :fact
WHERE
(:cause IS NULL AND fact IS NULL) OR fact = :cause;`;

const EXPORT = `SELECT
  state.the as the,
  state.of as of,
  state.'is' as 'is',
  state.cause as cause,
  state.since as since,
  state.fact as fact
FROM
  state
WHERE
  (:the IS NULL OR state.the = :the)
  AND (:of IS NULL OR state.of = :of)
  AND (:is IS NULL OR state.'is' IS NOT NULL)
  AND (:since is NULL or state.since > :since)
`;

export type Options = {
  url: URL;
};

export interface Model {
  id: Space;
  store: Database;
}

export interface Selector {
  the?: The;
  of?: Entity;
  is?: {};
  since?: number;
}

export interface ListResult {
  of: Entity;
  is?: JSONValue;
}

export interface Session {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact(transact: Transaction): Result<Commit, ToJSON<ConflictError> | ToJSON<TransactionError>>;

  /**
   * Queries space for matching entities based on provided selector.
   */
  query(source: Query): Result<Fact[], ToJSON<QueryError>>;

  close(): AsyncResult<{}, SystemError>;
}

export class Store implements Model, Session {
  constructor(public id: Space, public store: Database) {}

  transact(transaction: Transaction) {
    return transact(this, transaction);
  }

  query(source: Query) {
    return query(this, source);
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

type StateRow = {
  fact: string;
  the: string;
  of: Entity;
  is: string;
  cause: string | null;
  since: number;
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
  the = "application/json",
  of,
}: {
  the?: string;
  of: Entity;
}): Reference<Assertion> => refer(implicit({ the, of }));

const select = ({ store }: Model, { the, of, is, since }: Selector): Fact[] => {
  const rows = store.prepare(EXPORT).all({
    the: the ?? null,
    of: of ?? null,
    is: is === undefined ? null : {},
    since: since ?? null,
  }) as StateRow[];

  return rows.map((row) => ({
    the: row.the,
    of: row.of,
    ...(row.is ? { is: JSON.parse(row.is) } : {}),
    cause: (row.cause ? fromString(row.cause) : init(row)) as Reference<Assertion>,
  }));
};

const importDatum = (session: Model, source: Assertion): Reference<JSONValue> => {
  const is = refer(source.is);
  session.store.run(IMPORT_DATUM, {
    this: is.toString(),
    source: JSON.stringify(source.is),
  });
  return is;
};

const iterate = function* (transaction: Transaction): Iterable<Retract | Assert | Confirm> {
  for (const [the, entities] of Object.entries(transaction.args.changes)) {
    for (const [of, changes] of Object.entries(entities)) {
      for (const [cause, change] of Object.entries(changes)) {
        if (change == null) {
          yield { retract: { the, of, cause: fromString(cause) } } as Retract;
        } else if (change.is === undefined) {
          yield { confirm: { the, of, cause: fromString(cause) } } as Confirm;
        } else {
          yield { assert: { the, of, is: change.is, cause: fromString(cause) } } as Assert;
        }
      }
    }
  }
};

const swap = (
  session: Model,
  source: Retract | Assert | Confirm,
  { since, transaction }: { since: number; transaction: Transaction },
) => {
  const claim = source.assert ?? source.retract ?? source.confirm;
  const { the, of } = claim;

  // Derive the merkle reference to the fact that memory will have after
  // successful update. If we have an assertion or retraction we derive fact
  // from it, but if it is a confirmation `cause` is the fact itself.
  const fact = source.assert
    ? refer({ is: claim.is, cause: claim.cause }).toString()
    : source.retract
    ? refer({ cause: claim.cause }).toString()
    : source.confirm.cause.toString();

  // We do not store implicit facts like `{ the, of }` in the database and
  // we represent causal reference to such implicit facts via `NULL`, therefore
  // we asses if causal reference is to an implicit and if so substitute it
  // with `null`. We also use `null` for an implicit `cause` in the
  // `RevisionError`, that is because callers aren't expected to specify them
  // explicitly and telling in the error that hash to implicit was expected
  // would be confusing.
  const expected =
    claim.cause?.toString() === init(claim).toString() ? null : (claim.cause as Reference<Fact>);
  const cause = expected?.toString() ?? null;

  // If this is an assertion we need to import asserted data and then insert
  // fact referencing it. If it is retraction we don't have data to import
  // but we do still need to create fact record.
  if (source.assert || source.retract) {
    // First we import JSON value in the `is` field into the `datum` table and
    // then we import the fact into the `factor` table. If `datum` already exists
    // we ignore as we key those by the merkle reference. Same is true for the
    // `factor` table where we key by the merkle reference of the fact so if
    // conflicting record exists it is the same record and we ignore.
    session.store.run(IMPORT_FACT, {
      this: fact,
      the,
      of,
      is: source.assert ? importDatum(session, source.assert).toString() : null,
      cause,
      since,
    });
  }

  // Now if referenced cause is for an implicit fact, we will not have a record
  // for it in the memory table to update in the next step. We also can not
  // create such record as we don't have corresponding records in the `fact`
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
    const actual = select(session, { the, of })[0] ?? null;

    // If actual state matches desired state it is either was inserted by the
    // `IMPORT_MEMORY` or this was a duplicate call. Either way we do not treat
    // it as a conflict as current state is the asserted one.
    if (identify(actual ?? { cause: null }) !== fact) {
      throw Error.conflict(transaction, {
        in: transaction.sub,
        the,
        of,
        expected,
        actual,
      });
    }
  }
};

const identify = ({ is, cause }: Fact) =>
  (is === undefined ? refer({ cause }) : refer({ cause, is })).toString();

const THE_COMMIT = "application/commit+json";

const toSubjectEntity = (subject: Space) => refer(subject).toString();

/**
 * Derives a fact for the commit entity from the source data.
 */
export const toCommit = ({
  subject,
  is,
  cause,
}: {
  subject: Space;
  is: Commit["is"];
  cause?: Reference<Fact>;
}) => {
  const of = toSubjectEntity(subject);
  return {
    the: THE_COMMIT,
    of,
    is,
    cause: cause ?? init({ the: THE_COMMIT, of }),
  };
};

const commit = (session: Model, transaction: Transaction): Commit => {
  const space = toSubjectEntity(transaction.sub);
  const row = session.store.prepare(EXPORT).get({
    the: THE_COMMIT,
    of: space,
  }) as StateRow | undefined;

  const [since, cause] = row
    ? [(JSON.parse(row.is) as Commit["is"]).since + 1, fromString(row.fact) as Reference<Assertion>]
    : [0, init({ the: THE_COMMIT, of: space })];

  for (const fact of iterate(transaction)) {
    swap(session, fact, { since, transaction });
  }

  const commit = toCommit({
    subject: transaction.sub,
    is: {
      since,
      transaction,
    },
    cause,
  });

  swap(session, { assert: commit }, { since, transaction });

  return commit;
};

const execute = <Tr extends DBTransaction<(session: Model, transaction: Transaction) => Commit>>(
  commit: Tr,
  session: Model,
  transaction: Transaction,
): Result<Commit, ToJSON<ConflictError> | ToJSON<TransactionError>> => {
  try {
    return {
      ok: commit(session, transaction),
    };
  } catch (error) {
    return (error as Error).name === "ConflictError"
      ? { error: error as ToJSON<ConflictError> }
      : // SQLite transactions may produce various errors when DB is busy, locked
        // or file is corrupt. We wrap those in a generic store error.
        // @see https://www.sqlite.org/rescode.html
        {
          error: Error.transaction(transaction, error as SqliteError),
        };
  }
};

export const transaction = ({
  issuer,
  subject,
  changes,
  meta,
}: {
  issuer: Principal;
  subject: Space;
  changes: Changes;
  meta?: Meta;
}): Transaction => ({
  cmd: "/memory/transact",
  iss: issuer,
  sub: subject,
  args: { changes },
  ...(meta ? { meta } : undefined),
});

export const transact = (session: Model, transaction: Transaction) =>
  execute(session.store.transaction(commit), session, transaction);

export const query = (session: Model, source: Query): Result<Fact[], ToJSON<QueryError>> => {
  try {
    return { ok: select(session, source.args.selector) };
  } catch (error) {
    const { the, of } = source.args.selector;
    return { error: Error.query({ the, of, in: session.id }, error as SqliteError) };
  }
};
