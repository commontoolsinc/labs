import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("reject change with missing dependency", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // prepare a change that depends on a fake head
  const d0 = Automerge.init();
  const d1 = Automerge.change(d0, (doc: any) => {
    doc.value = { n: 1 };
  });
  const c1 = Automerge.getLastLocalChange(d1)!;

  // Tamper: we cannot modify deps in change bytes easily; instead simulate by
  // submitting against baseHeads that include a non-existent dep which the server checks against current heads.
  const missingDep = "0123456789abcdef";

  const receipt = await space.submitTx({
    reads: [],
    writes: [
      {
        ref: { docId, branch },
        baseHeads: [missingDep], // mismatch with current heads [] → conflict
        changes: [{ bytes: c1 }],
      },
    ],
  });

  assertEquals(receipt.results[0]?.status, "conflict");
  const state = await space.getOrCreateBranch(docId, branch);
  assertEquals(state.heads, []);
  assertEquals(state.seqNo, 0);
});
