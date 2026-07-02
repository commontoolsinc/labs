import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import {
  entityKindOfIdString,
  entityKindOfTag,
  getComputedCellIdsConfig,
  isEntityKind,
  resetComputedCellIdsConfig,
  setComputedCellIdsConfig,
  withEntityKind,
} from "@/fabric-primitives/entity-kind.ts";
import { hashOf } from "@/value-hash.ts";

describe("entity-kind", () => {
  const base = hashOf({ probe: "entity-kind" });

  it("versions the tag to fid2:<kind> with the same bytes", () => {
    const kinded = withEntityKind(base, "computed");
    expect(kinded.tag).toBe("fid2:computed");
    expect(kinded.hashString).toBe(base.hashString);
    expect(kinded.taggedHashString).toBe(`fid2:computed:${base.hashString}`);
  });

  it("round-trips a kind-tagged hash through the string form", () => {
    const kinded = withEntityKind(base, "computed");
    const parsed = FabricHash.fromString(kinded.toString());
    expect(parsed.tag).toBe("fid2:computed");
    expect(parsed.hashString).toBe(base.hashString);
    expect(parsed.toString()).toBe(kinded.toString());
  });

  it("keeps kind-tagged and untagged forms distinct identities", () => {
    const kinded = withEntityKind(base, "computed");
    expect(kinded.toString()).not.toBe(base.toString());
  });

  it("refuses to mint a kind twice or onto non-fid1 tags", () => {
    const kinded = withEntityKind(base, "computed");
    expect(() => withEntityKind(kinded, "computed")).toThrow(
      /kinds are minted once/,
    );
    expect(() =>
      withEntityKind(new FabricHash(base.bytes, "legacy"), "computed")
    )
      .toThrow(/kinds are minted once/);
  });

  it("parses kinds from tags, treating unknown kinds as absent", () => {
    expect(entityKindOfTag("fid2:computed")).toBe("computed");
    expect(entityKindOfTag("fid1")).toBeUndefined();
    expect(entityKindOfTag("legacy")).toBeUndefined();
    // Unknown kind suffixes must read as strict/authoritative.
    expect(entityKindOfTag("fid2:future")).toBeUndefined();
  });

  it("parses kinds from id strings and of: URIs", () => {
    const kinded = withEntityKind(base, "computed");
    expect(entityKindOfIdString(kinded.toString())).toBe("computed");
    expect(entityKindOfIdString(`of:${kinded.toString()}`)).toBe("computed");
    expect(entityKindOfIdString(base.toString())).toBeUndefined();
    expect(entityKindOfIdString(`of:${base.toString()}`)).toBeUndefined();
    expect(entityKindOfIdString("data:application/json,{}")).toBeUndefined();
    expect(entityKindOfIdString("no-colon")).toBeUndefined();
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
