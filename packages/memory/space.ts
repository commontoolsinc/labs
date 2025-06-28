import {
  Database,
  SqliteError,
  Transaction as DBTransaction,
} from "@db/sqlite";

import { create as createCommit, the as COMMIT_THE } from "./commit.ts";
import { unclaimed } from "./fact.ts";
import { fromString, refer } from "./reference.ts";
import { addMemoryAttributes, traceAsync, traceSync } from "./telemetry.ts";
import type {
  Assert,
  Assertion,
  AsyncResult,
  AuthorizationError,
  Cause,
  Changes,
  Claim,
  Commit,
  CommitData,
  ConflictError,
  ConnectionError,
  DIDKey,
  Entity,
  Fact,
  FactSelection,
  MemorySpace,
  OfTheCause,
  Query,
  QueryError,
  Reference,
  Result,
  Retract,
  Revision,
  SchemaQuery,
  SelectAll,
  Selection,
  SpaceSession,
  SystemError,
  The,
  ToJSON,
  Transaction,
  TransactionError,
  Unit,
} from "./interface.ts";
import {
  getRevision,
  iterate,
  iterateSelector,
  set,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import { SelectAllString } from "./schema.ts";
import * as Error from "./error.ts";
import { selectSchema } from "./space-schema.ts";
import { JSONValue } from "@commontools/runner";
import { isObject } from "../utils/src/types.ts";
export type * from "./interface.ts";

export const PREPARE = `
BEGIN TRANSACTION;

-- Create table for storing JSON data.
-- ⚠️ We need make this NOT NULL because SQLite does not uphold uniqueness on NULL
CREATE TABLE IF NOT EXISTS datum (
  this TEXT NOT NULL PRIMARY KEY,     -- Merkle reference for this JSON
  source JSON                         -- Source for this JSON
);

-- We create special record to represent "undefined" which does not a valid
-- JSON data type. We need this record to join fact.is on datum.this
INSERT OR IGNORE INTO datum (this, source) VALUES ('undefined', NULL);

-- Fact table holds complete history of assertions and retractions. It has
-- n:1 mapping with datum table implying that we could have multiple entity
-- assertions with a same JSON value. Claimed n:1 mapping is guaranteed through
-- a foreign key constraint.
CREATE TABLE IF NOT EXISTS fact (
  this    TEXT NOT NULL PRIMARY KEY,  -- Merkle reference for { the, of, is, cause }
  the     TEXT NOT NULL,              -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,              -- Entity identifier fact is about
  'is'    TEXT NOT NULL,              -- Merkle reference of asserted value or "undefined" if retraction
  cause   TEXT,                       -- Causal reference to prior fact (It is NULL for a first assertion)
  since   INTEGER NOT NULL,           -- Lamport clock since when this fact was in effect
  FOREIGN KEY('is') REFERENCES datum(this)
);
-- Index via "since" field to allow for efficient time queries
CREATE INDEX IF NOT EXISTS fact_since ON fact (since); -- Index to query by "since" field

-- Memory table holds latest assertion / retraction for each entity. In theory
-- it has n:1 mapping with fact table, but in practice it is 1:1 mapping because
-- initial cause is derived from {the, of} seed and there for it is practically
-- guaranteed to be unique if we disregard astronomically tiny chance of hash
-- collision. Claimed n:1 mapping is guaranteed through a foreign key constraint.
CREATE TABLE IF NOT EXISTS memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  fact    TEXT NOT NULL,        -- Reference to the fact
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

-- Index so we can efficiently search by "the" field.
CREATE INDEX IF NOT EXISTS memory_the ON memory (the);
-- Index so we can efficiently search by "of" field.
CREATE INDEX IF NOT EXISTS memory_of ON memory (of);

-- State view is effectively a memory table with all the foreign keys resolved
-- Note we use a view because we have 1:n:m relation among memory:fact:datum
-- in order to deduplicate data.
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
JOIN
  -- We use inner join because we have 1:n mapping between memory:fact tables
  -- guaranteed through foreign key constraint.
  fact ON memory.fact = fact.this
  -- We use inner join here because we have 1:n mapping between fact:datum
  -- tables guaranteed through a foreign key constraint. We also prefer inner
  -- join because it's generally more efficient that outer join.
JOIN
  datum ON datum.this = fact.'is';

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
  the = :the
  AND of = :of
  AND fact = :cause;
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
ORDER BY
  since ASC
`;

export type Options = {
  url: URL;
};

export interface Session<Space extends MemorySpace> {
  subject: Space;
  store: Database;
}

class Space<Subject extends MemorySpace = MemorySpace>
  implements Session<Subject>, SpaceSession {
  constructor(public subject: Subject, public store: Database) {}

  transact(transaction: Transaction<Subject>) {
    return traceSync("space.instance.transact", (span) => {
      addMemoryAttributes(span, {
        operation: "transact",
        space: this.subject,
      });

      return transact(this, transaction);
    });
  }

  query(source: Query<Subject>) {
    return traceSync("space.instance.query", (span) => {
      addMemoryAttributes(span, {
        operation: "query",
        space: this.subject,
      });

      return query(this, source);
    });
  }

  querySchema(source: SchemaQuery<Subject>) {
    return traceSync("space.instance.querySchema", (span) => {
      addMemoryAttributes(span, {
        operation: "querySchema",
        space: this.subject,
      });

      return querySchema(this, source);
    });
  }

  close() {
    return traceSync("space.instance.close", (span) => {
      addMemoryAttributes(span, {
        operation: "close",
        space: this.subject,
      });

      return close(this);
    });
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
  return traceSync("space.readAddress", (span) => {
    span.setAttribute("space.url", url.toString());

    const { pathname } = url;
    const base = pathname.split("/").pop() as string;
    const did = base.endsWith(".sqlite")
      ? base.slice(0, -".sqlite".length)
      : base;
    span.setAttribute("space.did_candidate", did);

    if (!did.startsWith("did:key:")) {
      // ℹ️ We suppress error for now as we don't want to break clients that
      // use non did identifiers. We will make things stricter in the next
      // iteration
      console.error("Invalid DID key.");
      span.setAttribute("space.did_parse_error", true);
      return {
        ok: {
          address: url.protocol === "file:" ? url : null,
          subject: did as DIDKey,
        },
      };
    }

    span.setAttribute("space.did_parsed", true);
    return {
      ok: {
        address: url.protocol === "file:" ? url : null,
        subject: did as DIDKey,
      },
    };
  });
};

/**
 * Creates a connection to the existing replica. Errors if replica does not
 * exist.
 */
export const connect = async <Subject extends MemorySpace>({
  url,
}: Options): AsyncResult<Space<Subject>, ToJSON<ConnectionError>> => {
  return await traceAsync("space.connect", async (span) => {
    addMemoryAttributes(span, { operation: "connect" });
    span.setAttribute("space.url", url.toString());

    let database = null;
    try {
      const result = readAddress(url);
      if (result.error) {
        throw result.error;
      }
      const { address, subject } = result.ok;
      span.setAttribute("space.subject", subject);

      database = await new Database(address ?? ":memory:", {
        create: false,
      });
      database.exec(PREPARE);
      const session = new Space(subject as Subject, database);
      return { ok: session };
    } catch (cause) {
      if (database) {
        try {
          database.close();
        } catch (closeError) {
          console.error("Failed to close database after error:", closeError);
        }
      }
      return { error: Error.connection(url, cause as SqliteError) };
    }
  });
};

export const open = async <Subject extends MemorySpace>({
  url,
}: Options): AsyncResult<Space<Subject>, ConnectionError> => {
  return await traceAsync("space.open", async (span) => {
    addMemoryAttributes(span, { operation: "open" });
    span.setAttribute("space.url", url.toString());

    let database = null;
    try {
      const result = readAddress(url);
      if (result.error) {
        throw result.error;
      }
      const { address, subject } = result.ok;
      span.setAttribute("space.subject", subject);

      database = await new Database(address ?? ":memory:", {
        create: true,
      });
      database.exec(PREPARE);
      const session = new Space(subject as Subject, database);
      return { ok: session };
    } catch (cause) {
      // Ensure we close the database if it was opened but failed later
      if (database) {
        try {
          database.close();
        } catch (closeError) {
          // Just log the close error, but return the original error
          console.error("Failed to close database after error:", closeError);
          span.setAttribute("space.close_error", true);
        }
      }
      return { error: Error.connection(url, cause as SqliteError) };
    }
  });
};

export const close = <Space extends MemorySpace>({
  store,
}: Session<Space>): Result<Unit, SystemError> => {
  return traceSync("space.close", (span) => {
    addMemoryAttributes(span, { operation: "close" });

    try {
      store.close();
      return { ok: {} };
    } catch (cause) {
      return { error: cause as SqliteError };
    }
  });
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
): Revision<Fact> | null => {
  const row = store.prepare(EXPORT).get({ the, of }) as StateRow | undefined;
  if (row) {
    const revision: Revision<Fact> = {
      the,
      of,
      cause: row.cause
        ? (fromString(row.cause) as Reference<Assertion>)
        : refer(unclaimed(row)),
      since: row.since,
    };

    if (row.is) {
      revision.is = JSON.parse(row.is);
    }

    return revision;
  } else {
    return null;
  }
};

const select = <Space extends MemorySpace>(
  session: Session<Space>,
  { since, select }: Query["args"],
): Selection<Space>[Space] => {
  const factSelection: FactSelection = {}; // we'll store our facts here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  for (const entry of iterateSelector(select, {})) {
    const factSelector = {
      of: entry.of,
      the: entry.the,
      cause: entry.cause,
      since,
      ...entry.value.is ? { is: entry.value.is } : {},
    };
    loadFacts(factSelection, session, factSelector);
    if (entry.of !== SelectAllString) {
      const existing = getRevision(factSelection, entry.of, entry.the);
      if (existing === undefined) {
        // We return a result for each object queried, even if we didn't find it in the database
        if (entry.the === SelectAllString) {
          setEmptyObj(factSelection, entry.of);
        } else {
          setEmptyObj(factSelection, entry.of, entry.the);
        }
      }
    }
  }
  return factSelection;
};

export type FactSelector = {
  the: The | SelectAll;
  of: Entity | SelectAll;
  cause: Cause | SelectAll;
  is?: undefined | Record<string | number | symbol, never>;
  since?: number;
};

export type SelectedFact = {
  the: The;
  of: Entity;
  cause: Cause;
  is?: JSONValue;
  since: number;
};

// Select facts matching the selector. Facts are ordered by since.
export const selectFacts = function* <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of, cause, is, since }: FactSelector,
): Iterable<SelectedFact> {
  const rows = store.prepare(EXPORT).all({
    the: the === SelectAllString ? null : the,
    of: of === SelectAllString ? null : of,
    cause: cause === SelectAllString ? null : cause,
    is: is === undefined ? null : {},
    since: since ?? null,
  }) as StateRow[];

  for (const row of rows) {
    yield {
      the: row.the,
      of: row.of,
      cause: row.cause ?? refer(unclaimed(row)).toString() as Cause,
      is: row.is ? JSON.parse(row.is) as JSONValue : undefined,
      since: row.since,
    };
  }
};

