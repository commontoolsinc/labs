import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { openSqlite } from "../../src/sqlite/db.ts";
import type { Database } from "@db/sqlite";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { SqliteStorageReader } from "../../src/query/sqlite_storage.ts";

Deno.test("compileSchema handles self-recursive $ref", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:rr", { spacesDir });
  const db: Database = (await openSqlite({
    url: new URL("./did:key:rr.sqlite", spacesDir),
  })).db;
  const pool = new IRPool();
  const schema = {
    definitions: {
      VNode: {
        type: "object",
        properties: {
          tag: { enum: ["div", "span"] },
          children: { type: "array", items: { $ref: "#/definitions/VNode" } },
        },
      },
    },
    $ref: "#/definitions/VNode",
  };
  const id = compileSchema(pool, schema);
  const node = pool.get(id);
  assertEquals(typeof node, "object");

  // Seed a small recursive doc graph
  const docId = "root";
  await space.getOrCreateBranch(docId, "main");
  const init = Automerge.init<any>();
  const d = Automerge.change(init, (x: any) => {
    x.tag = "div";
    x.children = [{ tag: "span", children: [] }];
  });
  const c = Automerge.getLastLocalChange(d)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: c }],
    }],
  });
  const storage = new SqliteStorageReader(db);
  const ev = new Evaluator(pool, storage, new Provenance());
  const res = ev.evaluate({ ir: id, doc: "root", path: [] });
  assertEquals(
    res.verdict === "Yes" || res.verdict === "MaybeExceededDepth",
    true,
  );
});

Deno.test("compileSchema handles mutual recursion via $ref", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:rr2", { spacesDir });
  const db: Database = (await openSqlite({
    url: new URL("./did:key:rr2.sqlite", spacesDir),
  })).db;
  const pool = new IRPool();
  const schema = {
    definitions: {
      A: {
        type: "object",
        properties: { b: { $ref: "#/definitions/B" } },
      },
      B: {
        type: "object",
        properties: { a: { $ref: "#/definitions/A" } },
      },
    },
    $ref: "#/definitions/A",
  };
  const id = compileSchema(pool, schema);
  const node = pool.get(id);
  assertEquals(typeof node, "object");

  // Seed mutual recursion
  const docId = "docA";
  await space.getOrCreateBranch(docId, "main");
  const d0 = Automerge.change(Automerge.init<any>(), (x: any) => {
    x.b = { a: { b: {} } };
  });
  const c0 = Automerge.getLastLocalChange(d0)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: c0 }],
    }],
  });
  const ev = new Evaluator(pool, new SqliteStorageReader(db), new Provenance());
  const res = ev.evaluate({ ir: id, doc: "docA", path: [] });
  assertEquals(
    ["Yes", "MaybeExceededDepth"].includes(res.verdict as any),
    true,
  );
});
