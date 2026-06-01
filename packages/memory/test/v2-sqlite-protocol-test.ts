// End-to-end test of the sqlite.query / sqlite.execute protocol verbs over the
// in-process loopback transport (same protocol as the real websocket). Proves
// the server handlers, ATTACH + ensureTables, the statement guard, and cell-db
// persistence work through the wire, without a real toolshed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import { cfLink, table } from "../v2/sqlite/schema.ts";
import type { SqliteDbRef } from "../v2.ts";

const SPACE = "did:key:z6Mk-sqlite-protocol-test";

// Unique db id per test so the (deterministic, persistent) cell-db file does not
// leak data across tests or across suite runs.
let dbId: string;
const dbRef = (): SqliteDbRef => ({
  id: dbId,
  tables: {
    messages: table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
    }),
  },
});

describe("sqlite protocol verbs (loopback)", () => {
  let server: Server;
  let client: Awaited<ReturnType<typeof connect>>;
  // deno-lint-ignore no-explicit-any
  let session: any;

  beforeEach(async () => {
    dbId = `of:test-db-${crypto.randomUUID()}`;
    server = new Server({ store: new URL("memory://sqlite-protocol-test") });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(SPACE);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("executes a write then reads it back over the protocol", async () => {
    const db = dbRef();
    const w = await session.sqliteExecute(
      db,
      "INSERT INTO messages (author_cf_link, body) VALUES (?, ?)",
      ["sigil-link", "hello"],
    );
    expect(w.changes).toBe(1);

    const r = await session.sqliteQuery(
      db,
      "SELECT body FROM messages ORDER BY id",
    );
    expect(r.rows).toEqual([{ body: "hello" }]);
  });

  it("returns an empty result for an auto-created (empty) table", async () => {
    const r = await session.sqliteQuery(dbRef(), "SELECT * FROM messages");
    expect(r.rows).toEqual([]);
  });

  it("enforces the statement guard over the protocol", async () => {
    const db = dbRef();
    // write statement through the read verb
    await expect(
      session.sqliteQuery(db, "INSERT INTO messages (body) VALUES ('x')"),
    )
      .rejects.toThrow();
    // core-table reference
    await expect(session.sqliteQuery(db, "SELECT * FROM commit")).rejects
      .toThrow();
    // DDL through the write verb
    await expect(session.sqliteExecute(db, "DROP TABLE messages")).rejects
      .toThrow();
  });

  it("does not exhaust the attach limit across many cell-dbs (LRU evicts)", async () => {
    // More than SQLITE_MAX_ATTACHED distinct cell-dbs in one space; each must
    // still work (the server evicts least-recently-used attachments).
    for (let i = 0; i < 14; i++) {
      const db: SqliteDbRef = {
        id: `${dbId}-lru-${i}`,
        tables: { t: table({ id: "integer primary key", v: "text" }) },
      };
      await session.sqliteExecute(db, "INSERT INTO t (v) VALUES (?)", [`${i}`]);
      const r = await session.sqliteQuery(db, "SELECT v FROM t");
      expect(r.rows).toEqual([{ v: `${i}` }]);
    }
  });

  it("persists across separate requests (cell-db is file-backed)", async () => {
    const db = dbRef();
    await session.sqliteExecute(
      db,
      "INSERT INTO messages (body) VALUES (?)",
      ["a"],
    );
    await session.sqliteExecute(
      db,
      "INSERT INTO messages (body) VALUES (?)",
      ["b"],
    );
    const r = await session.sqliteQuery(
      db,
      "SELECT count(*) AS n FROM messages",
    );
    expect(r.rows).toEqual([{ n: 2 }]);
  });
});
