import {
  Database,
  SqliteError,
  Statement,
  Transaction as DBTransaction,
} from "@db/sqlite";

import { COMMIT_LOG_TYPE, create as createCommit } from "./commit.ts";
import * as SelectionBuilder from "./selection.ts";
import { unclaimedRef } from "./fact.ts";
import { fromString, refer } from "./reference.ts";
import { addMemoryAttributes, traceAsync, traceSync } from "./telemetry.ts";
import type {
  Assert,
  Assertion,
  AsyncResult,
  AuthorizationError,
  CauseString,
  Changes,
  Claim,
  Commit,
  CommitData,
  ConflictError,
  ConnectionError,
  DIDKey,
  Fact,
  FactAddress,
  FactSelection,
  MemorySpace,
  MIME,
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
  ToJSON,
  Transaction,
  TransactionError,
  Unit,
  URI,
} from "./interface.ts";
import {
  getRevision,
  iterate,
  iterateSelector,
  SelectAllString,
  set,
  setEmptyObj,
  setRevision,
} from "./selection.ts";
import * as Error from "./error.ts";
import { selectSchema, type SelectSchemaResult } from "./space-schema.ts";
export type { SelectSchemaResult } from "./space-schema.ts";
import { StorableDatum, StorableValue } from "./interface.ts";
import { isObject } from "../utils/src/types.ts";
export type * from "./interface.ts";

export const PREPARE = `
BEGIN TRANSACTION;

-- Value store (replaces v1 datum)
CREATE TABLE IF NOT EXISTS value (
  hash  TEXT NOT NULL PRIMARY KEY,
  data  JSON
);
INSERT OR IGNORE INTO value (hash, data) VALUES ('undefined', NULL);
INSERT OR IGNORE INTO value (hash, data) VALUES ('__empty__', NULL);

-- Commit log
CREATE TABLE IF NOT EXISTS "commit" (
  hash        TEXT    NOT NULL PRIMARY KEY,
  version     INTEGER NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  reads       JSON,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commit_version ON "commit" (version);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON "commit" (branch);

-- Fact history (replaces v1 fact, adds branch/commit_ref/fact_type/type)
CREATE TABLE IF NOT EXISTS fact (
  hash        TEXT    NOT NULL PRIMARY KEY,
  type        TEXT    NOT NULL DEFAULT 'application/json',
  id          TEXT    NOT NULL,
  value_ref   TEXT    NOT NULL,
  parent      TEXT,
  branch      TEXT    NOT NULL DEFAULT '',
  version     INTEGER NOT NULL,
  commit_ref  TEXT    NOT NULL,
  fact_type   TEXT    NOT NULL DEFAULT 'set',
  FOREIGN KEY (value_ref)  REFERENCES value(hash),
  FOREIGN KEY (commit_ref) REFERENCES "commit"(hash)
);
CREATE INDEX IF NOT EXISTS idx_fact_version    ON fact (version);
CREATE INDEX IF NOT EXISTS idx_fact_id         ON fact (id);
CREATE INDEX IF NOT EXISTS idx_fact_id_version ON fact (id, version);
CREATE INDEX IF NOT EXISTS idx_fact_commit     ON fact (commit_ref);
CREATE INDEX IF NOT EXISTS idx_fact_branch     ON fact (branch);

-- Current head per entity (replaces v1 memory, adds branch/version)
CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL DEFAULT '',
  type      TEXT    NOT NULL DEFAULT 'application/json',
  id        TEXT    NOT NULL,
  fact_hash TEXT    NOT NULL,
  version   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (branch, type, id),
  FOREIGN KEY (fact_hash) REFERENCES fact(hash)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);
CREATE INDEX IF NOT EXISTS idx_head_type   ON head (type);
CREATE INDEX IF NOT EXISTS idx_head_id     ON head (id);

-- Snapshots for patch acceleration
CREATE TABLE IF NOT EXISTS snapshot (
  id         TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  value_ref  TEXT    NOT NULL,
  branch     TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (branch, id, version),
  FOREIGN KEY (value_ref) REFERENCES value(hash)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, version);

-- Branch metadata
CREATE TABLE IF NOT EXISTS branch (
  name            TEXT    NOT NULL PRIMARY KEY,
  parent_branch   TEXT,
  fork_version    INTEGER,
  head_version    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, head_version) VALUES ('', 0);

-- Blob storage
CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

-- Backward-compatible state view (v1 column aliases, default branch only)
CREATE VIEW IF NOT EXISTS state AS
SELECT
  h.type AS the,
  h.id AS of,
  v.data AS 'is',
  f.parent AS cause,
  h.fact_hash AS fact,
  v.hash AS proof,
  f.version AS since
FROM head h
JOIN fact f ON h.fact_hash = f.hash
JOIN value v ON f.value_ref = v.hash
WHERE h.branch = '';

COMMIT;
`;

