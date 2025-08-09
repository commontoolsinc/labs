import { assert, assertEquals } from "@std/assert";
import * as Automerge from "npm:@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { openSqlite } from "../../src/sqlite/db.ts";
import type { Database } from "@db/sqlite";
import { IRPool, compileSchema } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { SqliteStorage } from "../../src/query/sqlite_storage.ts";

Deno.test("schema compile with #/definitions and evaluation over SQLite", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-test", { spacesDir });
  const db: Database = (await openSqlite({ url: new URL("./did:key:query-test.sqlite", spacesDir) })).db;

  // Seed two docs: a Task with an assignee link and a User profile
  const taskId = "doc:T"; const userId = "doc:U";
  await space.getOrCreateBranch(taskId, "main");
  await space.getOrCreateBranch(userId, "main");
  const uInit = Automerge.init<any>();
  const u = Automerge.change(uInit, (d:any)=>{ d.profile = { name: "Alice", org: "eng", tags: ["alpha"] }; });
  const uC = Automerge.getLastLocalChange(u)!;
  await space.submitTx({ reads: [], writes: [{ ref: { docId: userId, branch: "main" }, baseHeads: [], changes: [{ bytes: uC }] }] });

  const tInit = Automerge.init<any>();
  const t = Automerge.change(tInit, (d:any)=>{
    d.value = { status: "open", assignee: { "/": { "link@1": { id: userId, path: "/profile" } } } };
  });
  const tC = Automerge.getLastLocalChange(t)!;
  await space.submitTx({ reads: [], writes: [{ ref: { docId: taskId, branch: "main" }, baseHeads: [], changes: [{ bytes: tC }] }] });

  const pool = new IRPool();
  const schema = {
    definitions: {
      Profile: { type: "object", properties: { name: { type: "string" } } },
    },
    type: "object",
    properties: { value: { type: "object", properties: { status: { const: "open" }, assignee: { $ref: "#/definitions/Profile" } } } },
  };
  const ir = compileSchema(pool, schema);
  const storage = new SqliteStorage(db);
  const evaluator = new Evaluator(pool, storage, new Provenance());
  const res = evaluator.evaluate({ ir, doc: taskId, path: [], budget: 1 });
  assertEquals(res.verdict, "Yes");
});

Deno.test("schema evaluator budget yields MaybeExceededDepth at depth=0 for link", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-budget", { spacesDir });
  const db: Database = (await openSqlite({ url: new URL("./did:key:query-budget.sqlite", spacesDir) })).db;

  const A = "doc:A"; const B = "doc:B";
  await space.getOrCreateBranch(A, "main");
  await space.getOrCreateBranch(B, "main");
  const b0 = Automerge.change(Automerge.init<any>(), (d:any)=>{ d.x = 1 });
  await space.submitTx({ reads: [], writes: [{ ref: { docId: B, branch: "main" }, baseHeads: [], changes: [{ bytes: Automerge.getLastLocalChange(b0)! }] }] });
  const a0 = Automerge.change(Automerge.init<any>(), (d:any)=>{ d.ref = { "/": { "link@1": { id: B, path: "" } } } });
  await space.submitTx({ reads: [], writes: [{ ref: { docId: A, branch: "main" }, baseHeads: [], changes: [{ bytes: Automerge.getLastLocalChange(a0)! }] }] });

  const pool = new IRPool();
  const schema = { type: "object", properties: { ref: { type: "object" } } };
  const ir = compileSchema(pool, schema);
  const evaluator = new Evaluator(pool, new SqliteStorage(db), new Provenance());
  const res0 = evaluator.evaluate({ ir, doc: A, path: [], budget: 0 });
  assertEquals(res0.verdict, "MaybeExceededDepth");
  const res1 = evaluator.evaluate({ ir, doc: A, path: [], budget: 1 });
  assert(res1.verdict === "Yes" || res1.verdict === "No");
});

