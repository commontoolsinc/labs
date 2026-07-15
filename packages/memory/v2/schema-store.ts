import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { Database } from "@db/sqlite";
import * as Path from "@std/path";

const INIT = `
CREATE TABLE IF NOT EXISTS schema_store_metadata (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_store_entries (
  hash TEXT NOT NULL PRIMARY KEY,
  canonical_json TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
`;

const GENERATION_KEY = "generation";

export interface SchemaStore {
  /** Stable UUID identifying this durable store instance. */
  readonly generation: string;

  /** Canonicalizes and durably records a schema under its tagged content hash. */
  put(schema: JSONSchema): StoredSchema;
  /** Atomically canonicalizes and durably records a collection of schemas. */
  putAll(schemas: readonly JSONSchema[]): StoredSchema[];
  /** Returns a verified, immutable canonical schema, or undefined when absent. */
  get(hash: string): StoredSchema | undefined;
  /** Returns whether a verified schema is present for the tagged hash. */
  has(hash: string): boolean;
  /** Releases the underlying SQLite connection. */
  close(): void;
}

export interface StoredSchema {
  hash: string;
  schema: JSONSchema;
}

export interface SchemaStoreOptions {
  /** File URL for a durable store; non-file URLs create an in-memory store. */
  url: URL;
  maxSchemaBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

export class SchemaStoreQuotaError extends Error {
  constructor(
    readonly quota: "maxSchemaBytes" | "maxEntries" | "maxTotalBytes",
    message: string,
  ) {
    super(message);
    this.name = "SchemaStoreQuotaError";
  }
}

/** A stored value failed parsing, canonicalization, or content-hash verification. */
export class SchemaStoreCorruptionError extends Error {
  constructor(readonly hash: string, message: string) {
    super(message);
    this.name = "SchemaStoreCorruptionError";
  }
}

type EntryRow = {
  hash: string;
  canonical_json: string;
  byte_length: number;
};

type UsageRow = {
  entries: number;
  total_bytes: number | null;
};

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const validateLimit = (name: string, value: number | undefined): number => {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
};

const databaseAddress = (url: URL): string =>
  url.protocol === "file:" ? Path.fromFileUrl(url) : ":memory:";

const schemaFromRow = (row: EntryRow, requestedHash: string): StoredSchema => {
  if (row.hash !== requestedHash) {
    throw new SchemaStoreCorruptionError(
      requestedHash,
      "schema store returned a row for a different hash",
    );
  }
  if (byteLength(row.canonical_json) !== row.byte_length) {
    throw new SchemaStoreCorruptionError(
      requestedHash,
      "schema store byte length does not match stored JSON",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonical_json);
  } catch {
    throw new SchemaStoreCorruptionError(
      requestedHash,
      "schema store contains invalid JSON",
    );
  }
  if (
    parsed !== true && parsed !== false &&
    (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new SchemaStoreCorruptionError(
      requestedHash,
      "schema store contains a non-schema JSON value",
    );
  }

  try {
    const canonical = internSchema(parsed as JSONSchema, true);
    const canonicalJson = JSON.stringify(canonical.schema);
    if (
      canonical.taggedHashString !== requestedHash ||
      canonicalJson !== row.canonical_json
    ) {
      throw new SchemaStoreCorruptionError(
        requestedHash,
        "schema store JSON does not match its tagged content hash",
      );
    }
    return { hash: canonical.taggedHashString, schema: canonical.schema };
  } catch (error) {
    if (error instanceof SchemaStoreCorruptionError) throw error;
    throw new SchemaStoreCorruptionError(
      requestedHash,
      "schema store contains an invalid schema",
    );
  }
};

export class SqliteSchemaStore implements SchemaStore {
  readonly #maxSchemaBytes: number;
  readonly #maxEntries: number;
  readonly #maxTotalBytes: number;
  readonly #selectEntry;
  readonly #insertEntry;
  readonly #usage;

  private constructor(
    readonly database: Database,
    readonly generation: string,
    options: SchemaStoreOptions,
  ) {
    this.#maxSchemaBytes = validateLimit(
      "maxSchemaBytes",
      options.maxSchemaBytes,
    );
    this.#maxEntries = validateLimit("maxEntries", options.maxEntries);
    this.#maxTotalBytes = validateLimit("maxTotalBytes", options.maxTotalBytes);
    this.#selectEntry = database.prepare(
      "SELECT hash, canonical_json, byte_length FROM schema_store_entries WHERE hash = ?",
    );
    this.#insertEntry = database.prepare(
      "INSERT OR IGNORE INTO schema_store_entries (hash, canonical_json, byte_length) VALUES (?, ?, ?)",
    );
    this.#usage = database.prepare(
      "SELECT COUNT(*) AS entries, COALESCE(SUM(byte_length), 0) AS total_bytes FROM schema_store_entries",
    );
  }

  static async open(options: SchemaStoreOptions): Promise<SqliteSchemaStore> {
    if (options.url.protocol === "file:") {
      await Deno.mkdir(Path.dirname(Path.fromFileUrl(options.url)), {
        recursive: true,
      });
    }
    const database = await new Database(databaseAddress(options.url), {
      create: true,
    });
    database.exec(PRAGMAS);
    database.exec(INIT);
    database.prepare(
      "INSERT OR IGNORE INTO schema_store_metadata (key, value) VALUES (?, ?)",
    ).run(GENERATION_KEY, crypto.randomUUID());
    const row = database.prepare(
      "SELECT value FROM schema_store_metadata WHERE key = ?",
    ).get(GENERATION_KEY) as { value: string } | undefined;
    if (!row || !row.value) {
      database.close();
      throw new Error("schema store generation metadata is missing");
    }
    return new SqliteSchemaStore(database, row.value, options);
  }

  put(schema: JSONSchema): StoredSchema {
    return this.putAll([schema])[0];
  }

  putAll(schemas: readonly JSONSchema[]): StoredSchema[] {
    const candidates = schemas.map((schema) => {
      const canonical = internSchema(schema, true);
      // Rehash canonical content instead of relying on the interning cache's
      // weak identity lookup for the durable content-addressed key.
      const hash = hashOf(canonical.schema).taggedHashString;
      const canonicalJson = JSON.stringify(canonical.schema);
      return {
        stored: { hash, schema: canonical.schema },
        canonicalJson,
        size: byteLength(canonicalJson),
      };
    });
    if (candidates.length === 0) return [];

    return this.database.transaction(() => {
      const resolved = new Map<string, StoredSchema>();
      const missing = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        if (resolved.has(candidate.stored.hash)) continue;
        const existing = this.#selectEntry.get(candidate.stored.hash) as
          | EntryRow
          | undefined;
        if (existing) {
          resolved.set(
            candidate.stored.hash,
            schemaFromRow(existing, candidate.stored.hash),
          );
        } else {
          missing.set(candidate.stored.hash, candidate);
        }
      }

      for (const candidate of missing.values()) {
        if (candidate.size > this.#maxSchemaBytes) {
          throw new SchemaStoreQuotaError(
            "maxSchemaBytes",
            `schema is ${candidate.size} bytes, exceeding maxSchemaBytes ${this.#maxSchemaBytes}`,
          );
        }
      }

      const usage = this.#usage.get() as UsageRow;
      const nextEntries = usage.entries + missing.size;
      if (nextEntries > this.#maxEntries) {
        throw new SchemaStoreQuotaError(
          "maxEntries",
          `schema store would have ${nextEntries} entries, exceeding maxEntries ${this.#maxEntries}`,
        );
      }
      const addedBytes = [...missing.values()].reduce(
        (total, candidate) => total + candidate.size,
        0,
      );
      const nextTotalBytes = (usage.total_bytes ?? 0) + addedBytes;
      if (nextTotalBytes > this.#maxTotalBytes) {
        throw new SchemaStoreQuotaError(
          "maxTotalBytes",
          `schema store would use ${nextTotalBytes} bytes, exceeding maxTotalBytes ${this.#maxTotalBytes}`,
        );
      }

      for (const candidate of missing.values()) {
        this.#insertEntry.run(
          candidate.stored.hash,
          candidate.canonicalJson,
          candidate.size,
        );
        resolved.set(candidate.stored.hash, candidate.stored);
      }
      return candidates.map((candidate) => {
        const stored = resolved.get(candidate.stored.hash);
        if (stored === undefined) {
          throw new Error("schema batch insertion did not resolve a candidate");
        }
        return stored;
      });
    }).immediate();
  }

  get(hash: string): StoredSchema | undefined {
    const row = this.#selectEntry.get(hash) as EntryRow | undefined;
    return row ? schemaFromRow(row, hash) : undefined;
  }

  has(hash: string): boolean {
    return this.get(hash) !== undefined;
  }

  close(): void {
    this.database.close();
  }
}

export const openSchemaStore = (
  options: SchemaStoreOptions,
): Promise<SqliteSchemaStore> => SqliteSchemaStore.open(options);
