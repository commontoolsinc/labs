import { Database } from "jsr:@db/sqlite";
import type {
  Result,
  DocumentID,
  RepositoryID,
  ReplicaNotFound,
  EntityNotFound,
  ConflictError,
  Revision,
  JSONObject,
  Reference,
} from "./lib.ts";
import { refer } from "merkle-reference";

export type {
  RepositoryID,
  DocumentID,
  ReplicaNotFound,
  EntityNotFound,
  ConflictError,
  Revision,
  Reference,
};

const STATE = "state";
const REVISION = "revision";
const OF = "of";
const WAS = "was";
const IS = "value";
const PROOF = "proof";

export const IMPLICIT = {
  "#": refer({}).toString(),
} as const;

const UNIT = refer({}).toString();

export const PREPARE = `
BEGIN TRANSACTION;

-- Setup table for storing documents keyed by merkle-reference.
CREATE TABLE IF NOT EXISTS ${REVISION} (
  ${IS} TEXT PRIMARY KEY,
  ${WAS} TEXT,
  ${PROOF} JSON NOT NULL
);
-- Setup table for tracking current document state.
CREATE TABLE IF NOT EXISTS ${STATE} (
  ${OF} TEXT PRIMARY KEY,
  ${IS} TEXT NOT NULL,
  FOREIGN KEY(${IS}) REFERENCES ${REVISION}(${IS})
);

-- Insert a record for an empty document as it is used as implicit for
-- non-existing documents.
-- INSERT OR IGNORE INTO ${REVISION} (${IS}, ${WAS}, ${PROOF}) VALUES ('${UNIT}', ${UNIT}, '{}');

COMMIT;
`;

const INIT_2 = `
BEGIN TRANSACTION;

-- Try creating a revision for the document
INSERT OR IGNORE INTO ${REVISION} (${IS}, ${WAS}, ${PROOF})
VALUES (:is, :was, :proof);

-- Try creating a state record for the document
INSERT OR IGNORE INTO ${STATE} (${OF}, ${IS})
VALUES (:of, :is);

COMMIT;
`;

const INIT = `
INSERT OR IGNORE INTO ${STATE} (${OF}, ${IS})
VALUES (:of, :is);
`;

const IMPORT = `
INSERT OR IGNORE INTO ${REVISION} (${IS}, ${WAS}, ${PROOF})
VALUES (:is, :was, :proof);`;

const EXPORT = `SELECT
  ${STATE}.${OF},
  ${REVISION}.${WAS},
  ${REVISION}.${PROOF}
FROM
  ${STATE}
JOIN
  ${REVISION}
ON
  ${STATE}.${IS} = ${REVISION}.${IS};
WHERE
  ${STATE}.${OF} = :of;
`;

const UPDATE = `
UPDATE ${STATE}
SET ${IS} = :is
WHERE ${OF} = :of AND ${IS} = :was;
`;

const DELETE = `
DELETE FROM ${STATE}
WHERE ${OF} = :of AND ${IS} = :is;
`;

export type Options = {
  url: URL;
};

export interface Model {
  id: RepositoryID;
  store: Database;
}

export interface Selector {
  this: DocumentID;
}

export type SelectError = EntityNotFound;

export interface Session {
  /**
   * Transacts can be used to assert or retract a document from the repository.
   * If `version` asserted / retracted does not match version of the document
   * transaction fails with `ConflictError`. Otherwise document is updated to
   * the new value.
   */
  transact(transact: Transaction): Result<Commit, ConflictError>;
  /**
   * Query can be used to retrieve a document from the store. At the moment
   * you can only pass the `entity` selector.œ
   */
  query(selector: Selector): Result<Assertion, never>;
}

export interface Commit {
  at: RepositoryID;
  of: DocumentID;
  was: Reference<Revision>;
  is: Reference<Revision>;
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

export interface Assertion {
  /**
   * Stable document identifier that uniquely identifies the document.
   */
  of: DocumentID;

  /**
   * Document state being asserted.
   */
  is: JSONObject;

