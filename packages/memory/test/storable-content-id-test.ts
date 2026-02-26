import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertThrows,
} from "@std/assert";
import * as Reference from "merkle-reference";
import { StorableContentId } from "../storable-content-id.ts";
import {
  contentIdFromJSON,
  fromString,
  isContentId,
  refer,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "../reference.ts";

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

  // -----------------------------------------------------------------
  // Part B: flag-conditional dispatch
  // -----------------------------------------------------------------

  await t.step(
    "contentIdFromJSON round-trips through StorableContentId when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        const original = new StorableContentId(SAMPLE_HASH, "fid1");
        const json = original.toJSON();
        const reconstructed = contentIdFromJSON(json);

        // The reconstructed value should be a StorableContentId.
        assertInstanceOf(reconstructed, StorableContentId);
        const cid = reconstructed as unknown as StorableContentId;
        assertEquals(cid.toString(), original.toString());
        assertEquals(cid.hash, original.hash);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "fromString round-trips through StorableContentId when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        const original = new StorableContentId(SAMPLE_HASH, "fid1");
        const str = original.toString();
        const reconstructed = fromString(str);

        assertInstanceOf(reconstructed, StorableContentId);
        const cid = reconstructed as unknown as StorableContentId;
        assertEquals(cid.toString(), original.toString());
        assertEquals(cid.hash, original.hash);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "fromString throws on invalid format (no colon) when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        assertThrows(
          () => fromString("nocolonhere"),
          ReferenceError,
          "Invalid content ID string",
        );
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "isContentId returns true for StorableContentId instances",
    () => {
      const cid = new StorableContentId(SAMPLE_HASH, "fid1");
      assert(isContentId(cid));
    },
  );

  await t.step(
    "isContentId returns true for Reference.View instances",
    () => {
      const ref = refer({ hello: "world" });
      // With canonical hashing off (default), refer() returns a Reference.View.
      assert(Reference.is(ref));
      assert(isContentId(ref));
    },
  );

  await t.step(
    "refer() returns StorableContentId when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        const result = refer({ hello: "world" });
        assertInstanceOf(result, StorableContentId);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "nested refer() works when canonical hashing is on (no throw on StorableContentId in value tree)",
    () => {
      setCanonicalHashConfig(true);
      try {
        // First refer produces a StorableContentId.
        const innerRef = refer({ the: "text/plain", of: "entity:123" });
        assertInstanceOf(innerRef, StorableContentId);

        // Wrap it in a fact-like structure and refer again. canonicalHash
        // handles StorableContentId via TAG_CONTENT_ID, so this must not throw.
        const outerSource = {
          cause: innerRef,
          the: "text/plain",
          of: "entity:456",
          is: { value: 42 },
        };
        const outerRef = refer(outerSource);
        assertInstanceOf(outerRef, StorableContentId);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "refer() returns Reference.View when canonical hashing is off",
    () => {
      // Default state: canonical hashing off.
      const result = refer({ test: true });
      assert(Reference.is(result), "Expected a Reference.View instance");
      assert(
        !(result instanceof StorableContentId),
        "Should not be StorableContentId when flag is off",
      );
    },
  );
});
