import {
  Database,
  SqliteError,
  Transaction as DBTransaction,
} from "jsr:@db/sqlite";
import { fromString, refer } from "./reference.ts";
import { unclaimed } from "./fact.ts";
import { from as toChanges, set } from "./changes.ts";
import { create as createCommit, the as COMMIT_THE } from "./commit.ts";
import { fromDID as parseDID } from "./principal.ts";
import type {
  Assert,
  Assertion,
  AsyncResult,
  Claim,
  Commit,
  CommitData,
  ConflictError,
  ConnectionError,
  DIDKey,
  Entity,
  Fact,
  JSONValue,
  MemorySpace,
  Principal,
  Query,
  QueryError,
  Reference,
  Result,
  Retract,
  Selection,
  SpaceSession,
  SystemError,
  The,
  ToJSON,
  Transaction,
  TransactionError,
  Unit,
} from "./interface.ts";
import * as Error from "./error.ts";
export * from "./interface.ts";

export const PREPARE = `
BEGIN TRANSACTION;

-- Create table for storing JSON data.
-- ⚠️ We need make this NOT NULL because SQLite does not uphold uniqueness on NULL
CREATE TABLE IF NOT EXISTS datum (
  this TEXT NOT NULL PRIMARY KEY,     -- Merkle reference for this JSON
  source JSON                         -- Source for this JSON
);

-- We create special record to represent undefined which does not exist in JSON.
-- This allows us to join fact with datum table and cover retractions where
-- fact.is is set to NULL
INSERT OR IGNORE INTO datum (this, source) VALUES ('undefined', NULL);


CREATE TABLE IF NOT EXISTS fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference for { the, of, is, cause }
  the     TEXT NOT NULL,              -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,              -- Entity identifier fact is about
  'is'    TEXT,                       -- Value entity is claimed to have
  cause   TEXT,                       -- Causal reference to prior fact
  since   INTEGER NOT NULL,           -- Lamport clock since when this fact was in effect
  FOREIGN KEY('is') REFERENCES datum(this)
);

CREATE TABLE IF NOT EXISTS memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  fact    TEXT NOT NULL,          -- Link to the fact,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

CREATE INDEX IF NOT EXISTS memory_the ON memory (the); -- Index to filter by "the" field
CREATE INDEX IF NOT EXISTS memory_of ON memory (of);   -- Index to query by "of" field
CREATE INDEX IF NOT EXISTS fact_since ON fact (since); -- Index to query by "since" field

-- Create the updated 'state' view
CREATE VIEW IF NOT EXISTS state AS
SELECT
  memory.the AS the,
  memory.of AS of,
  datum.source AS 'is',
  fact.cause AS cause,
  memory.fact AS fact,
  datum.this AS proof,
  fact.since AS since
FROM
  memory
-- We use inner join because we memory.fact can not be NULL and as foreign
-- key into fact.this which is also primary key. This guarantees that we will
-- not have any memory record with corresponding fact record
JOIN
  fact ON memory.fact = fact.this
-- We use inner join here because fact.is || 'undefined' is guaranteed to have
-- corresponding record in datum through a foreign key constraint and inner
-- joins are generally more efficient that left joins.
-- ⚠️ Also note that we use COALESCE operator to use 'undefined' in case where
-- there fact.is NULL (retractions), which is important because SQLite never
-- matches over fact.is = NULL.
JOIN
  datum ON datum.this = COALESCE(fact.'is', 'undefined');

COMMIT;
`;

const IMPORT_DATUM =
  `INSERT OR IGNORE INTO datum (this, source) VALUES (:this, :source);`;

const IMPORT_FACT =
  `INSERT OR IGNORE INTO fact (this, the, of, 'is', cause, since) VALUES (:this, :the, :of, :is, :cause, :since);`;

const IMPORT_MEMORY =
  `INSERT OR IGNORE INTO memory (the, of, fact) VALUES (:the, :of, :fact);`;

const SWAP = `UPDATE memory
  SET fact = :fact
WHERE
  fact = :cause
  AND the = :the
  AND of = :of;
`;

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
  AND (:cause is NULL OR state.cause = :cause)
  AND (:since is NULL or state.since > :since)
