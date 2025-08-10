import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";

Deno.test("test_pit_uses_chunks_after_last_snapshot", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:pit-chunks", { spacesDir });

  const docId = "doc:chunks";
  const branch = "main";

  // Write N=6 changes with snapshot cadence k=5 (default). Expect after seq=5 snapshot exists,
  // and PIT at seq=6 can be satisfied by 1 incremental chunk.
  let d = Automerge.init<any>();
  // First change
  d = Automerge.change(d, (doc) => {
    doc.v = 1;
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });

  // Apply 4 more to reach snapshot at seq=5
  for (let i = 2; i <= 5; i++) {
    d = Automerge.change(d, (doc) => {
      doc.v = i;
    });
    const c = Automerge.getLastLocalChange(d)!;
    const st = await space.getBranchState(docId, branch);
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: st.heads,
        changes: [{ bytes: c }],
      }],
    });
  }

  // One more change to be captured as a chunk
  d = Automerge.change(d, (doc) => {
    doc.v = 6;
  });
  const c6 = Automerge.getLastLocalChange(d)!;
  const st5 = await space.getBranchState(docId, branch);
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: st5.heads,
      changes: [{ bytes: c6 }],
    }],
  });

  // PIT at latest should equal v=6
  const latestBytes = await space.getDocBytes(docId, branch, {
    accept: "automerge",
  });
  const latest = Automerge.load(latestBytes) as any;
  assertEquals(latest.v, 6);
});

Deno.test("test_pit_fallback_without_chunks", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:pit-no-chunks", { spacesDir });

  const docId = "doc:nochunks";
  const branch = "main";

  // Disable chunking by writing a space_settings row
  // Note: we can get DB handle only via internal import for test purposes.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const { openSqlite } = await import("../../src/sqlite/db.ts");
  const handle = await openSqlite({
    url: new URL(`./did:key:pit-no-chunks.sqlite`, spacesDir),
  });
  handle.db.run(
    `INSERT OR REPLACE INTO space_settings(key, value_json) VALUES('settings', json('{"enableChunks": false}'))`,
  );

  let d = Automerge.init<any>();
  d = Automerge.change(d, (doc) => {
    doc.a = 1;
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });

  d = Automerge.change(d, (doc) => {
    doc.a = 2;
  });
  const c2 = Automerge.getLastLocalChange(d)!;
  const s1 = await space.getBranchState(docId, branch);
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });

  const latestBytes = await space.getDocBytes(docId, branch, {
    accept: "automerge",
  });
  const latest = Automerge.load(latestBytes) as any;
  assertEquals(latest.a, 2);

  await handle.close();
});
