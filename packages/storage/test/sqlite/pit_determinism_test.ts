import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";

Deno.test("PIT determinism: identical bytes for repeated reconstructions", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:pit-determinism", {
    spacesDir,
  });

  const docId = "doc:PIT";
  const branch = "main";
  await space.getOrCreateBranch(docId, branch);

  // Apply a few linear changes
  let d = Automerge.init<any>();
  for (let i = 1; i <= 4; i++) {
    d = Automerge.change(d, (x: any) => {
      x.n = i;
    });
    const c = Automerge.getLastLocalChange(d)!;
    const s = await space.getBranchState(docId, branch);
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: s.heads,
        changes: [{ bytes: c }],
      }],
    });
  }

  const b1 = await space.getDocBytes(docId, branch, { accept: "automerge" });
  const b2 = await space.getDocBytes(docId, branch, { accept: "automerge" });
  assertEquals(b1, b2);
});
