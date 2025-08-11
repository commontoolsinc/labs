import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";

Deno.test("server merge actor policy: enforced when ENV flag set", async () => {
  Deno.env.set("ENABLE_SERVER_MERGE", "1");
  Deno.env.set("ENFORCE_SERVER_MERGE_ACTOR", "1");
  try {
    const tmpDir = await Deno.makeTempDir();
    const spacesDir = new URL(`file://${tmpDir}/`);
    const space = await openSpaceStorage("did:key:merge-actor", { spacesDir });

    const docId = "doc:M";
    const branch = "main";
    await space.getOrCreateBranch(docId, branch);

    // Create two heads on main
    let d = Automerge.init<any>();
    d = Automerge.change(d, (x: any) => (x.a = 1));
    const c1 = Automerge.getLastLocalChange(d)!;
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: [],
        changes: [{ bytes: c1 }],
      }],
    });
    let e = Automerge.init<any>();
    e = Automerge.change(e, (x: any) => (x.b = 2));
    const c2 = Automerge.getLastLocalChange(e)!;
    const s1 = await space.getBranchState(docId, branch);
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch },
        baseHeads: s1.heads,
        changes: [{ bytes: c2 }],
      }],
    });

    // Attempt server-merge via mismatch baseHeads; should fail if actor policy rejects synthesized actor
    const r = await space.submitTx({
      reads: [],
      writes: [{ ref: { docId, branch }, baseHeads: [], changes: [] }],
    });
    assertEquals(r.results[0]?.status, "conflict");
  } finally {
    // Reset flag for other tests
    Deno.env.set("ENFORCE_SERVER_MERGE_ACTOR", "0");
  }
});
