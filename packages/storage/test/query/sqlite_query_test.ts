import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { openSqlite } from "../../src/store/db.ts";
import type { Database } from "@db/sqlite";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { SqliteStorageReader } from "../../src/query/sqlite_storage.ts";

Deno.test("schema compile with #/definitions and evaluation over SQLite", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-test", { spacesDir });
  const db: Database = (await openSqlite({
    url: new URL("./did:key:query-test.sqlite", spacesDir),
  })).db;

  // Seed two docs: a Task with an assignee link and a User profile
  const taskId = "doc:T";
  const userId = "doc:U";
  await space.getOrCreateBranch(taskId, "main");
  await space.getOrCreateBranch(userId, "main");
  const uInit = Automerge.init<any>();
  const u = Automerge.change(uInit, (d: any) => {
    d.profile = { name: "Alice", org: "eng", tags: ["alpha"] };
  });
  const uC = Automerge.getLastLocalChange(u)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: userId, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: uC }],
    }],
  });

  const tInit = Automerge.init<any>();
  const t = Automerge.change(tInit, (d: any) => {
    d.value = {
      status: "open",
      assignee: { "/": { "link@1": { id: userId, path: ["profile"] } } },
    };
  });
  const tC = Automerge.getLastLocalChange(t)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: taskId, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: tC }],
    }],
  });

  const pool = new IRPool();
  const schema = {
    definitions: {
      Profile: { type: "object", properties: { name: { type: "string" } } },
    },
    type: "object",
    properties: {
      value: {
        type: "object",
        properties: {
          status: { const: "open" },
          assignee: { $ref: "#/definitions/Profile" },
        },
      },
    },
  };
  const ir = compileSchema(pool, schema);
  const storage = new SqliteStorageReader(db);
  const evaluator = new Evaluator(pool, storage, new Provenance());
  const res = evaluator.evaluate({ ir, doc: taskId, path: [] });
  assertEquals(res.verdict, "Yes");
});

Deno.test("link topology change: adding new child triggers touch and provenance edge", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-topology", { spacesDir });
  const db: Database = (await openSqlite({
    url: new URL("./did:key:query-topology.sqlite", spacesDir),
  })).db;

  const root = "doc:R";
  const child = "doc:C";
  await space.getOrCreateBranch(root, "main");
  await space.getOrCreateBranch(child, "main");

  // Seed root with empty children array
  let r = Automerge.init<any>();
  r = Automerge.change(r, (x: any) => {
    x.tag = "div";
    x.children = [];
  });
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: root, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: Automerge.getLastLocalChange(r)! }],
    }],
  });

  const storage = new SqliteStorageReader(db);
  const pool = new IRPool();
  const prov = new Provenance();
  const evalr = new Evaluator(pool, storage, prov);
  const { SubscriptionIndex } = await import("../../src/query/subs.ts");
  const { ChangeProcessor } = await import(
    "../../src/query/change_processor.ts"
  );
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);

  // Recursive VNode schema
  const VNodeRecursive = {
    $defs: {
      VNode: {
        type: "object",
        properties: {
          tag: { type: "string" },
          children: { type: "array", items: { $ref: "#/$defs/VNode" } },
        },
      },
    },
    $ref: "#/$defs/VNode",
  } as const;
  const ir = compileSchema(pool, VNodeRecursive as any);
  proc.registerQuery({ id: "q", doc: root, path: [], ir });

  // Simulate a delta on the children array, then add a child and send delta for specific index
  const v0 = storage.currentVersion(root);
  proc.onDelta({
    doc: root,
    changed: new Set([JSON.stringify(["children"])]) as any,
    removed: new Set(),
    newDoc: undefined,
    atVersion: v0,
  });

  // Compute proper base heads for the next write
  const heads0 = (await space.getBranchState(root, "main")).heads;
  r = Automerge.change(r, (x: any) => {
    x.children.push({ "/": { "link@1": { id: child, path: [] } } });
  });
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: root, branch: "main" },
      baseHeads: heads0,
      changes: [{ bytes: Automerge.getLastLocalChange(r)! }],
    }],
  });
  const v1 = storage.currentVersion(root);
  const ev1 = proc.onDelta({
    doc: root,
    changed: new Set([
      JSON.stringify(["children"]),
      JSON.stringify(["children", "0"]),
    ]) as any,
    removed: new Set(),
    newDoc: undefined,
    atVersion: v1,
  });
  assert(ev1.length >= 1);
  // Expect touchAdded to include the new link slot at children/0 on the root doc
  const keyChildren0 = JSON.stringify(["children", "0"]);
  const sawNewSlot = ev1.some((e) =>
    (e as any).touchAdded?.some?.((l: any) =>
      l?.doc === root && JSON.stringify(l?.path ?? []) === keyChildren0
    )
  );
  assert(sawNewSlot);
});

Deno.test("schema evaluator yields MaybeExceededDepth when visit limit is tiny", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:query-budget", { spacesDir });
  const db: Database = (await openSqlite({
    url: new URL("./did:key:query-budget.sqlite", spacesDir),
  })).db;

  const A = "doc:A";
  const B = "doc:B";
  await space.getOrCreateBranch(A, "main");
  await space.getOrCreateBranch(B, "main");
  const b0 = Automerge.change(Automerge.init<any>(), (d: any) => {
    d.x = 1;
  });
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: B, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: Automerge.getLastLocalChange(b0)! }],
    }],
  });
  const a0 = Automerge.change(Automerge.init<any>(), (d: any) => {
    d.ref = { "/": { "link@1": { id: B, path: [] } } };
  });
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId: A, branch: "main" },
      baseHeads: [],
      changes: [{ bytes: Automerge.getLastLocalChange(a0)! }],
    }],
  });

  const pool = new IRPool();
  // Require traversing into B to read x
  const schema = {
    type: "object",
    properties: {
      ref: { type: "object", properties: { x: { type: "number" } } },
    },
  };
  const ir = compileSchema(pool, schema);
  const evaluator = new Evaluator(
    pool,
    new SqliteStorageReader(db),
    new Provenance(),
    { visitLimit: 0 }, // force immediate limit exhaustion
  );
  const res0 = evaluator.evaluate({ ir, doc: A, path: [] });
  assertEquals(res0.verdict, "MaybeExceededDepth");
});
