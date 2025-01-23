import { Database, type DatabaseOpenOptions } from "@db/sqlite";
import type {
  Result,
  DocumentID,
  RepositoryID,
  ReplicaNotFound,
  EntityNotFound,
  ConflictError,
  State,
  JSONValue,
  Checksum,
  Revision,
} from "./lib.ts";
import { add } from "./main.ts";

export type {
  RepositoryID,
  DocumentID,
  ReplicaNotFound,
  EntityNotFound,
  ConflictError,
  Revision,
  State,
};

const TABLE = "state";
const ENTITY = "entity";
const VALUE = "value";
const VERSION = "version";

const PREPARE = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  ${ENTITY} TEXT PRIMARY KEY,
  ${VALUE} JSON NOT NULL,
  ${VERSION} TEXT NOT NULL
);`;

const SELECT = `SELECT
${ENTITY}, ${VALUE}, ${VERSION}
FROM ${TABLE} WHERE ${ENTITY} = :entity;`;

const INSERT = `
INSERT INTO ${TABLE} (${ENTITY}, ${VALUE}, ${VERSION})
VALUES (:entity, :value, :version);
`;

const UPDATE = `
UPDATE ${TABLE}
SET ${VALUE} = :value,
    ${VERSION} = :as
WHERE ${ENTITY} = :entity AND ${VERSION} = :version;
`;

export type Options = {
  url: URL;
  pool: Map<RepositoryID, Replica>;
};

export interface FileURL extends URL {
  protocol: "file:";
}

export interface MemoryURL extends URL {
  protocol: "memory:";
}

export type Address = FileURL | MemoryURL;

class Replica {
  constructor(
    public id: RepositoryID,
    public database: Database,
  ) {}
}

export type { Replica };

const toAddress = (url: URL) => {
  const { pathname } = url;
  const base = pathname.split("/").pop() as string;
  const id = base.endsWith(".sqlite") ? base.slice(0, -".sqlite".length) : base;

  return { location: url.protocol === "file:" ? url : ":memory:", id };
};

/**
 * Creates a connection to the existing replica. Errors if replica does not
 * exist.
 */
export const connect = async ({
  url,
  pool,
}: Options): Promise<Result<Replica, ReplicaNotFound>> => {
  const replica = pool.get(url.href);
  if (replica) {
    return { ok: replica };
  } else {
    const address = toAddress(url);
    try {
      const database = await new Database(address.location, { create: false });
      database.prepare(PREPARE).run();
      const replica = new Replica(address.id, database);
      pool.set(url.href, replica);
      return { ok: replica };
    } catch {
      return { error: new ReplicaNotFoundError(address.id) };
    }
  }
};

export const open = async ({
  url,
  pool,
}: Options): Promise<Result<Replica, never>> => {
  const replica = pool.get(url.href);
  if (replica) {
    return { ok: replica };
  } else {
    const { location, id } = toAddress(url);
    const database = await new Database(location, { create: true });
    database.prepare(PREPARE).run();
    const replica = new Replica(id, database);
    pool.set(id, replica);
    return { ok: replica };
  }
};

export const close = async (replica: Replica) => {
  await replica.database.close();
};
export interface Select {
  entity: DocumentID;
}
export const select = (
  replica: Replica,
  { entity }: Select,
): Result<State, EntityNotFound> => {
  const state = replica.database.prepare(SELECT).get({ entity });

  if (state === undefined) {
    return { error: new EntityNotFoundError(replica.id, entity) };
  } else {
    const { value, version } = state as { value: string; version: string };
    return {
      ok: {
        replica: replica.id,
        entity,
        value: JSON.parse(value),
        version,
      },
    };
  }
};

export interface Assertion {
  entity: DocumentID;
  value: JSONValue;
  version?: Checksum;
  as: Checksum;
}

export interface Insert {
  entity: DocumentID;
  value: JSONValue;
  version: Checksum;
}

export const insert = (
  replica: Replica,
  { entity, value, version }: Insert,
): Result<Revision, ConflictError> => {
  try {
    replica.database.run(INSERT, { entity, value, version });
    return { ok: { replica: replica.id, entity, version } };
  } catch {
    const result = select(replica, { entity });
    return {
      error: new RevisionError(
        replica.id,
        entity,
        undefined,
        result.ok?.version as string,
        result.ok?.value as JSONValue,
      ),
    };
  }
};

interface Update extends Insert {
  as: Checksum;
}

export const update = (
  replica: Replica,
  { entity, value, version, as }: Update,
): Result<Revision, ConflictError | EntityNotFound> => {
  try {
    const count = replica.database.run(UPDATE, { entity, value, version, as });
    // If 0 rows were updated we did not found either an entity or an expected
    // version. In such case we try to select the entity to determine whether
    // it is version conflict or non-existing entity.
    if (count === 0) {
      const result = select(replica, { entity });
      return result.error
        ? result
        : {
            error: new RevisionError(
              replica.id,
              entity,
              version,
              result.ok.version,
              result.ok.value,
            ),
          };
    } else {
      return { ok: { replica: replica.id, entity, version: as } };
    }
  } catch {
    return { error: new EntityNotFoundError(replica.id, entity) };
  }
};

export const assert = (
  replica: Replica,
  { entity, value, version, as }: Assertion,
) =>
  version === undefined
    ? insert(replica, { entity, value, version: as })
    : update(replica, { entity, value, version, as });

export class ReplicaNotFoundError extends Error implements ReplicaNotFound {
  override name = "ReplicaNotFound" as const;
  constructor(public replica: RepositoryID) {
    super(`Replica not found: ${replica}`);
  }
}

export class EntityNotFoundError extends Error implements EntityNotFound {
  override name = "EntityNotFound" as const;
  constructor(
    public replica: RepositoryID,
    public entity: DocumentID,
  ) {
    super(`Entity ${entity} not found in ${replica}`);
  }
}

export class RevisionError extends Error implements ConflictError {
  override name = "ConflictError" as const;
  constructor(
    public replica: RepositoryID,
    public entity: DocumentID,
    public expected: Checksum | undefined,
    public actual: Checksum,
    public value: JSONValue,
  ) {
    super(
      expected === undefined
        ? `Can not create ${entity} at ${replica}, because it already exists`
        : `Can not update ${entity} at ${replica}, because expected ${expected} version, instead of current ${actual} version`,
    );
  }
}