// Pragmas applied to every database connection
const PRAGMAS = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  PRAGMA cache_size=-64000;
  PRAGMA temp_store=MEMORY;
  PRAGMA mmap_size=268435456;
  PRAGMA foreign_keys=ON;
`;

// Must be set before database has any content (new DBs only)
const NEW_DB_PRAGMAS = `
  PRAGMA page_size=32768;
`;

const IMPORT_DATUM =
  `INSERT OR IGNORE INTO value (hash, data) VALUES (:hash, :data);`;

const IMPORT_FACT =
  `INSERT OR IGNORE INTO fact (hash, type, id, value_ref, parent, branch, version, commit_ref, fact_type) VALUES (:hash, :type, :id, :value_ref, :parent, '', :version, :commit_ref, :fact_type);`;

const IMPORT_MEMORY =
  `INSERT OR IGNORE INTO head (branch, type, id, fact_hash, version) VALUES ('', :type, :id, :fact_hash, :version);`;

const SWAP = `UPDATE head
  SET fact_hash = :fact_hash, version = :version
WHERE
  branch = ''
  AND type = :type
  AND id = :id
  AND fact_hash = :parent;
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

// Needs `of` and `the`
const CAUSE_CHAIN = `WITH RECURSIVE cause_of(c, f) AS (
    SELECT parent, hash FROM fact WHERE fact.id = :of AND fact.type = :the
    UNION
    SELECT parent, hash FROM fact, cause_of WHERE fact.hash = cause_of.c
  )
  SELECT c as cause, f as fact FROM cause_of
`;

// Needs `fact`
const GET_FACT = `SELECT
  fact.type AS the,
  fact.id AS of,
  value.data AS 'is',
  fact.parent AS cause,
  fact.hash AS fact,
  value.hash AS proof,
  fact.version AS since
FROM
  fact
JOIN
  value ON value.hash = fact.value_ref
WHERE
  fact.hash = :fact;
`;

// Batch query for labels using json_each() to handle array of 'of' values
// This replaces N individual queries with a single query
const GET_LABELS_BATCH = `SELECT
  state.the as the,
  state.of as of,
  state.'is' as 'is',
  state.cause as cause,
  state.since as since,
  state.fact as fact
FROM
  state
WHERE
  state.the = :the
  AND state.of IN (SELECT value FROM json_each(:ofs))
ORDER BY
  since ASC
`;

/**
 * Cache for prepared statements associated with each database connection.
 * Using WeakMap ensures statements are cleaned up when database is closed.
 */
type PreparedStatements = {
  export?: Statement;
  causeChain?: Statement;
  getFact?: Statement;
  getLabelsBatch?: Statement;
  importDatum?: Statement;
  importFact?: Statement;
  importMemory?: Statement;
  swap?: Statement;
  insertCommit?: Statement;
  updateBranchHead?: Statement;
};

const preparedStatementsCache = new WeakMap<Database, PreparedStatements>();

