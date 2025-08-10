import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { decodeChangeHeader } from "../src/store/change.ts";

Deno.test("linear changes update heads and seq", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // initial state
  const s0 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s0.heads, []);
  assertEquals(s0.seqNo, 0);

  // build first change
  let d0 = Automerge.init();
  let d1 = Automerge.change(d0, (doc: any) => {
    doc.value = { count: 1 };
  });
  const c1 = Automerge.getLastLocalChange(d1)!;
  const h1 = decodeChangeHeader(c1).changeHash;

  // submit first change
  const r1 = await space.submitTx({
    reads: [],
    writes: [
      {
        ref: { docId, branch },
        baseHeads: [],
        changes: [{ bytes: c1 }],
      },
    ],
  });
  assertEquals(r1.results.length, 1);
  const s1 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s1.seqNo, 1);
  assertEquals(s1.heads, [h1]);

  // build second change on top of first
  let d2 = Automerge.change(d1, (doc: any) => {
    doc.value.count = 2;
  });
  const c2 = Automerge.getLastLocalChange(d2)!;
  const h2 = decodeChangeHeader(c2).changeHash;

  // submit second change with base=heads from s1
  const r2 = await space.submitTx({
    reads: [],
    writes: [
      {
        ref: { docId, branch },
        baseHeads: s1.heads,
        changes: [{ bytes: c2 }],
      },
    ],
  });
  assertEquals(r2.results.length, 1);

  const s2 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s2.seqNo, 2);
  assertEquals(s2.heads, [h2]);
});
