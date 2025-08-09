import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("getDocBytes json supports path projection", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  let d = Automerge.init();
  d = Automerge.change(d, (doc: any) => {
    doc.value = { a: 1, b: { c: 2, d: 3 } };
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: [], changes: [ { bytes: c1 } ] } ] });

  const bytes = await space.getDocBytes(docId, branch, { accept: "json", paths: [["value", "b", "c"]] });
  const json = JSON.parse(new TextDecoder().decode(bytes));
  assertEquals(json, { value: { b: { c: 2 } } });
});
