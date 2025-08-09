import { assertEquals } from "@std/assert";
import * as Automerge from "npm:@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test({ name: "single-writer hammer: 100 concurrent tx", permissions: { read: true, write: true, env: true, net: true } }, async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  Deno.env.set("SPACES_DIR", spacesDir.toString());
  Deno.env.set("ENABLE_NEW_STORAGE", "1");

  const spaceDid = "did:key:hammer-test";
  const space = await openSpaceStorage(spaceDid, { spacesDir });

  const docId = "doc:hammer"; const branch = "main";
  await space.getOrCreateBranch(docId, branch);

  // Prepare 100 independent changes that all base on [] and allow server merge = true to avoid artificial conflicts
  const changes: Uint8Array[] = [];
  for (let i = 0; i < 100; i++) {
    const d = Automerge.change(Automerge.init<any>(), (x) => { x[i] = i; });
    changes.push(Automerge.getLastLocalChange(d)!);
  }

  // Fire 100 submits concurrently
  const results = await Promise.allSettled(changes.map((c) =>
    space.submitTx({ reads: [], writes: [{ ref: { docId, branch }, baseHeads: [], changes: [{ bytes: c }], allowServerMerge: true }] })
  ));

  // Ensure all settled and at least some succeeded; none should deadlock
  const rejections = results.filter((r) => r.status === "rejected");
  if (rejections.length > 0) {
    console.error("rejections", rejections);
  }
  assertEquals(rejections.length, 0);
});