export const selectFact = function <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of, since }: { the: The; of: Entity; since?: number },
): SelectedFact | undefined {
  const rows = store.prepare(EXPORT).all({
    the: the,
    of: of,
    cause: null,
    is: null,
    since: since ?? null,
  }) as StateRow[];
  if (rows.length > 0) {
    const row = rows[0];
    return {
      the: row.the,
      of: row.of,
      cause: row.cause ?? refer(unclaimed(row)).toString() as Cause,
      is: row.is ? JSON.parse(row.is) as JSONValue : undefined,
      since: row.since,
    };
  }
  return undefined;
};

/**
 * Imports datum into the `datum` table. If `datum` is undefined we return
 * special `"undefined"` for which `datum` table will have row with `NULL`
 * source. If `datum` already contains row for matching `datum` insert is
 * ignored because existing record will parse to same `datum` since primary
 * key is merkle-reference for it or an "undefined" for the `undefined`.
 */
const importDatum = <Space extends MemorySpace>(
  session: Session<Space>,
  datum: JSONValue | undefined,
): string => {
  if (datum === undefined) {
    return "undefined";
  } else {
    const is = refer(datum).toString();
    session.store.run(IMPORT_DATUM, {
      this: is,
      source: JSON.stringify(datum),
    });

    return is;
  }
};

