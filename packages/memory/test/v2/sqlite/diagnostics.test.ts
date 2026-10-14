import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import {
  FILL_SAMPLE_LIMIT,
  fillSampleSql,
  readFillSample,
  readTablePresence,
  tablePresenceSql,
} from "../../../v2/sqlite/diagnostics.ts";
import { runQuery } from "../../../v2/sqlite/exec.ts";
import { assertReadOnly } from "../../../v2/sqlite/guard.ts";

/** Rows in the seeded `messages` table: more than one sample reads. */
const MESSAGE_ROWS = FILL_SAMPLE_LIMIT + 500;

describe("diagnostics", () => {
  // Every statement runs through `runQuery()`, the server's read path, which
  // holds it to the statement guard before SQLite sees it. `messages_watched`
  // is `messages` behind a filter that counts the rows a statement reads, so a
  // case can state how much of the table a statement touched rather than only
  // what it returned.

  let database: Database;
  let rowsRead: number;

  beforeEach(() => {
    database = new Database(":memory:");
    rowsRead = 0;
    database.function("read_row", () => {
      rowsRead++;
      return 1;
    });
    database.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, body BLOB, " +
        "received_at TEXT)",
    );
    database.exec("CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT)");
    database.exec(
      "CREATE VIEW messages_watched AS SELECT * FROM messages WHERE read_row()",
    );
    // Every row has a sender, odd rows a body, and only rows past the first
    // sample's worth a receipt time — the column that looks empty to a sample
    // while the table holds values in it.
    const insert = database.prepare(
      "INSERT INTO messages (id, sender, body, received_at) VALUES (?, ?, ?, ?)",
    );
    database.exec("BEGIN");
    for (let id = 1; id <= MESSAGE_ROWS; id++) {
      insert.run(
        id,
        `sender-${id}`,
        id % 2 === 1 ? new Uint8Array(64) : null,
        id > FILL_SAMPLE_LIMIT ? "2026-10-14T09:00:00Z" : null,
      );
    }
    database.exec("COMMIT");
    insert.finalize();
  });

  afterEach(() => {
    database.close();
  });

  describe("tablePresenceSql()", () => {
    it("returns a row read as `true` for a table holding rows", () => {
      const [row] = runQuery(database, tablePresenceSql("messages"));

      expect(readTablePresence(row)).toBe(true);
    });

    it("returns a row read as `false` for a table holding none", () => {
      const [row] = runQuery(database, tablePresenceSql("drafts"));

      expect(readTablePresence(row)).toBe(false);
    });

    it("reads one row of a table holding many", () => {
      runQuery(database, "SELECT count(*) AS n FROM messages_watched");
      expect(rowsRead).toBe(MESSAGE_ROWS);
      rowsRead = 0;

      runQuery(database, tablePresenceSql("messages_watched"));

      expect(rowsRead).toBe(1);
    });

    it("returns a statement the read-only guard accepts", () => {
      expect(() => assertReadOnly(tablePresenceSql('odd "name"'))).not
        .toThrow();
    });
  });

  describe("readTablePresence()", () => {
    it("returns `undefined` for a row that does not carry the answer", () => {
      expect(readTablePresence(undefined)).toBeUndefined();
      expect(readTablePresence({})).toBeUndefined();
      expect(readTablePresence({ present: 2 })).toBeUndefined();
      expect(readTablePresence({ present: "1" })).toBeUndefined();
    });
  });

  describe("fillSampleSql()", () => {
    it("returns how many rows it sampled and how many of them hold a value in each column", () => {
      const columns = ["sender", "body"];
      const [row] = runQuery(database, fillSampleSql("messages", columns));

      expect(readFillSample(row, columns.length)).toEqual({
        sampled: FILL_SAMPLE_LIMIT,
        nonNull: [FILL_SAMPLE_LIMIT, FILL_SAMPLE_LIMIT / 2],
      });
    });

    it("counts `0` for a column NULL in every sampled row", () => {
      database.exec("UPDATE messages SET received_at = NULL");
      const columns = ["sender", "received_at"];

      const [row] = runQuery(database, fillSampleSql("messages", columns));

      expect(readFillSample(row, columns.length)?.nonNull).toEqual([
        FILL_SAMPLE_LIMIT,
        0,
      ]);
    });

    it("counts `0` for a column whose values all lie past the rows it sampled", () => {
      // The figure is the sample's and not the table's: the table holds 500
      // receipt times, and the sample reads none of them.

      const [row] = runQuery(
        database,
        fillSampleSql("messages", ["received_at"]),
      );

      expect(readFillSample(row, 1)?.nonNull).toEqual([0]);
      expect(
        runQuery(database, "SELECT count(received_at) AS n FROM messages")[0].n,
      ).toBe(MESSAGE_ROWS - FILL_SAMPLE_LIMIT);
    });

    it("reads no more than `FILL_SAMPLE_LIMIT` rows of a larger table", () => {
      const [row] = runQuery(
        database,
        fillSampleSql("messages_watched", ["sender", "body", "received_at"]),
      );

      expect(readFillSample(row, 3)?.sampled).toBe(FILL_SAMPLE_LIMIT);
      expect(rowsRead).toBeLessThanOrEqual(FILL_SAMPLE_LIMIT);
    });

    it("returns `0` sampled rows and no value in any column for an empty table", () => {
      const [row] = runQuery(database, fillSampleSql("drafts", ["body"]));

      expect(readFillSample(row, 1)).toEqual({ sampled: 0, nonNull: [0] });
    });

    it("returns the rows it sampled when asked about no column", () => {
      database.exec("INSERT INTO drafts (body) VALUES ('one'), ('two')");

      const [row] = runQuery(database, fillSampleSql("drafts", []));

      expect(readFillSample(row, 0)).toEqual({ sampled: 2, nonNull: [] });
    });

    it("reads a table and columns whose names hold a quote, or the name of another figure", () => {
      database.exec(
        'CREATE TABLE "odd ""table""" ("sampled" TEXT, "c1" TEXT, "a""b" TEXT)',
      );
      database.exec(
        `INSERT INTO "odd ""table""" VALUES ('x', NULL, 'y'), (NULL, NULL, 'z')`,
      );
      const columns = ["sampled", "c1", 'a"b'];

      const [row] = runQuery(
        database,
        fillSampleSql('odd "table"', columns),
      );

      expect(readFillSample(row, columns.length)).toEqual({
        sampled: 2,
        nonNull: [1, 0, 2],
      });
    });

    it("returns a statement the read-only guard accepts", () => {
      expect(() => assertReadOnly(fillSampleSql('odd "name"', ["a", 'b"c'])))
        .not.toThrow();
    });
  });

  describe("readFillSample()", () => {
    it("returns `undefined` for a row that does not carry every figure", () => {
      expect(readFillSample(undefined, 0)).toBeUndefined();
      expect(readFillSample({ c0: 1 }, 1)).toBeUndefined();
      expect(readFillSample({ sampled: 3 }, 1)).toBeUndefined();
      expect(readFillSample({ sampled: 3, c0: -1 }, 1)).toBeUndefined();
      expect(readFillSample({ sampled: 3, c0: 1.5 }, 1)).toBeUndefined();
      expect(readFillSample({ sampled: "3", c0: 1 }, 1)).toBeUndefined();
    });
  });
});
