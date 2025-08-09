import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("PIT by epoch and timestamp with projection", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // First change
  let d = Automerge.init();
  d = Automerge.change(d, (doc: any) => {
    doc.value = { n: 1, inner: { a: 10, b: 20 } };
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  const r1 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  const epoch1 = r1.txId;

  // Second change
  d = Automerge.change(d, (doc: any) => {
    doc.value.n = 2;
  });
  const c2 = Automerge.getLastLocalChange(d)!;
  const s1 = await space.getBranchState(docId, branch);
  const r2 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const epoch2 = r2.txId;

  // Latest JSON
  const latest = await space.getDocBytes(docId, branch, { accept: "json" });
  const latestJson = JSON.parse(new TextDecoder().decode(latest));
  assertEquals(latestJson.value.n, 2);

  // PIT by epoch1
  const pit1 = await space.getDocBytes(docId, branch, {
    accept: "json",
    epoch: epoch1,
  });
  const pit1Json = JSON.parse(new TextDecoder().decode(pit1));
  assertEquals(pit1Json.value.n, 1);

  // PIT projection at latest
  const proj = await space.getDocBytes(docId, branch, {
    accept: "json",
    paths: [["value", "inner", "a"]],
  });
  const projJson = JSON.parse(new TextDecoder().decode(proj));
  assertEquals(projJson, { value: { inner: { a: 10 } } });
});
