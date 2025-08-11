import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { decodeChangeHeader } from "../../src/store/change.ts";
import { openSqlite } from "../../src/store/db.ts";

Deno.test("test_server_merge_guarded_by_flag", async () => {
  // Ensure flag disabled
  Deno.env.set("ENABLE_SERVER_MERGE", "0");

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const did = "did:key:merge-tests";
  const space = await openSpaceStorage(did, { spacesDir });

  const docId = "doc:merge-guard";
  const branch = "main";

  // Create two concurrent heads on main
  const s0 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s0.heads, []);

  // First change from empty base
  const a0 = Automerge.init();
  const a1 = Automerge.change(a0, (doc: any) => {
    doc.x = 1;
  });
  const c1 = Automerge.getLastLocalChange(a1)!;
  const h1 = decodeChangeHeader(c1).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.heads, [h1]);

  // Second independent change derived from empty base (deps = []) to create fork
  const b0 = Automerge.init();
  const b1 = Automerge.change(b0, (doc: any) => {
    doc.y = 2;
  });
  const c2 = Automerge.getLastLocalChange(b1)!;
  const h2 = decodeChangeHeader(c2).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const s2 = await space.getBranchState(docId, branch);
  assertEquals([...s2.heads].sort(), [h1, h2].sort());

  // Now submit with baseHeads mismatch and expect conflict (server merge disabled)
  const r = await space.submitTx({
    reads: [],
    writes: [{ ref: { docId, branch }, baseHeads: [], changes: [] }],
  });
  assertEquals(r.results[0]?.status, "conflict");
  assertEquals(r.results[0]?.reason, "baseHeads mismatch");
  const s3 = await space.getBranchState(docId, branch);
  assertEquals([...s3.heads].sort(), [h1, h2].sort());
});

Deno.test("test_server_merge_enabled", async () => {
  // Enable flag
  Deno.env.set("ENABLE_SERVER_MERGE", "1");

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const did = "did:key:merge-tests-enabled";
  const space = await openSpaceStorage(did, { spacesDir });

  const docId = "doc:merge-enabled";
  const branch = "main";

  // Create two concurrent heads on main
  const a0 = Automerge.init();
  const a1 = Automerge.change(a0, (doc: any) => {
    doc.a = 1;
  });
  const c1 = Automerge.getLastLocalChange(a1)!;
  const h1 = decodeChangeHeader(c1).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.heads, [h1]);

  const b0 = Automerge.init();
  const b1 = Automerge.change(b0, (doc: any) => {
    doc.b = 2;
  });
  const c2 = Automerge.getLastLocalChange(b1)!;
  const h2 = decodeChangeHeader(c2).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const s2 = await space.getBranchState(docId, branch);
  assertEquals([...s2.heads].sort(), [h1, h2].sort());

  // Submit with baseHeads mismatch, expect server-merge to collapse to 1 head
  const r = await space.submitTx({
    reads: [],
    writes: [{ ref: { docId, branch }, baseHeads: [], changes: [] }],
  });
  assertEquals(r.results[0]?.status, "ok");
  assertEquals(r.results[0]?.applied, 0); // synthesized merge only
  const s3 = await space.getBranchState(docId, branch);
  assertEquals(s3.heads.length, 1);
});