const iterateTransaction = function* (
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

/**
 * Performs memory update with compare and swap (CAS) semantics. It will import
 * new data into `datum`, `fact` tables and update `memory` table to point to
 * new fact. All the updates occur in a single transaction to guarantee that
 * either all changes are made or no changes are. Function can also be passed
 * `Claim` in which case provided invariant is upheld, meaning no updates will
 * take place but error will be raised if claimed memory state is not current.
 */
const swap = <Space extends MemorySpace>(
  session: Session<Space>,
  source: Retract | Assert | Claim,
  { since, transaction }: { since: number; transaction: Transaction<Space> },
) => {
  const [{ the, of, is }, expect] = source.assert
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

  // If this is an assertion we need to import asserted datum and then insert
  // fact referencing it.
  if (source.assert || source.retract) {
    // First we import datum and and then use it's primary key as `is` field
    // in the `fact` table upholding foreign key constraint.
    session.store.run(IMPORT_FACT, {
      this: fact,
      the,
      of,
      is: importDatum(session, is),
      cause,
      since,
    });
  }

  // First assertion has a causal reference to the `type Unclaimed = { the, of }`
  // implicit fact for which no record in the memory table exists which is why
  // we simply insert into the memory table. However such memory record may
  // already exist in which case insert will be ignored. This can happen if
  // say we had assertions `a, b, c, a` last `a` will not not create any new
  // records and will be ignored. You may be wondering why do insert with an
  // ignore as opposed to do insert in if clause and update in the else block,
  // that is because we may also have assertions in this order `a, b, c, c`
  // where second `c` insert is redundant yet we do not want to fail transaction,
  // therefor we insert or ignore here to ensure fact record exists and then
  // use update afterwards to update to desired state from expected `cause` state.
  if (expected == null) {
    session.store.run(IMPORT_MEMORY, { the, of, fact });
  }

  // Finally we perform a memory swap, using conditional update so it only
  // updates memory if the `cause` references expected state. We use return
  // value to figure out whether update took place, if it is `0` no records
  // were updated indicating potential conflict which we handle below.
  const updated = session.store.run(SWAP, { fact, cause, the, of });

  // If no records were updated it implies that there was no record with
  // matching `cause`. It may be because `cause` referenced implicit fact
  // in which case which case `IMPORT_MEMORY` provisioned desired record and
  // update would not have applied. Or it could be that `cause` in the database
  // is different from the one being asserted. We will assess this by pulling
  // the record and comparing it to desired state.
  if (updated === 0) {
    const revision = recall(session, { the, of });
    const { since, ...actual } = revision ? revision : { actual: null };

    // If actual state matches desired state it either was inserted by the
    // `IMPORT_MEMORY` or this was a duplicate call. Either way we do not treat
    // it as a conflict as current state is the asserted one.
    if (refer(actual).toString() !== fact) {
      throw Error.conflict(transaction, {
        space: transaction.sub,
        the,
        of,
        expected,
        actual: revision as Revision<Fact>,
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

  for (const fact of iterateTransaction(transaction)) {
    swap(session, fact, commit.is);
  }

  swap(session, { assert: commit }, commit.is);

  // attach labels to the commit, so the provider can remove any classified entries from the commit before we send it to subscribers
  // For this, we need since fields on our objects
  const changedFacts = toSelection(
    commit.is.since,
    commit.is.transaction.args.changes,
  );
  const labels = getLabels(session, changedFacts);
  if (Object.keys(labels).length > 0) {
    commit.is.labels = labels;
  }
  const changes: Commit<Space> = {} as Commit<Space>;
  set(changes, commit.of, commit.the, commit.cause.toString(), {
    is: commit.is,
  });
  return changes;
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
) => {
  return traceSync("space.transact", (span) => {
    addMemoryAttributes(span, {
      operation: "transact",
      space: session.subject,
    });
    if (transaction.args?.changes) {
      span.setAttribute("memory.has_changes", true);
    }

    return execute(session.store.transaction(commit), session, transaction);
  });
};

export const query = <Space extends MemorySpace>(
  session: Session<Space>,
  command: Query<Space>,
): Result<Selection<Space>, QueryError> => {
  return traceSync("space.query", (span) => {
    addMemoryAttributes(span, {
      operation: "query",
      space: session.subject,
    });

    if (command.args?.select) {
      span.setAttribute("query.has_selector", true);
    }
    if (command.args?.since !== undefined) {
      span.setAttribute("query.since", command.args.since);
    }

    try {
      const result = session.store.transaction(select)(session, command.args);

      const entities = Object.keys(result || {}).length;
      span.setAttribute("query.result_entity_count", entities);

      return {
        ok: {
          [command.sub]: result,
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
  });
};

export const querySchema = <Space extends MemorySpace>(
  session: Session<Space>,
  command: SchemaQuery<Space>,
): Result<Selection<Space>, AuthorizationError | QueryError> => {
  return traceSync("space.querySchema", (span) => {
    addMemoryAttributes(span, {
      operation: "querySchema",
      space: session.subject,
    });

    if (command.args?.selectSchema) {
      span.setAttribute("querySchema.has_selector", true);
    }
    if (command.args?.since !== undefined) {
      span.setAttribute("querySchema.since", command.args.since);
    }

    try {
      const result = session.store.transaction(selectSchema)(
        session,
        command.args,
      );

      const entities = Object.keys(result || {}).length;
      span.setAttribute("querySchema.result_entity_count", entities);

      return {
        ok: {
          [command.sub]: result,
        } as Selection<Space>,
      };
    } catch (error) {
      if ((error as Error)?.name === "AuthorizationError") {
        return { error: error as AuthorizationError };
      }
      return {
        error: Error.query(
          command.sub,
          command.args.selectSchema,
          error as SqliteError,
        ),
      };
    }
  });
};

export const LABEL_THE = "application/label+json" as const;
export type FactSelectionValue = { is?: JSONValue; since: number };
// Get the labels associated with a set of commits.
// It's possible to get more than one label for a single doc because our
// includedFacts may include more than one cause for a single doc.
export function getLabels<
  Space extends MemorySpace,
  T,
>(
  session: Session<Space>,
  includedFacts: OfTheCause<Revision<T>>,
): OfTheCause<FactSelectionValue> {
  const labels: OfTheCause<FactSelectionValue> = {};
  for (const fact of iterate(includedFacts)) {
    const labelFact = getLabel(session, fact.of);
    if (labelFact !== undefined) {
      set<FactSelectionValue, OfTheCause<FactSelectionValue>>(
        labels,
        labelFact.of,
        labelFact.the,
        labelFact.cause,
        {
          since: labelFact.since,
          ...(labelFact.is ? { is: labelFact.is } : {}),
        },
      );
    }
  }
  return labels;
}

// Get the label that applies to the entity.
export function getLabel<Space extends MemorySpace>(
  session: Session<Space>,
  of: Entity,
) {
  return selectFact(session, { of, the: LABEL_THE });
}

// Get the various classification tags required based on the collection of labels.
export function collectClassifications(
  labels: OfTheCause<FactSelectionValue>,
) {
  const classifications = new Set<string>();
  for (const fact of iterate(labels)) {
    getClassifications(fact.value, classifications);
  }
  return classifications;
}

export function getClassifications(
  fact: FactSelectionValue,
  classifications = new Set<string>(),
) {
  if (
    fact === undefined || !isObject(fact.is) ||
    !("classification" in fact.is) || !Array.isArray(fact.is["classification"])
  ) {
    return classifications;
  }
  const labels = fact.is["classification"] as string[];
  for (const label of labels) {
    classifications.add(label);
  }
  return classifications;
}

export function redactCommit(commit: Commit): Commit {
  const newCommit = {};
  for (const item of iterate(commit)) {
    const redactedData = redactCommitData(item.value.is);
    set(newCommit, item.of, item.the, item.cause, { is: redactedData });
  }
  return newCommit;
}

// Return the item with any classified results and the labels removed.
export function redactCommitData(
  commitData?: CommitData,
): CommitData | undefined {
  if (commitData === undefined || commitData.labels === undefined) {
    return commitData;
  }
  // Make a copy of the transaction with no changes
  const newChanges: Changes = {};
  // Add any non-redacted changes to the newCommitData
  for (const fact of iterate(commitData.transaction.args.changes)) {
    if (fact.value === true) {
      continue;
    }
    const labelFact = getRevision(commitData.labels, fact.of, LABEL_THE);
    if (labelFact !== undefined && getClassifications(labelFact).size > 0) {
      setEmptyObj(newChanges, fact.of, fact.the);
    } else {
      set(newChanges, fact.of, fact.the, fact.cause, fact.value);
    }
  }
  const newCommitData = {
    since: commitData.since,
    transaction: {
      ...commitData.transaction,
      args: { ...commitData.transaction.args, changes: newChanges },
    },
  };
  return newCommitData;
}

function loadFacts<Space extends MemorySpace>(
  selection: FactSelection,
  session: Session<Space>,
  factSelector: FactSelector,
): FactSelection {
  for (
    const fact of selectFacts(session, factSelector)
  ) {
    const value = (fact.is !== undefined)
      ? { is: fact.is, since: fact.since }
      : { since: fact.since };
    setRevision(selection, fact.of, fact.the, fact.cause, value);
  }
  return selection;
}

// Converts a Changes object to a FactSelection
export function toSelection(
  since: number,
  commitChanges: Changes,
) {
  const result = {};
  for (const change of iterate(commitChanges)) {
    if (change.value === true) {
      continue;
    }
    setRevision(
      result,
      change.of,
      change.the,
      change.cause,
      change.value.is
        ? { is: change.value.is, since: since }
        : { since: since },
    );
  }
  return result;
}
