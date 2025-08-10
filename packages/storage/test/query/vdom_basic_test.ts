import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { openSqlite } from "../../src/sqlite/db.ts";
import type { Database } from "@db/sqlite";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { SqliteStorage } from "../../src/query/sqlite_storage.ts";

// Helper to create LinkValue objects
function link(doc: string, pathTokens: string[] = []): any {
  return { "/": { "link@1": { id: doc, path: pathTokens } } };
}

// Seed into SQLite: vdom:0..N-1 with children pointing to higher index
async function seedVDOM(space: Awaited<ReturnType<typeof openSpaceStorage>>, N: number) {
  const TAGS = ["div", "span", "ul", "li", "p", "section"] as const;
  for (let i = 0; i < N; i++) {
    const tag = TAGS[i % TAGS.length] as any;
    const kids: any[] = [];
    if (i + 1 < N) kids.push(link(`vdom:${i + 1}`));
    if (i % 3 === 0 && i + 2 < N) kids.push(link(`vdom:${i + 2}`));
    const docId = `vdom:${i}`;
    await space.getOrCreateBranch(docId, "main");
    const d = Automerge.change(Automerge.init<any>(), (x: any) => {
      x.tag = tag;
      x.props = { id: `n-${i}`, idx: i, visible: true };
      x.children = kids;
    });
    const c = Automerge.getLastLocalChange(d)!;
    await space.submitTx({ reads: [], writes: [{ ref: { docId, branch: "main" }, baseHeads: [], changes: [{ bytes: c }] }] });
  }
}

Deno.test("vdom basic: recursive VNode schema validates small graph", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:vdom", { spacesDir });
  const db: Database = (await openSqlite({ url: new URL("./did:key:vdom.sqlite", spacesDir) })).db;
  const prov = new Provenance();
  const pool = new IRPool();
  const evaluator = new Evaluator(pool, new SqliteStorage(db), prov, { visitLimit: 1024 });

  await seedVDOM(space, 10);

  const VNodeRecursive = {
    $defs: {
      VNode: {
        type: "object",
        properties: {
          tag: { enum: ["div", "span", "ul", "li", "p", "section"] },
          props: { type: "object", additionalProperties: true },
          children: { type: "array", items: { $ref: "#/$defs/VNode" } },
        },
      },
    },
    $ref: "#/$defs/VNode",
  } as const;
  const ir = compileSchema(pool, VNodeRecursive as any);

  // Validate a few nodes; should not time out and should not be "No"
  for (let i = 0; i < 5; i++) {
    const res = evaluator.evaluate({ ir, doc: `vdom:${i}`, path: [] });
    assert(res.verdict !== "No");
  }
});

Deno.test({
  name: "vdom filter: tag=span flips from No to Yes after edit (direct doc)",
}, async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:vdom2", { spacesDir });
  const db: Database = (await openSqlite({ url: new URL("./did:key:vdom2.sqlite", spacesDir) })).db;
  const prov = new Provenance();
  const pool = new IRPool();
  const evaluator = new Evaluator(pool, new SqliteStorage(db), prov, { visitLimit: 1024 });

  await seedVDOM(space, 10);

  const schema = { type: "object", properties: { tag: { enum: ["span"] } } };
  const ir = compileSchema(pool, schema);

  // Verify vdom:0 starts as div → No
  const before = evaluator.evaluate({ ir, doc: "vdom:0", path: [] });
  assertEquals(before.verdict, "No");
  // Edit vdom:0 to span at root, using current heads as deps
  const heads = (await space.getBranchState("vdom:0", "main")).heads;
  const curBytes = await space.getDocBytes("vdom:0", "main", { accept: "automerge" });
  const curDoc = Automerge.load(curBytes);
  const d = Automerge.change(curDoc, (x: any) => {
    x.tag = "span";
    x.props = { id: "n-0", idx: 0, visible: true };
    x.children = [];
  });
  const c = Automerge.getLastLocalChange(d)!;
  await space.submitTx({ reads: [], writes: [{ ref: { docId: "vdom:0", branch: "main" }, baseHeads: heads, changes: [{ bytes: c }] }] });
  (evaluator as any)["memo"].clear();
  const after = evaluator.evaluate({ ir, doc: "vdom:0", path: [] });
  assertEquals(after.verdict, "Yes");
});
