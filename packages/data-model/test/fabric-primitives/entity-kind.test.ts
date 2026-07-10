import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import {
  COMPUTED_URI_SCHEME,
  entityKindOfIdString,
  getComputedCellIdsConfig,
  isEntityKind,
  resetComputedCellIdsConfig,
  setComputedCellIdsConfig,
  uriSchemeForEntityKind,
} from "@/fabric-primitives/entity-kind.ts";
import { hashOf } from "@/value-hash.ts";

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

  it("exposes the ambient minting flag with a false default", () => {
    expect(getComputedCellIdsConfig()).toBe(false);
    setComputedCellIdsConfig(true);
    expect(getComputedCellIdsConfig()).toBe(true);
    resetComputedCellIdsConfig();
    expect(getComputedCellIdsConfig()).toBe(false);
  });
});
