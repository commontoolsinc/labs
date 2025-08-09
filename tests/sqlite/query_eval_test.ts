import { assertEquals } from "@std/assert";
import * as Automerge from "npm:@automerge/automerge";
import { openSpaceStorage } from "../../packages/storage/src/provider.ts";
import { compileQuery } from "../../packages/storage/src/sqlite/query_ir.ts";
import { evaluatePlan } from "../../packages/storage/src/sqlite/query_eval.ts";

Deno.test("query filters, sorts, limits", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-tests", { spacesDir });

  const docId = "doc:q1";
  const branch = "main";

  // Create three items
  let d = Automerge.init<any>();
  d = Automerge.change(d, (doc) => { doc.items = [
    { id: 1, name: "b", score: 3 },
    { id: 2, name: "a", score: 5 },
    { id: 3, name: "c", score: 1 },
  ]; });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({ reads: [], writes: [{ ref: { docId, branch }, baseHeads: [], changes: [{ bytes: c1 }] }] });

  // Query: filter score > 2, sort by name asc, limit 2
  const plan = compileQuery({
    source: { docs: [docId], path: ["items"] },
    filter: { kind: "gt", field: "score", value: 2 },
    sort: [{ field: "name", order: "asc" }],
    limit: { limit: 2 },
  });

  const { openSqlite } = await import("../../packages/storage/src/sqlite/db.ts");
  const { db, close } = await openSqlite({ url: new URL(`./did:key:query-tests.sqlite`, spacesDir) });
  try {
    const rows = evaluatePlan(plan, { db });
    const names = rows.map((r: any) => r.value.name);
    assertEquals(names, ["a", "b"]);
  } finally {
    await close();
  }
});

Deno.test("joins via link fields and traversal with budget", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-join", { spacesDir });

  const a = "doc:a"; const b = "doc:b"; const c = "doc:c";
  const branch = "main";

  // Create docs with link topology: a -> b -> c, and a -> c (cycle-safe)
  let da = Automerge.change(Automerge.init<any>(), (doc) => { doc.ref = { doc: b, path: [] }; });
  let dbb = Automerge.change(Automerge.init<any>(), (doc) => { doc.ref = { doc: c, path: [] }; });
  let dc = Automerge.change(Automerge.init<any>(), (doc) => { doc.value = 42; });
  await space.submitTx({ reads: [], writes: [{ ref: { docId: a, branch }, baseHeads: [], changes: [{ bytes: Automerge.getLastLocalChange(da)! }] }] });
  await space.submitTx({ reads: [], writes: [{ ref: { docId: b, branch }, baseHeads: [], changes: [{ bytes: Automerge.getLastLocalChange(dbb)! }] }] });
  await space.submitTx({ reads: [], writes: [{ ref: { docId: c, branch }, baseHeads: [], changes: [{ bytes: Automerge.getLastLocalChange(dc)! }] }] });

  const { openSqlite } = await import("../../packages/storage/src/sqlite/db.ts");
  const { db, close } = await openSqlite({ url: new URL(`./did:key:query-join.sqlite`, spacesDir) });
  try {
    // Join a.ref, then traverse via ref depth=2 to reach c
    const plan = compileQuery({
      source: { docs: [a] },
      budget: { linkBudget: 3 },
      join: { via: "ref" },
      traverse: { via: "ref", depth: 2, accumulate: false },
      project: ["value"],
    });
    const rows = evaluatePlan(plan, { db });
    // Expect to see value from c
    const values = rows.map((r: any) => r.value.value).filter((v: any) => v !== undefined);
    assertEquals(values.includes(42), true);
  } finally {
    await close();
  }
});

