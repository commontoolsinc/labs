import { assertEquals } from "@std/assert";
import { openSpaceStorage } from "../src/provider.ts";
import { Database } from "@db/sqlite";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";

Deno.test("getOrCreateBranch initializes empty heads and zeros", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const state = await space.getOrCreateBranch(docId, "main");

  assertEquals(state.branchId.length > 0, true);
  assertEquals(state.heads, []);
  assertEquals(state.seqNo, 0);
  assertEquals(state.epoch, 0);

  // verify root_hash initialized to referJSON({ heads: [] })
  const dbUrl = new URL(`./did:key:testspace.sqlite`, spacesDir);
  const db = new Database(dbUrl);
  const row = db.prepare(
    `SELECT root_hash FROM am_heads h JOIN branches b ON (h.branch_id=b.branch_id) WHERE b.doc_id = :doc_id AND b.name = :name`,
  ).get({ doc_id: docId, name: "main" }) as { root_hash: Uint8Array };
  const gotHex = [...row.root_hash].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = referJson({ heads: [] });
  const expDigest = new Uint8Array(refToDigest(expected));
  const expHex = [...expDigest].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(gotHex, expHex);
  db.close();
});
