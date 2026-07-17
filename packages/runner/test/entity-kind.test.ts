import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  COMPUTED_URI_SCHEME,
  ENTITY_URI_SCHEMES,
  entityKindOfIdString,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  isEntityKind,
  stripEntityUriScheme,
  uriSchemeForEntityKind,
} from "../src/entity-kind.ts";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";

describe("entity-kind", () => {
  const base = hashOf({ probe: "entity-kind" });

  it("maps kinds to URI schemes, no kind to plain of:", () => {
    expect(uriSchemeForEntityKind(undefined)).toBe("of");
    expect(uriSchemeForEntityKind("computed")).toBe(COMPUTED_URI_SCHEME);
    expect(COMPUTED_URI_SCHEME).toBe("computed");
  });

  it("keeps the kind out of the FabricHash tag (scheme rides the URI)", () => {
    // The kinded URI form wraps a plain fid1 tagged hash; parsing the hash
    // portion is unchanged.
    const uri = `${COMPUTED_URI_SCHEME}:${base.toString()}`;
    const parsed = FabricHash.fromString(
      uri.slice(`${COMPUTED_URI_SCHEME}:`.length),
    );
    expect(parsed.tag).toBe("fid1");
    expect(parsed.hashString).toBe(base.hashString);
  });

  it("parses the kind from a computed: id string", () => {
    expect(entityKindOfIdString(`computed:${base.toString()}`)).toBe(
      "computed",
    );
  });

  it("treats of:, bare, data:, and colon-free ids as unkinded", () => {
    expect(entityKindOfIdString(`of:${base.toString()}`)).toBeUndefined();
    expect(entityKindOfIdString(base.toString())).toBeUndefined();
    expect(entityKindOfIdString("data:application/json,{}")).toBeUndefined();
    expect(entityKindOfIdString("no-colon")).toBeUndefined();
  });

  it("treats unknown schemes as unkinded (strict/authoritative)", () => {
    // An unknown scheme must never read as a relaxed kind: old servers seeing
    // a future scheme fall back to strict conflict semantics.
    expect(entityKindOfIdString(`future:${base.toString()}`)).toBeUndefined();
    expect(entityKindOfIdString(`fid2:computed:${base.hashString}`))
      .toBeUndefined();
  });

  it("recognizes only known kinds", () => {
    expect(isEntityKind("computed")).toBe(true);
    expect(isEntityKind("state")).toBe(false);
    expect(isEntityKind(undefined)).toBe(false);
  });

  it("recognizes exactly the canonical entity URI scheme prefixes", () => {
    expect(entityUriSchemePrefix("of:fid1:abc")).toBe("of:");
    expect(entityUriSchemePrefix("computed:fid1:abc")).toBe("computed:");
    expect(entityUriSchemePrefix("fid1:abc")).toBeUndefined();
    expect(entityUriSchemePrefix("data:application/json,{}"))
      .toBeUndefined();
    expect(entityUriSchemePrefix("did:key:z6Mk")).toBeUndefined();
    expect(entityUriSchemePrefix("")).toBeUndefined();

    for (const scheme of ENTITY_URI_SCHEMES) {
      expect(entityUriSchemePrefix(`${scheme}:fid1:x`)).toBe(`${scheme}:`);
    }
  });

  it("detects canonical entity URI schemes", () => {
    expect(hasEntityUriScheme("of:fid1:abc")).toBe(true);
    expect(hasEntityUriScheme("computed:fid1:abc")).toBe(true);
    expect(hasEntityUriScheme("fid1:abc")).toBe(false);
    expect(hasEntityUriScheme("future:fid1:abc")).toBe(false);
  });

  it("strips canonical entity URI schemes and only those", () => {
    expect(stripEntityUriScheme("of:fid1:abc")).toBe("fid1:abc");
    expect(stripEntityUriScheme("computed:fid1:abc")).toBe("fid1:abc");
    expect(stripEntityUriScheme("fid1:abc")).toBe("fid1:abc");
    expect(stripEntityUriScheme("future:fid1:abc")).toBe(
      "future:fid1:abc",
    );
  });
});
