// Tests for table()/cfLink() schema helpers and DDL generation
// (spec docs/specs/sqlite-builtin/01 + Phase 2 additive DDL).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  cfLink,
  createTableSQL,
  linkColumnsOf,
  table,
} from "../src/builtins/sqlite/schema.ts";

describe("cfLink", () => {
  it("emits a string column marked as a cf link", () => {
    expect(cfLink()).toEqual({ type: "string", cfLink: true, sqlType: "text" });
  });
});

describe("table", () => {
  it("builds an object schema from shorthand + cfLink columns", () => {
    const t = table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
      ts: "integer",
    });
    expect(t.type).toBe("object");
    expect(Object.keys(t.properties!)).toEqual([
      "id",
      "author_cf_link",
      "body",
      "ts",
    ]);
    expect(t.properties!.id).toEqual({ type: "integer", sqlType: "integer primary key" });
    expect(t.properties!.body).toEqual({ type: "string", sqlType: "text" });
    expect((t.properties!.author_cf_link as Record<string, unknown>).cfLink)
      .toBe(true);
    expect(t.required).toEqual(["id", "author_cf_link", "body", "ts"]);
  });

  it("passes through an explicit column schema object", () => {
    const t = table({ subject: { type: "string", sqlType: "text" } });
    expect(t.properties!.subject).toEqual({ type: "string", sqlType: "text" });
  });

  it("throws when a cfLink column is not named *_cf_link", () => {
    expect(() => table({ author: cfLink() })).toThrow();
  });

  it("throws when a *_cf_link column is not a string/text type", () => {
    expect(() => table({ author_cf_link: "integer" })).toThrow();
  });
});

describe("linkColumnsOf", () => {
  it("returns the set of cf-link column names", () => {
    const t = table({
      id: "integer",
      author_cf_link: cfLink(),
      reviewer_cf_link: cfLink(),
    });
    expect(new Set(linkColumnsOf(t))).toEqual(
      new Set(["author_cf_link", "reviewer_cf_link"]),
    );
  });
});

describe("createTableSQL", () => {
  it("generates CREATE TABLE IF NOT EXISTS with sql types", () => {
    const t = table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
    });
    const sql = createTableSQL("messages", t);
    expect(sql).toBe(
      'CREATE TABLE IF NOT EXISTS "messages" (\n' +
        "  id integer primary key,\n" +
        "  author_cf_link text,\n" +
        "  body text\n" +
        ")",
    );
  });
});
