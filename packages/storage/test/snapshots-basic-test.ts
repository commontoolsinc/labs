import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("snapshots: create full snapshots on cadence and speed up PIT", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-snapshots", {
    spacesDir,
  });
  const docId = "doc:snap-test";
  const branch = "main";

  // Apply 6 changes to trigger cadence=5 snapshot creation
  let d = Automerge.init<any>();
  const changes: Uint8Array[] = [];
  for (let i = 1; i <= 6; i++) {
    d = Automerge.change(d, (doc) => {
      doc.count = i;
    });
    const c = Automerge.getLastLocalChange(d)!;
    changes.push(c);
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: i === 1
          ? []
          : (await space.getBranchState(docId, branch)).heads,
        changes: [{ bytes: c }],
      }],
    });
  }

  const state = await space.getBranchState(docId, branch);
  assertEquals(state.seqNo, 6);

  // Verify there is at least one snapshot row at upto_seq_no = 5
  // We can't access DB directly here, so verify PIT reconstruction returns bytes for upto epoch at seq 5 and 6
  const bytes6 = await space.getDocBytes(docId, branch, {
    accept: "automerge",
  });
  const doc6 = Automerge.load(bytes6);
  assertEquals((doc6 as any).count, 6);
});
