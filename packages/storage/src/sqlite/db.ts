import { Database, type SqliteError } from "@db/sqlite";

export interface OpenDbOptions {
  url: URL; // file: URL pointing to per-space db file
}

export interface SqliteHandle {
  db: Database;
  close(): Promise<void>;
}

async function applyPragmas(db: Database): Promise<void> {
  // Keep in sync with docs/specs/storage/02-schema.md
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA page_size = 4096;
    PRAGMA foreign_keys = ON;
  `);
}

async function runMigrations(db: Database): Promise<void> {
  const schemaUrl = new URL("./schema.sql", import.meta.url);
  const schema = await Deno.readTextFile(schemaUrl);
  await db.exec(schema);
}

export async function openSqlite({ url }: OpenDbOptions): Promise<SqliteHandle> {
  const db = await new Database(url);
  try {
    await applyPragmas(db);
    await runMigrations(db);
  } catch (error) {
    try {
      await db.close();
      // deno-lint-ignore no-empty
    } catch {}
    throw error as SqliteError;
  }
  return {
    db,
    async close() {
      await db.close();
    },
  };
}


