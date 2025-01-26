import { Database } from "jsr:@db/sqlite";
import type {
  Result,
  DocumentID,
  RepositoryID,
  ReplicaNotFound,
  MemoryNotFound,
  ConflictError,
  Revision,
  JSONObject,
  JSONValue,
} from "./lib.ts";
import { fromString, refer, Reference } from "npm:merkle-reference";

export type {
  RepositoryID,
  DocumentID,
  ReplicaNotFound,
  MemoryNotFound,
  ConflictError,
  Revision,
  Reference,
};

export const PREPARE = `
BEGIN TRANSACTION;

-- Create table for storing JSON data.
CREATE TABLE IF NOT EXISTS datum (
  this    TEXT PRIMARY KEY,     -- Merkle reference for this JSON
  source  JSON NOT NULL         -- Source for this JSON
);

CREATE TABLE IF NOT EXISTS fact (
  this    TEXT PRIMARY KEY,     -- Merkle reference for { the, of, is, cause }
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  'is'    TEXT NOT NULL,        -- Value entity is claimed to have
  cause   TEXT,                 -- Causal reference to prior fact
  FOREIGN KEY('is') REFERENCES datum(this)
);

CREATE TABLE IF NOT EXISTS memory (
  the     TEXT NOT NULL,        -- Kind of a fact e.g. "application/json"
  of      TEXT NOT NULL,        -- Entity identifier fact is about
  fact    TEXT NOT NULL,        -- Link to the fact,
  FOREIGN KEY(fact) REFERENCES fact(this),
  PRIMARY KEY (the, of)         -- Ensure that we have only one fact per entity
);

COMMIT;
`;

const IMPORT_DATUM = `INSERT OR IGNORE INTO datum (this, source) VALUES (:this, :source);`;

const IMPORT_FACT = `INSERT OR IGNORE INTO fact (this, the, of, 'is', cause) VALUES (:this, :the, :of, :is, :cause);`;

const IMPORT_MEMORY = `INSERT OR IGNORE INTO memory (the, of, fact) VALUES (:the, :of, :fact);`;

const SWAP = `UPDATE memory SET fact = :fact WHERE fact = :cause;`;

const DELETE = `DELETE FROM memory WHERE the = :the AND of = :of AND fact = :fact;`;

