import { assert, assertEquals } from "@std/assert";
import { StorableContentId } from "../storable-content-id.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

Deno.test("StorableContentId", async (t) => {
  // -----------------------------------------------------------------
  // StorableContentId extensions
  // -----------------------------------------------------------------

  await t.step("toString() produces fid1:<base64> format", () => {
    const cid = new StorableContentId(SAMPLE_HASH, "fid1");
    const str = cid.toString();
    assert(str.startsWith("fid1:"), `Expected fid1: prefix, got: ${str}`);
  });

  await t.step("toJSON() produces { '/': 'fid1:<base64>' }", () => {
    const cid = new StorableContentId(SAMPLE_HASH, "fid1");
    const json = cid.toJSON();
    assertEquals(typeof json["/"], "string");
    assert(
      json["/"].startsWith("fid1:"),
      `Expected fid1: prefix in JSON, got: ${json["/"]}`,
    );
    assertEquals(json["/"], cid.toString());
  });

  await t.step(".bytes returns a defensive copy of .hash", () => {
    const cid = new StorableContentId(SAMPLE_HASH, "fid1");
    const bytes = cid.bytes;
    // Contents match.
    assertEquals(bytes, cid.hash);
    // But it's a copy, not the same reference.
    assert(
      bytes !== cid.hash,
      "Expected .bytes to return a copy, not the same array",
    );
    // Mutating the copy must not affect the original.
    bytes[0] = 0xff;
    assertEquals(cid.hash[0], 0, "Mutating .bytes must not affect .hash");
  });

  await t.step("copyHashInto copies hash bytes into target buffer", () => {
    const cid = new StorableContentId(SAMPLE_HASH, "sha3");
    const target = new Uint8Array(32);
    const returned = cid.copyHashInto(target);
    // Returns the same target buffer.
    assert(returned === target, "Expected copyHashInto to return the target");
    assertEquals(target, cid.hash);
    assertEquals(cid.algorithmTag, "sha3");
  });

  await t.step(
    '["/"] getter returns the raw hash bytes (not a copy)',
    () => {
      const cid = new StorableContentId(SAMPLE_HASH, "test2");
      const slash = cid["/"];
      // Should be the exact same array reference as .hash (not a defensive copy).
      assert(
        slash === cid.hash,
        'Expected ["/"] to return the same array as .hash',
      );
      assertEquals(slash, SAMPLE_HASH);
      assertEquals(cid.algorithmTag, "test2");
    },
  );
});