/**
 * Get or create a prepared statement for a database connection.
 * Prepared statements are cached and reused for better performance.
 */
const getPreparedStatement = (
  db: Database,
  key: keyof PreparedStatements,
  sql: string,
): Statement => {
  let cache = preparedStatementsCache.get(db);
  if (!cache) {
    cache = {};
    preparedStatementsCache.set(db, cache);
  }

  if (!cache[key]) {
    cache[key] = db.prepare(sql);
  }

  return cache[key]!;
};

/**
 * Finalize all prepared statements for a database connection.
 * Called when closing the database to clean up resources.
 */
const finalizePreparedStatements = (db: Database): void => {
  const cache = preparedStatementsCache.get(db);
  if (cache) {
    for (const stmt of Object.values(cache)) {
      if (stmt) {
        try {
          stmt.finalize();
        } catch (error) {
          // Ignore errors during finalization
          console.error("Error finalizing prepared statement:", error);
        }
      }
    }
    preparedStatementsCache.delete(db);
  }
};

export type Options = {
  url: URL;
};

export interface Session<Space extends MemorySpace> {
  subject: Space;
  store: Database;
}

/**
 * A space instance that provides both low-level database access (Session)
 * and high-level operations (SpaceSession).
 */
export type SpaceInstance<Space extends MemorySpace> =
  & Session<Space>
  & SpaceSession<Space>;

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
 * Detect v1 schema (datum table) and drop old tables to allow v2 schema
 * creation. Data is not migrated — old databases start fresh with v2.
 */
const migrateV1ToV2 = (database: Database): void => {
  const hasV1 = database.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='datum'",
  ).get() as { cnt: number };
  if (hasV1.cnt > 0) {
    database.exec(`
      DROP VIEW IF EXISTS state;
      DROP TABLE IF EXISTS memory;
      DROP TABLE IF EXISTS fact;
      DROP TABLE IF EXISTS datum;
    `);
  }
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
      database.exec(PRAGMAS);
      migrateV1ToV2(database);
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
      database.exec(NEW_DB_PRAGMAS);
      database.exec(PRAGMAS);
      migrateV1ToV2(database);
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
      finalizePreparedStatements(store);
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
  of: string;
  is: string | null;
  cause: string | null;
  since: number;
};

// Extended revision type that includes the stored fact hash
type RevisionWithFact<T> = Revision<T> & { fact: string };

const recall = <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of }: { the: MIME; of: URI },
): RevisionWithFact<Fact> | null => {
  const stmt = getPreparedStatement(store, "export", EXPORT);
  const row = stmt.get({ the, of }) as StateRow | undefined;
  if (row) {
    const revision: RevisionWithFact<Fact> = {
      the,
      of,
      cause: row.cause
        ? (fromString(row.cause) as Reference<Assertion>)
        : unclaimedRef({ the, of }),
      since: row.since,
      fact: row.fact, // Include stored hash to avoid recomputing with refer()
    };

    if (row.is) {
      revision.is = JSON.parse(row.is);
    }

    return revision;
  } else {
    return null;
  }
};

type CauseRow = {
  cause: string;
  fact: string;
};

/**
 * Get the chain of facts leading to the current state
 *
 * This may take an `excludeFact` to prevent including a fact that was just
 * inserted, but will be rolled back when the transaction fails.
 *
 * @param session
 * @param match an object with `the` and `of` properties used to filter
 * @param excludeFact fact to exclude from the chain
 * @returns an array of Revisions constructed from the associated facts
 */
const _causeChain = <Space extends MemorySpace>(
  session: Session<Space>,
  { the, of }: { the: MIME; of: URI },
  excludeFact: string | undefined,
): Revision<Fact>[] => {
  const { store } = session;
  const stmt = getPreparedStatement(store, "causeChain", CAUSE_CHAIN);
  const rows = stmt.all({ of, the }) as CauseRow[];
  const revisions = [];
  if (rows && rows.length) {
    for (const result of rows) {
      if (result.fact === excludeFact) {
        continue;
      }
      const revision = getFact(session, { fact: result.fact });
      if (revision) {
        revisions.push(revision);
      }
    }
  }
  return revisions;
};

