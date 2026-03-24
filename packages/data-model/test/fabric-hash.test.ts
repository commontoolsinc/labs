import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertThrows,
} from "@std/assert";
import * as Reference from "merkle-reference";
import { FabricHash } from "../fabric-hash.ts";
import {
  fromString,
  hashObjectFromJson,
  hashOf,
  isHashObject,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "../value-hash.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

Deno.test("FabricHash", async (t) => {
  // -----------------------------------------------------------------
  // FabricHash extensions
  // -----------------------------------------------------------------

  await t.step("toString() produces fid1:<base64> format", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const str = cid.toString();
    assert(str.startsWith("fid1:"), `Expected fid1: prefix, got: ${str}`);
  });

  await t.step("toJSON() produces { '/': 'fid1:<base64>' }", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const json = cid.toJSON();
    assertEquals(typeof json["/"], "string");
    assert(
      json["/"].startsWith("fid1:"),
      `Expected fid1: prefix in JSON, got: ${json["/"]}`,
    );
    assertEquals(json["/"], cid.toString());
  });

  await t.step(".bytes returns a defensive copy of .hash", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
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
    const cid = new FabricHash(SAMPLE_HASH, "sha3");
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
      const cid = new FabricHash(SAMPLE_HASH, "test2");
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
    "hashObjectFromJson round-trips through FabricHash when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        const original = new FabricHash(SAMPLE_HASH, "fid1");
        const json = original.toJSON();
        const reconstructed = hashObjectFromJson(json);

        // The reconstructed value should be a FabricHash.
        assertInstanceOf(reconstructed, FabricHash);
        const cid = reconstructed as unknown as FabricHash;
        assertEquals(cid.toString(), original.toString());
        assertEquals(cid.hash, original.hash);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "fromString round-trips through FabricHash when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        // Use a non-fid1 tag to verify the parser doesn't hardcode it.
        const original = new FabricHash(SAMPLE_HASH, "sha3");
        const str = original.toString();
        const reconstructed = fromString(str);

        assertInstanceOf(reconstructed, FabricHash);
        const cid = reconstructed as unknown as FabricHash;
        assertEquals(cid.toString(), original.toString());
        assertEquals(cid.hash, original.hash);
        assertEquals(cid.algorithmTag, "sha3");
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
          "Invalid content hash string",
        );
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "isHashObject returns true for FabricHash instances",
    () => {
      const cid = new FabricHash(SAMPLE_HASH, "fid1");
      assert(isHashObject(cid));
    },
  );

  await t.step(
    "isHashObject returns true for Reference.View instances",
    () => {
      const ref = hashOf({ hello: "world" });
      // With canonical hashing off (default), hashOf() returns a Reference.View.
      assert(Reference.is(ref));
      assert(isHashObject(ref));
    },
  );

  await t.step(
    "hashOf() returns FabricHash when canonical hashing is on",
    () => {
      setCanonicalHashConfig(true);
      try {
        const result = hashOf({ hello: "world" });
        assertInstanceOf(result, FabricHash);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "nested hashOf() works when canonical hashing is on (no throw on FabricHash in value tree)",
    () => {
      setCanonicalHashConfig(true);
      try {
        // First hashOf produces a FabricHash.
        const innerRef = hashOf({ the: "text/plain", of: "entity:123" });
        assertInstanceOf(innerRef, FabricHash);

        // Wrap it in a fact-like structure and hashOf again. hashOfModern
        // handles FabricHash via TAG_CONTENT_ID, so this must not throw.
        const outerSource = {
          cause: innerRef,
          the: "text/plain",
          of: "entity:456",
          is: { value: 42 },
        };
        const outerRef = hashOf(outerSource);
        assertInstanceOf(outerRef, FabricHash);
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );

  await t.step(
    "hashOf() returns Reference.View when canonical hashing is off",
    () => {
      // Explicitly pin canonical hashing off rather than relying on ambient
      // default, so this step exercises the legacy path even if the default
      // changes.
      setCanonicalHashConfig(false);
      try {
        const result = hashOf({ test: true });
        assert(Reference.is(result), "Expected a Reference.View instance");
        assert(
          !(result instanceof FabricHash),
          "Should not be FabricHash when flag is off",
        );
      } finally {
        resetCanonicalHashConfig();
      }
    },
  );
});