  /**
   * Version `this` document is expected to be at. If `version` invariant is
   * not met assertion fails with `ConflictError`.
   */
  was?: Reference<Revision>;
}

export interface Retraction {
  of: DocumentID;
  is: Reference;
}

export type Transaction =
  | { assert: Assertion; retract?: undefined }
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

export const query = (
  { store }: Model,
  selector: Selector,
): Result<Assertion, never> => {
  const row = store.prepare(EXPORT).get({ of: selector.this }) as
    | { was?: string; proof: string }
    | undefined;

  // If we do not have a record for this document we simply derive initial
  // revision.
  if (row === undefined) {
    return {
      ok: {
        of: selector.this,
        is: { this: selector.this },
      },
    };
  }
  // If we do have a row we parse and return it.
  else {
    const is = JSON.parse(row.proof);
    return {
      ok:
        row.was == null
          ? { of: selector.this, is }
          : { of: selector.this, is, was: row.was },
    };
  }
};

export const unit = Object.freeze({});

export const assert = (
  session: Model,
  assertion: Assertion,
): Result<Commit, ConflictError> => {
  const of = assertion.of;
  const genesis = { is: { this: of } };
  const base = refer(genesis).toString();
  const was = assertion.was ?? base;

  const revision = { is: assertion.is, was } as Revision;
  const is = refer(revision).toString();

  session.store.transaction(() => {
    // When assertion expects document in it's initial state we need to ensure
    // that we have corresponding revision and state records.
    if (was === base) {
      session.store.run(IMPORT, {
        is: base,
        was: null,
        proof: JSON.stringify(genesis.is),
      });

      session.store.run(INIT, {
        of,
        is: base,
      });
    }

    // Next we also need to create a revision for the asserted state in order
    // to ensure foreign key constraint when updating state record.
    session.store.run(IMPORT, {
      is,
      was,
      proof: JSON.stringify(revision.is),
    });
  })();

  // Here we will update state from expected `was` revision to asserted
  // revision that corresponds to `is` state. If document does not have an
  // expected revision no records will be updated.
  const updated = session.store.run(UPDATE, { of, was, is });

  // If no rows were updated that implies that current state does not match
  // expected since state. In such case we produce a conflict error.
  if (updated === 0) {
    // We need to determine the current state of the document in order to
    // include it in the error so that caller has enough context to rebase
    // their document state and retry.
    const { of: _, ...revision } = query(session, { this: of }).ok as Assertion;

    if (refer(revision).toString() !== was) {
      return {
        error: new RevisionError(session.id, of, was, revision as Revision),
      };
    }
  }

  // If some rows were updated we generate a commit record.
  return {
    ok: {
      at: session.id,
      of,
      is,
      was,
    },
  };
};

export const retract = (
  session: Model,
  { of, is }: Retraction,
): Result<Commit, ConflictError> => {
  // We attempt to delete state record for the document. It will update 1 or 0
  // rows depending on whether expected state matches current state.
  const deleted = session.store.run(DELETE, { of, is });
  // If no rows were deleted and assumed state is not implicit we had a wrong
  // assumption about the document state.

  if (deleted === 0) {
    const { of: _, ...revision } = query(session, { this: of }).ok as Assertion;
    // If actual state is implicit and it is the one we assumed we do not
    // actually have a conflict it's just we don't have row for the implicit
    // state.
    if (revision.was !== is) {
      return {
        error: new RevisionError(session.id, of, is, revision as Revision),
      };
    }
  }

  return {
    ok: {
      at: session.id,
      of,
      is: refer({ is: { this: of } }).toString(),
      was: is,
    },
  };
};

export const transact = (
  model: Model,
  transact: Transaction,
): Result<Commit, ConflictError> =>
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
  constructor(
    public at: RepositoryID,
    public of: DocumentID,
    public expected: Reference<Revision>,
    public actual: Revision,
  ) {
    super(
      `Document ${of} at ${at} was expected to be ${expected} instead of actual ${refer(actual)}`,
    );
  }
}