Deno.test("test_close_branch_post_merge", async () => {
  Deno.env.set("ENABLE_SERVER_MERGE", "1");

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const did = "did:key:merge-tests-close";
  const space = await openSpaceStorage(did, { spacesDir });

  const docId = "doc:merge-close";
  const main = "main";
  const feature = "feature/x";

  await space.getOrCreateBranch(docId, main);
  await space.getOrCreateBranch(docId, feature);

  // Put a change on feature
  const d0 = Automerge.init();
  const d1 = Automerge.change(d0, (doc: any) => {
    doc.title = "feat";
  });
  const cf = Automerge.getLastLocalChange(d1)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: feature },
      baseHeads: [],
      changes: [{ bytes: cf }],
    }],
  });

  // Put a base change on main too
  const e0 = Automerge.init();
  const e1 = Automerge.change(e0, (doc: any) => {
    doc.base = true;
  });
  const cm = Automerge.getLastLocalChange(e1)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: main },
      baseHeads: [],
      changes: [{ bytes: cm }],
    }],
  });

  // Merge feature into main via explicit API (should close feature)
  const head = await space.mergeBranches(docId, feature, main);
  assert(head && typeof head === "string");

  // Inspect branches table directly
  const dbUrl = new URL(`./${did}.sqlite`, spacesDir);
  const { db, close } = await openSqlite({ url: dbUrl });
  try {
    const row = db.prepare(
      `SELECT b.closed as closed, b.merged_into_branch_id as merged_into_branch_id
       FROM branches b WHERE b.doc_id = :doc_id AND b.name = :name`,
    ).get({ doc_id: docId, name: feature }) as {
      closed: number;
      merged_into_branch_id: string | null;
    } | undefined;
    assert(row);
    assertEquals(row!.closed, 1);
    assert(
      typeof row!.merged_into_branch_id === "string" &&
        row!.merged_into_branch_id.length > 0,
    );
  } finally {
    await close();
  }
});

Deno.test("test_no_close_if_not_collapsed", async () => {
  Deno.env.set("ENABLE_SERVER_MERGE", "1");

  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const did = "did:key:merge-tests-noclose";
  const space = await openSpaceStorage(did, { spacesDir });

  const docId = "doc:noclose";
  const main = "main";
  const feature = "feature/y";

  await space.getOrCreateBranch(docId, main);
  await space.getOrCreateBranch(docId, feature);

  // Create two heads on main
  const a0 = Automerge.init();
  const a1 = Automerge.change(a0, (doc: any) => {
    doc.m = 1;
  });
  const c1 = Automerge.getLastLocalChange(a1)!;
  const h1 = decodeChangeHeader(c1).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: main },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  const s1 = await space.getBranchState(docId, main);
  assertEquals(s1.heads, [h1]);

  const b0 = Automerge.init();
  const b1 = Automerge.change(b0, (doc: any) => {
    doc.n = 2;
  });
  const c2 = Automerge.getLastLocalChange(b1)!;
  const h2 = decodeChangeHeader(c2).changeHash;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: main },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const s2 = await space.getBranchState(docId, main);
  assertEquals([...s2.heads].sort(), [h1, h2].sort());

  // Now submit a change that references only h1 (leaving >1 heads), but provide mergeOf
  const baseDoc = Automerge.applyChanges(Automerge.init(), [
    Automerge.getLastLocalChange(a1)!,
  ]);
  const baseApplied = Array.isArray(baseDoc) ? baseDoc[0] : baseDoc;
  const m1 = Automerge.change(baseApplied, (doc: any) => {
    doc.extra = true;
  });
  const c3 = Automerge.getLastLocalChange(m1)!;
  const r = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: main },
      baseHeads: s2.heads,
      changes: [{ bytes: c3 }],
      mergeOf: [{ branch: feature, heads: [] }],
    }],
  });
  assertEquals(r.results[0]?.status, "ok");
  const s3 = await space.getBranchState(docId, main);
  assert(s3.heads.length > 1); // not collapsed

  // Inspect feature branch should NOT be closed
  const dbUrl = new URL(`./${did}.sqlite`, spacesDir);
  const { db, close } = await openSqlite({ url: dbUrl });
  try {
    const row = db.prepare(
      `SELECT b.closed as closed, b.merged_into_branch_id as merged_into_branch_id
       FROM branches b WHERE b.doc_id = :doc_id AND b.name = :name`,
    ).get({ doc_id: docId, name: feature }) as {
      closed: number;
      merged_into_branch_id: string | null;
    } | undefined;
    assert(row);
    assertEquals(row!.closed, 0);
    assertEquals(row!.merged_into_branch_id, null);
  } finally {
    await close();
  }
});