/**
 * Gets a matching fact from the store.
 *
 * @param session
 * @param match an object with a `fact` property that is the reference string.
 * @returns a Revision constructed from the fact's details or undefined if
 *     there was no match.
 */
const getFact = <Space extends MemorySpace>(
  { store }: Session<Space>,
  { fact }: { fact: string },
): Revision<Fact> | undefined => {
  const stmt = getPreparedStatement(store, "getFact", GET_FACT);
  const row = stmt.get({ fact }) as StateRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  // It's possible to have more than one matching fact, but since the fact's id
  // incorporates its cause chain, we would have to have issued a retraction,
  // followed by the same chain of facts. At that point, it really is the same.
  // Since `the` and `of` are part of the fact reference, they are also unique.
  const revision: Revision<Fact> = {
    the: row.the as MIME,
    of: row.of as URI,
    cause: row.cause
      ? (fromString(row.cause) as Reference<Assertion>)
      : unclaimedRef(row as FactAddress),
    since: row.since,
  };
  if (row.is) {
    revision.is = JSON.parse(row.is);
  }
  return revision;
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
  the: MIME | SelectAll;
  of: URI | SelectAll;
  cause: CauseString | SelectAll;
  is?: undefined | Record<string | number | symbol, never>;
  since?: number;
};

export type SelectedFact = {
  the: MIME;
  of: URI;
  cause: CauseString;
  is?: StorableDatum;
  since: number;
};

const toFact = function (row: StateRow): SelectedFact {
  return {
    the: row.the as MIME,
    of: row.of as URI,
    cause: row.cause
      ? row.cause as CauseString
      : unclaimedRef(row as FactAddress).toString() as CauseString,
    is: row.is ? JSON.parse(row.is) as StorableDatum : undefined,
    since: row.since,
  };
};

// Select facts matching the selector. Facts are ordered by since.
export const selectFacts = function <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of, cause, is, since }: FactSelector,
): SelectedFact[] {
  const stmt = getPreparedStatement(store, "export", EXPORT);
  const results: SelectedFact[] = [];
  const iter = stmt.iter({
    the: the === SelectAllString ? null : the,
    of: of === SelectAllString ? null : of,
    cause: cause === SelectAllString ? null : cause,
    is: is === undefined ? null : {},
    since: since ?? null,
  }) as IterableIterator<StateRow>;
  // Explicit cleanup via finally - for-of loops don't call return() on normal
  // completion, leaving the prepared statement active and causing "cannot
  // commit transaction - SQL statements in progress" errors.
  try {
    for (const row of iter) {
      results.push(toFact(row));
    }
  } finally {
    iter.return?.();
  }
  return results;
};