`;

export type Options = {
  url: URL;
};

interface Session<Space extends MemorySpace> {
  subject: Space;
  store: Database;
}

class Space<Subject extends MemorySpace = MemorySpace>
  implements Session<Subject>, SpaceSession {
  constructor(public subject: Subject, public store: Database) {}

  transact(transaction: Transaction<Subject>) {
    return transact(this, transaction);
  }

  query(source: Query<Subject>) {
    return query(this, source);
  }

  close() {
    return close(this);
  }
}

export type { Space as View };

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
const readAddress = (
  url: URL,
): Result<{ subject: MemorySpace; address: URL | null }, SyntaxError> => {
  const { pathname } = url;
  const base = pathname.split("/").pop() as string;
  const did = base.endsWith(".sqlite")
    ? base.slice(0, -".sqlite".length)
    : base;
  const { ok: principal, error } = parseDID(did);
  if (error) {
    // return { error };
    // ℹ️ We suppress error for now as we don't want to break clients that
    // use non did identifiers. We will make things stricter in the next
    // iteration
    console.error(error);
    return {
      ok: {
        address: url.protocol === "file:" ? url : null,
        subject: did as DIDKey,
      },
    };
  }

  return {
    ok: {
      address: url.protocol === "file:" ? url : null,
      subject: principal.did(),
    },
  };
};

/**
 * Creates a connection to the existing replica. Errors if replica does not
 * exist.
 */
export const connect = async <Subject extends MemorySpace>({
  url,
}: Options): AsyncResult<Space<Subject>, ToJSON<ConnectionError>> => {
  try {
    const result = readAddress(url);
    if (result.error) {
      throw result.error;
    }
    const { address, subject } = result.ok;

    const database = await new Database(address ?? ":memory:", {
      create: false,
    });
    database.exec(PREPARE);
    const session = new Space(subject as Subject, database);
    return { ok: session };
  } catch (cause) {
    return { error: Error.connection(url, cause as SqliteError) };
  }
};

export const open = async <Subject extends MemorySpace>({
  url,
}: Options): AsyncResult<Space<Subject>, ConnectionError> => {
  try {
    const result = readAddress(url);
    if (result.error) {
      throw result.error;
    }
    const { address, subject } = result.ok;
    const database = await new Database(address ?? ":memory:", {
      create: true,
    });
    database.exec(PREPARE);
    const session = new Space(subject as Subject, database);
    return { ok: session };
  } catch (cause) {
    return { error: Error.connection(url, cause as SqliteError) };
  }
};

export const close = <Space extends MemorySpace>({
  store,
}: Session<Space>): Result<Unit, SystemError> => {
  try {
    store.close();
    return { ok: {} };
  } catch (cause) {
    return { error: cause as SqliteError };
  }
};

type StateRow = {
  fact: string;
  the: string;
  of: Entity;
  is: string | null;
  cause: string | null;
  since: number;
};

const recall = <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of }: { the: The; of: Entity },
): { fact: Fact | null; since?: number; id?: string } => {
  const row = store.prepare(EXPORT).get({ the, of }) as StateRow | undefined;
  if (row) {
    const fact: Fact = {
      the,
      of,
      cause: row.cause
        ? (fromString(row.cause) as Reference<Assertion>)
        : refer(unclaimed(row)),
    };

    if (row.is) {
      fact.is = JSON.parse(row.is);
    }

    return { fact, id: row.fact, since: row.since };
  } else {
    return { fact: null };
  }
};

const select = <Space extends MemorySpace>(
  { store }: Session<Space>,
  { since, select }: Query["args"],
): Selection<Space>[Space] => {
  const selection = {};
  const all = [[SelectAll, {}]] as const;
  const selector = Object.entries(select);
  for (const [of, attributes] of selector.length > 0 ? selector : all) {
    if (of !== SelectAll) {
      set(selection, [], of, {});
    }

    const selector = Object.entries(attributes);
    for (const [the, revisions] of selector.length > 0 ? selector : all) {
      if (the !== SelectAll && of !== SelectAll) {
        set(selection, [of], the, {});
      }

      const selector = Object.entries(revisions);
      for (const [cause, match] of selector.length > 0 ? selector : all) {
        const rows = store.prepare(EXPORT).all({
          the: the === SelectAll ? null : the,
          of: of === SelectAll ? null : of,
          cause: cause === SelectAll ? null : cause,
          is: (match as { is?: Unit }).is === undefined ? null : {},
          since: since ?? null,
        }) as StateRow[];

        for (const row of rows) {
          set(
            selection,
            [row.of, row.the],
            row.cause ?? refer(unclaimed(row)).toString(),
            row.is ? { is: JSON.parse(row.is) } : {},
          );
        }
      }
    }
  }

  return selection;
};

const importDatum = <Space extends MemorySpace>(
  session: Session<Space>,
  source: Assertion,
): Reference<JSONValue> => {
  const is = refer(source.is);
  session.store.run(IMPORT_DATUM, {
    this: is.toString(),
    source: JSON.stringify(source.is),
  });
  return is;
};

const iterate = function* (
  transaction: Transaction,
): Iterable<Retract | Assert | Claim> {
  for (const [of, attributes] of Object.entries(transaction.args.changes)) {
    for (const [the, revisions] of Object.entries(attributes)) {
      for (const [cause, change] of Object.entries(revisions)) {
        if (change == true) {
          yield { claim: { the, of, fact: fromString(cause) } } as Claim;
        } else if (change.is === undefined) {
          yield { retract: { the, of, cause: fromString(cause) } } as Retract;
        } else {
          yield {
            assert: { the, of, is: change.is, cause: fromString(cause) },
          } as Assert;
        }
      }
    }
  }
};

const swap = <Space extends MemorySpace>(
  session: Session<Space>,
  source: Retract | Assert | Claim,
  { since, transaction }: { since: number; transaction: Transaction<Space> },
) => {
  const [{ the, of }, expect] = source.assert
    ? [source.assert, source.assert.cause]
    : source.retract
    ? [source.retract, source.retract.cause]
    : [source.claim, source.claim.fact];
  const cause = expect.toString();
  const base = refer(unclaimed({ the, of })).toString();
  const expected = cause === base ? null : (expect as Reference<Fact>);

  // Derive the merkle reference to the fact that memory will have after
  // successful update. If we have an assertion or retraction we derive fact
  // from it, but if it is a confirmation `cause` is the fact itself.
  const fact = source.assert
    ? refer(source.assert).toString()
    : source.retract
    ? refer(source.retract).toString()
    : source.claim.fact.toString();

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
    session.store.run(IMPORT_MEMORY, { the, of, fact });
  }

  // Here we finally perform a memory swap. Note that update is conditional and
  // will only update if current record has the same `cause` reference. If that
  // is not the case 0 records will be updated indicating a conflict handled
  // below. Note that passing `the` and `of` is required, if omitted we may
  // update another memory which has passed `cause`.
  const updated = session.store.run(SWAP, { fact, cause, the, of });

  // If no records were updated it implies that there was no record with
  // matching `cause`. It may be because `cause` referenced implicit fact
  // in which case which case `IMPORT_MEMORY` provisioned desired record and
  // update would not have applied. Or it could be that `cause` in the database
  // is different from the one being asserted. We will asses this by pulling
  // the record and comparing it to desired state.
  if (updated === 0) {
    const { fact: actual } = recall(session, { the, of });

    // If actual state matches desired state it is either was inserted by the
    // `IMPORT_MEMORY` or this was a duplicate call. Either way we do not treat
    // it as a conflict as current state is the asserted one.
    if (refer(actual).toString() !== fact) {
      throw Error.conflict(transaction, {
        space: transaction.sub,
        the,
        of,
        expected,
        actual,
      });
    }
  }
};

const commit = <Space extends MemorySpace>(
  session: Session<Space>,
  transaction: Transaction<Space>,
): Commit<Space> => {
  const the = COMMIT_THE;
  const of = transaction.sub;
  const row = session.store.prepare(EXPORT).get({ the, of }) as
    | StateRow
    | undefined;

  const [since, cause] = row
    ? [
      (JSON.parse(row.is as string) as CommitData).since + 1,
      fromString(row.fact) as Reference<Assertion>,
    ]
    : [0, refer(unclaimed({ the, of }))];

  const commit = createCommit({ space: of, since, transaction, cause });

  for (const fact of iterate(transaction)) {
    swap(session, fact, commit.is);
  }

  swap(session, { assert: commit }, commit.is);

  return toChanges([commit]);
};

const execute = <
  Subject extends MemorySpace,
  Tr extends DBTransaction<
    (
      session: Session<Subject>,
      transaction: Transaction<Subject>,
    ) => Commit<Subject>
  >,
>(
  update: Tr,
  session: Session<Subject>,
  transaction: Transaction<Subject>,
): Result<Commit<Subject>, ConflictError | TransactionError> => {
  try {
    return {
      ok: update(session, transaction),
    };
  } catch (error) {
    return (error as Error).name === "ConflictError"
      ? { error: error as ToJSON<ConflictError> }
      // SQLite transactions may produce various errors when DB is busy, locked
      // or file is corrupt. We wrap those in a generic store error.
      // @see https://www.sqlite.org/rescode.html
      : {
        error: Error.transaction(transaction, error as SqliteError),
      };
  }
};

export const transact = <Space extends MemorySpace>(
  session: Session<Space>,
  transaction: Transaction<Space>,
) => execute(session.store.transaction(commit), session, transaction);

export const query = <Space extends MemorySpace>(
  session: Session<Space>,
  command: Query<Space>,
): Result<Selection<Space>, QueryError> => {
  try {
    return {
      ok: {
        [command.sub]: session.store.transaction(select)(session, command.args),
      } as Selection<Space>,
    };
  } catch (error) {
    return {
      error: Error.query(
        command.sub,
        command.args.select,
        error as SqliteError,
      ),
    };
  }
};

const SelectAll = "_";
