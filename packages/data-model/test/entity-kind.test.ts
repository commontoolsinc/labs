import { assertEquals } from "@std/assert";
import {
  ENTITY_URI_SCHEMES,
  entityKindOfIdString,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  stripEntityUriScheme,
} from "../src/fabric-primitives/entity-kind.ts";

Deno.test("entityUriSchemePrefix recognizes exactly the canonical scheme set", () => {
  assertEquals(entityUriSchemePrefix("of:fid1:abc"), "of:");
  assertEquals(entityUriSchemePrefix("computed:fid1:abc"), "computed:");
  // Bare tagged hashes and non-entity URIs carry no entity scheme.
  assertEquals(entityUriSchemePrefix("fid1:abc"), undefined);
  assertEquals(entityUriSchemePrefix("data:application/json,{}"), undefined);
  assertEquals(entityUriSchemePrefix("did:key:z6Mk"), undefined);
  assertEquals(entityUriSchemePrefix(""), undefined);
  // Every scheme in the set round-trips through the prefix helper.
  for (const scheme of ENTITY_URI_SCHEMES) {
    assertEquals(entityUriSchemePrefix(`${scheme}:fid1:x`), `${scheme}:`);
  }
});

Deno.test("hasEntityUriScheme mirrors the prefix helper", () => {
  assertEquals(hasEntityUriScheme("of:fid1:abc"), true);
  assertEquals(hasEntityUriScheme("computed:fid1:abc"), true);
  assertEquals(hasEntityUriScheme("fid1:abc"), false);
  assertEquals(hasEntityUriScheme("future:fid1:abc"), false);
});

Deno.test("stripEntityUriScheme strips any entity scheme and only those", () => {
  assertEquals(stripEntityUriScheme("of:fid1:abc"), "fid1:abc");
  assertEquals(stripEntityUriScheme("computed:fid1:abc"), "fid1:abc");
  // No entity scheme: unchanged — including unknown future-looking schemes,
  // which must stay strict rather than being silently un-prefixed.
  assertEquals(stripEntityUriScheme("fid1:abc"), "fid1:abc");
  assertEquals(stripEntityUriScheme("future:fid1:abc"), "future:fid1:abc");
});

Deno.test("entityKindOfIdString parses the kind from the URI scheme", () => {
  assertEquals(entityKindOfIdString("computed:fid1:abc"), "computed");
  // of:, bare, non-entity, and unknown schemes parse as no kind (strict).
  assertEquals(entityKindOfIdString("of:fid1:abc"), undefined);
  assertEquals(entityKindOfIdString("fid1:abc"), undefined);
  assertEquals(entityKindOfIdString("future:fid1:abc"), undefined);
  assertEquals(entityKindOfIdString("no-colon"), undefined);
});