const EXPORT = `SELECT 
  memory.the as the,
  memory.of as of,
  memory.fact as fact,
  datum.source as 'is',
  fact.cause as cause
FROM
  memory
JOIN
  fact ON memory.fact = fact.this
JOIN
  datum ON fact.'is' = datum.this
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
  of: DocumentID;
}

export type SelectError = MemoryNotFound;

export interface Session {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact(transact: Transaction): Result<Commit, ConflictError | StoreError>;
  /**
   * Query can be used to retrieve a document from the store. At the moment
   * you can only pass the `entity` selector.œ
   */
  query(selector: Selector): Result<Fact, MemoryNotFound | StoreError>;
}

export interface Commit {
  in: RepositoryID;
  the: string;
  of: DocumentID;
  is: Reference<JSONValue>;
  cause?: Reference<Fact>;
}

export class Store implements Model, Session {
  constructor(
    public id: RepositoryID,
    public store: Database,
  ) {}

  transact(transaction: Transaction) {
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

export type Fact = {
  the: string;

  /**
   * Stable document identifier that uniquely identifies the document.
   */
  of: DocumentID;

  /**
   * Document state being asserted.
   */
  is: JSONValue;

  /**
   * Version `this` document is expected to be at. If `version` invariant is
   * not met assertion fails with `ConflictError`.
   */
  cause?: Reference<Fact>;
};

export interface Retraction {
  the: string;
  of: DocumentID;
  is: Reference<JSONValue>;
  cause?: Reference<Fact>;
}

export type Transaction =
  | { assert: Fact; retract?: undefined }
  | { retract: Retraction; assert?: undefined };

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
  of: DocumentID;
  is: string;
  cause: string | null;
};

export const query = (
  { id, store }: Model,
  { the, of }: Selector,
): Result<Fact, MemoryNotFound | StoreError> => {
  try {
    const fact = pull({ id, store }, { the, of });
    if (fact) {
      return { ok: fact };
    } else {
      return { error: new MemoryNotFoundError(the, of, id) };
    }
  } catch (error) {
    return { error: new StoreError((error as Error).message) };
  }
};

const pull = ({ store }: Model, { the, of }: Selector): Fact | undefined => {
  const row = store.prepare(EXPORT).get({ the, entity: of }) as
    | MemoryView
    | undefined;

  // If we do not have a record for this document we simply derive initial
  // revision.
  if (row === undefined) {
    return undefined;
  }
  // If we do have a row we parse and return it.
  else {
    const is = JSON.parse(row.is);
    const cause = row.cause
      ? (fromString(row.cause) as Reference<Fact>)
      : undefined;
    const fact = cause == null ? { the, of, is } : { the, of, is, cause };
    return fact;
  }
};

const derive = (source: Fact | Retraction) => {
  const { the, of } = source;
  const is = refer(source.is) as Reference<JSONValue>;
  const cause = source.cause
    ? (refer(source.cause) as Reference<Fact>)
    : undefined;
  const fact = refer(
    cause ? { the, of, is, cause } : { the, of, is },
  ) as Reference<Fact>;

  return {
    fact,
    the,
    of,
    is,
    cause,
  };
};

const swap = ({ store, id }: Model, source: Fact) => {
  const { the, of, is, cause, fact } = derive(source);

  // First we try to import JSON into a datum table.
  store.run(IMPORT_DATUM, {
    this: is.toString(),
    source: JSON.stringify(source.is),
  });

  // Then we try to import a asserted fact into a fact table.
  store.run(IMPORT_FACT, {
    this: fact.toString(),
    the,
    of,
    is: is.toString(),
    cause: cause?.toString() ?? null,
  });

  // If no prior fact was referenced we expect no memory record so we try
  // to create a new one.
  if (!cause) {
    store.run(IMPORT_MEMORY, { the, of, fact: fact.toString() });
  }

  // Finally we will swap memory record to point from the prior fact `cause`
  // to the new fact. If there was no causal reference to prior fact we use
  // the fact itself as a cause. This is will be either a redundant because we
  // have created this exact record in previous step or there was record with
  // referring to a different fact in which case no rows will be updated and
  // we will know that expected state does not match an actual state so we'll
  // need to raise a `ConflictError`.
  const updated = store.run(SWAP, {
    fact: fact.toString(),
    cause: (cause ?? fact).toString(),
  });

  if (updated === 0) {
    const actual = pull({ id, store }, { the, of }) ?? null;
    // If actual state matches desired state update was just duplicate call,
    // while technically this is a conflict we do not treat it as such as
    // there is no point to error if asserted state is an actual state.
    if (refer(actual).toString() !== fact.toString()) {
      throw new RevisionError(id, the, of, cause ?? null, actual);
    }
  }
};

export const assert = (
  session: Model,
  { the, of, is, cause }: Fact,
): Result<Commit, ConflictError | StoreError> => {
  const transact = session.store.transaction(swap);

  try {
    transact(session, { the, of, is, cause });

    return {
      ok: {
        in: session.id,
        the,
        of,
        is: refer(is),
        ...(cause ? { cause: refer(cause) } : {}),
      },
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

export const retract = (
  session: Model,
  source: Retraction,
): Result<Commit, ConflictError> => {
  const { the, of, is, cause, fact } = derive(source);

  // We attempt to delete state record for the document. It will update 1 or 0
  // rows depending on whether expected state matches current state.
  const deleted = session.store.run(DELETE, { the, of, fact: fact.toString() });
  // If no rows were deleted and assumed state is not implicit we had a wrong
  // assumption about the document state.

  if (deleted === 0) {
    const result = query(session, { the, of });
    if (result.error) {
      return {
        error: new RevisionError(session.id, the, of, fact, null),
      };
    } else {
      return {
        error: new RevisionError(session.id, the, of, fact, result.ok),
      };
    }
  }

  return {
    ok: {
      in: session.id,
      the,
      of,
      is,
      ...(cause ? { cause } : {}),
    },
  };
};

export const transact = (
  model: Model,
  transact: Transaction,
): Result<Commit, ConflictError | StoreError> =>
  transact.assert
    ? assert(model, transact.assert)
    : retract(model, transact.retract);

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
    public of: DocumentID,
    public expected: Reference<Fact> | null,
    public actual: Fact | null,
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
    public of: DocumentID,
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