export const selectFact = function <Space extends MemorySpace>(
  { store }: Session<Space>,
  { the, of, since }: { the: MIME; of: URI; since?: number },
): SelectedFact | undefined {
  const stmt = getPreparedStatement(store, "export", EXPORT);
  // Use get() instead of iter() to avoid leaving an active iterator
  // when we only need the first row. Active iterators cause
  // "cannot commit transaction - SQL statements in progress" errors.
  const row = stmt.get({
    the: the,
    of: of,
    cause: null,
    is: null,
    since: since ?? null,
  }) as StateRow | undefined;
  return row ? toFact(row) : undefined;
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
  datum: StorableValue,
): string => {
  if (datum === undefined) {
    return "undefined";
  } else {
    const is = refer(datum).toString();
    const stmt = getPreparedStatement(
      session.store,
      "importDatum",
      IMPORT_DATUM,
    );
    stmt.run({
      hash: is,
      data: JSON.stringify(datum),
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
  { since, transaction, commitRef }: {
    since: number;
    transaction: Transaction<Space>;
    commitRef: string;
  },
) => {
  const [{ the, of, is }, expect] = source.assert
    ? [source.assert, source.assert.cause]
    : source.retract
    ? [source.retract, source.retract.cause]
    : [source.claim, source.claim.fact];
  const cause = expect.toString();
  const base = unclaimedRef({ the, of }).toString();
  const expected = cause === base ? null : (expect as Reference<Fact>);

  // Derive the merkle reference to the fact that memory will have after
  // successful update. If we have an assertion or retraction we derive fact
  // from it, but if it is a confirmation `cause` is the fact itself.
  //
  // IMPORTANT: Compute fact hash BEFORE importing datum. When refer() traverses
  // the assertion/retraction, it computes and caches the hash of all sub-objects
  // including the datum (payload). By hashing the fact first, the subsequent
  // refer(datum) call in importDatum() becomes a ~300ns cache hit instead of a
  // ~50-100µs full hash computation. This saves ~25% on refer() time.
  const fact = source.assert
    ? refer(source.assert).toString()
    : source.retract
    ? refer(source.retract).toString()
    : source.claim.fact.toString();

  // Import datum AFTER computing fact reference - the datum hash is now cached
  // from the fact traversal above, making this a fast cache hit.
  let datumRef: string | undefined;
  if (source.assert || source.retract) {
    datumRef = importDatum(session, is);
  }

  // If this is an assertion we need to insert fact referencing the datum.
  let imported = 0;
  if (source.assert || source.retract) {
    const importFactStmt = getPreparedStatement(
      session.store,
      "importFact",
      IMPORT_FACT,
    );
    imported = importFactStmt.run({
      hash: fact,
      type: the,
      id: of,
      value_ref: datumRef!,
      parent: cause,
      version: since,
      commit_ref: commitRef,
      fact_type: source.retract ? "delete" : "set",
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
  // therefore we insert or ignore here to ensure fact record exists and then
  // use update afterwards to update to desired state from expected `cause` state.
  if (expected == null) {
    const importMemoryStmt = getPreparedStatement(
      session.store,
      "importMemory",
      IMPORT_MEMORY,
    );
    importMemoryStmt.run({
      type: the,
      id: of,
      fact_hash: fact,
      version: since,
    });
  }

  // Finally we perform a memory swap, using conditional update so it only
  // updates memory if the `cause` references expected state. We use return
  // value to figure out whether update took place, if it is `0` no records
  // were updated indicating potential conflict which we handle below.
  const swapStmt = getPreparedStatement(session.store, "swap", SWAP);
  const updated = swapStmt.run({
    fact_hash: fact,
    parent: cause,
    type: the,
    id: of,
    version: since,
  });

  // If no records were updated it implies that there was no record with
  // matching `cause`. It may be because `cause` referenced implicit fact
  // in which case which case `IMPORT_MEMORY` provisioned desired record and
  // update would not have applied. Or it could be that `cause` in the database
  // is different from the one being asserted. We will assess this by pulling
  // the record and comparing it to desired state.
  if (updated === 0) {
    const revision = recall(session, { the, of });

    // If actual state matches desired state it either was inserted by the
    // `IMPORT_MEMORY` or this was a duplicate call. Either way we do not treat
    // it as a conflict as current state is the asserted one.
    // Use stored fact hash directly instead of recomputing with refer().
    if (revision?.fact !== fact) {
      // Disable including history tracking for performance.
      // Re-enable this if you need to debug cause chains.
      const revisions: Revision<Fact>[] = [];
      // const revisions = causeChain(
      //   session,
      //   { the, of },
      //   (imported !== 0) ? fact : undefined,
      // );
      // Strip internal 'fact' field from revision for error reporting
      let actual: Revision<Fact> | null = null;
      if (revision) {
        const { fact: _, ...rest } = revision;
        actual = rest as Revision<Fact>;
      }
      throw Error.conflict(transaction, {
        space: transaction.sub,
        the,
        of,
        expected,
        actual,
        existsInHistory: imported === 0,
        history: revisions,
      });
    }
  }
};

const INSERT_COMMIT =
  `INSERT OR IGNORE INTO "commit" (hash, version, branch) VALUES (:hash, :version, '');`;

const UPDATE_BRANCH_HEAD =
  `UPDATE branch SET head_version = :version WHERE name = '';`;

const commit = <Space extends MemorySpace>(
  session: Session<Space>,
  transaction: Transaction<Space>,
): Commit<Space> => {
  const the = COMMIT_LOG_TYPE;
  const of = transaction.sub;
  const stmt = getPreparedStatement(session.store, "export", EXPORT);
  const row = stmt.get({ the, of }) as StateRow | undefined;
  const [since, cause] = row
    ? [
      (JSON.parse(row.is as string) as CommitData).since + 1,
      fromString(row.fact) as Reference<Assertion>,
    ]
    : [0, unclaimedRef({ the, of })];

  const commitData = createCommit({
    space: of,
    since,
    transaction,
    cause,
  });

  // Compute commit hash and insert into commit table
  const commitRef = refer(commitData).toString();
  const insertCommitStmt = getPreparedStatement(
    session.store,
    "insertCommit",
    INSERT_COMMIT,
  );
  insertCommitStmt.run({ hash: commitRef, version: since });

  const swapContext = { ...commitData.is, commitRef };

  for (const fact of iterateTransaction(transaction)) {
    swap(session, fact, swapContext);
  }

  swap(session, { assert: commitData }, swapContext);

  // Update branch head version
  const updateBranchStmt = getPreparedStatement(
    session.store,
    "updateBranchHead",
    UPDATE_BRANCH_HEAD,
  );
  updateBranchStmt.run({ version: since });

  const changes: Commit<Space> = {} as Commit<Space>;
  set(
    changes,
    commitData.of,
    commitData.the,
    commitData.cause.toString() as CauseString,
    {
      is: commitData.is,
    },
  );
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

/**
 * Computes labels for a commit, used by providers to redact classified entries
 * before sending to subscribers.
 *
 * @returns Label facts for documents in the commit, or undefined if none.
 */
export function getLabelsForCommit<S extends MemorySpace>(
  session: Session<S>,
  commit: Commit<S>,
): FactSelection | undefined {
  let allLabels: FactSelection | undefined;

  for (const item of SelectionBuilder.iterate<{ is: CommitData }>(commit)) {
    const changedFacts = toSelection(
      item.value.is.since,
      item.value.is.transaction.args.changes,
    );
    const labels = getLabels(session, changedFacts);
    if (Object.keys(labels).length > 0) {
      allLabels = { ...allLabels, ...labels } as FactSelection;
    }
  }

  return allLabels;
}

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

    // Use IMMEDIATE transaction to acquire write lock at start, reducing
    // lock contention with external processes like litestream
    return execute(
      session.store.transaction(commit).immediate,
      session,
      transaction,
    );
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
      span.setAttribute(
        "querySchema.selectSchema",
        JSON.stringify(command.args.selectSchema),
      );
    }
    if (command.args?.since !== undefined) {
      span.setAttribute("querySchema.since", command.args.since);
    }

    try {
      const { facts } = session.store.transaction(selectSchema)(
        session,
        command.args,
      );

      const entities = Object.keys(facts || {}).length;
      span.setAttribute("querySchema.result_entity_count", entities);

      return {
        ok: {
          [command.sub]: facts,
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

/**
 * Internal variant of querySchema that also returns the schemaTracker.
 * Used by provider.ts for incremental subscription updates.
 */
export const querySchemaWithTracker = <Space extends MemorySpace>(
  session: Session<Space>,
  command: SchemaQuery<Space>,
  existingSchemaTracker?: SelectSchemaResult["schemaTracker"],
): Result<
  {
    selection: Selection<Space>;
    schemaTracker: SelectSchemaResult["schemaTracker"];
  },
  AuthorizationError | QueryError
> => {
  return traceSync("space.querySchemaWithTracker", (span) => {
    addMemoryAttributes(span, {
      operation: "querySchemaWithTracker",
      space: session.subject,
    });

    try {
      const { facts, schemaTracker } = session.store.transaction(selectSchema)(
        session,
        command.args,
        existingSchemaTracker,
      );

      const entities = Object.keys(facts || {}).length;
      span.setAttribute("querySchema.result_entity_count", entities);

      return {
        ok: {
          selection: {
            [command.sub]: facts,
          } as Selection<Space>,
          schemaTracker,
        },
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

export const LABEL_TYPE = "application/label+json" as const;
export type FactSelectionValue = { is?: StorableDatum; since: number };
// Get the labels associated with a set of commits.
// It's possible to get more than one label for a single doc because our
// includedFacts may include more than one cause for a single doc.
// Uses a batched query (SELECT...IN) instead of N individual queries for performance.
export function getLabels<
  Space extends MemorySpace,
  T,
>(
  session: Session<Space>,
  includedFacts: OfTheCause<Revision<T>>,
): OfTheCause<FactSelectionValue> {
  const labels: OfTheCause<FactSelectionValue> = {};

  // Collect unique 'of' values, excluding labels themselves
  const ofs: URI[] = [];
  for (const fact of iterate(includedFacts)) {
    // We don't restrict access to labels
    if (fact.the !== LABEL_TYPE) {
      ofs.push(fact.of);
    }
  }

  // No facts to look up labels for
  if (ofs.length === 0) {
    return labels;
  }

  // Batch query for all labels in a single SELECT...IN query
  const stmt = getPreparedStatement(
    session.store,
    "getLabelsBatch",
    GET_LABELS_BATCH,
  );
  const iter = stmt.iter({
    the: LABEL_TYPE,
    ofs: JSON.stringify(ofs),
  }) as IterableIterator<StateRow>;
  // Explicit cleanup via finally - for-of loops don't call return() on normal
  // completion, leaving the prepared statement active and causing "cannot
  // commit transaction - SQL statements in progress" errors.
  try {
    for (const row of iter) {
      const labelFact = toFact(row);
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
  } finally {
    iter.return?.();
  }

  return labels;
}

// Get the label that applies to the entity.
export function getLabel<Space extends MemorySpace>(
  session: Session<Space>,
  of: URI,
) {
  return selectFact(session, { of, the: LABEL_TYPE });
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

/**
 * Redacts any classified content from commit data based on the provided labels.
 *
 * @param commitData The commit data to redact
 * @param labels Labels to use for redaction. If null or empty, returns the
 *   original commit data unchanged.
 * @returns A redacted copy of the commit data, or the original if no redaction
 *   was needed.
 */
export function redactCommitData(
  commitData: CommitData,
  labels: FactSelection | null = null,
): CommitData {
  if (labels == null || Object.keys(labels).length === 0) {
    return commitData;
  }

  // Make a copy of the transaction with no changes
  const newChanges: Changes = {};
  // Add any non-redacted changes to the newCommitData
  for (const fact of iterate(commitData.transaction.args.changes)) {
    if (fact.value === true) {
      continue;
    }
    // We treat all labels as unclassified
    if (fact.the === LABEL_TYPE) {
      set(newChanges, fact.of, fact.the, fact.cause, fact.value);
      continue;
    }
    // FIXME(@ubik2): Re-enable this once we've tracked down other issues
    // const labelFact = getRevision(labels, fact.of, LABEL_TYPE);
    // if (labelFact !== undefined && getClassifications(labelFact).size > 0) {
    //   setEmptyObj(newChanges, fact.of, fact.the);
    // } else {
    //   set(newChanges, fact.of, fact.the, fact.cause, fact.value);
    // }
    set(newChanges, fact.of, fact.the, fact.cause, fact.value);
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
