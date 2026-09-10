import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";

import {
  COMPUTED_URI_SCHEME,
  ENTITY_URI_SCHEMES,
  entityKindOfIdString,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  hashStringForEntityAddress,
  idStringForEntityAddress,
  isEntityKind,
  stripEntityUriScheme,
  uriSchemeForEntityKind,
} from "../src/entity-kind.ts";
import { toURI } from "../src/uri-utils.ts";

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

  it("keeps every entity URI scheme within RFC 3986 scheme syntax", () => {
    // RFC 3986 section 3.1 admits a letter followed by any number of
    // letters, digits, `+`, `-`, and `.`, and makes lowercase the canonical
    // form. Iterating `ENTITY_URI_SCHEMES` settles the claim rather than
    // sampling it, because that constant is the set `entityUriSchemePrefix`
    // matches an id against.
    expect(ENTITY_URI_SCHEMES.length).toBeGreaterThan(0);
    for (const scheme of ENTITY_URI_SCHEMES) {
      expect(scheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
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

  describe("hashStringForEntityAddress()", () => {
    it("returns the same hash string for a bare hash and its `of:` URI", () => {
      expect(hashStringForEntityAddress("fid1:abc")).toBe("fid1:abc");
      expect(hashStringForEntityAddress("of:fid1:abc")).toBe("fid1:abc");
    });

    it("throws for a `computed:` id, naming the address", () => {
      expect(() => hashStringForEntityAddress("computed:fid1:abc")).toThrow(
        "Kinded entity id `computed:fid1:abc`",
      );
    });

    it("throws for every kinded entity URI scheme", () => {
      // Driven by the scheme list so a kind added there is refused without a
      // further edit here.
      for (const scheme of ENTITY_URI_SCHEMES) {
        if (scheme === "of") continue;
        expect(() => hashStringForEntityAddress(`${scheme}:fid1:abc`)).toThrow(
          `\`${scheme}:fid1:abc\``,
        );
      }
    });

    it("returns a string carrying no entity scheme unchanged", () => {
      expect(hashStringForEntityAddress("my-board")).toBe("my-board");
      expect(hashStringForEntityAddress("data:application/json,{}")).toBe(
        "data:application/json,{}",
      );
      expect(hashStringForEntityAddress("future:fid1:abc")).toBe(
        "future:fid1:abc",
      );
      expect(hashStringForEntityAddress("")).toBe("");
    });
  });

  describe("idStringForEntityAddress()", () => {
    it("returns the same id string for a bare hash and its `of:` URI", () => {
      expect(idStringForEntityAddress("fid1:abc")).toBe("of:fid1:abc");
      expect(idStringForEntityAddress("of:fid1:abc")).toBe("of:fid1:abc");
    });

    it("returns a kinded id unchanged", () => {
      expect(idStringForEntityAddress("computed:fid1:abc")).toBe(
        "computed:fid1:abc",
      );
    });

    it("returns an id under every entity URI scheme unchanged", () => {
      // Driven by the scheme list so a kind added there is left alone without
      // a further edit here. An id already carrying one of these schemes is
      // already an id, and scheming it again would name nothing.
      for (const scheme of ENTITY_URI_SCHEMES) {
        expect(idStringForEntityAddress(`${scheme}:fid1:abc`)).toBe(
          `${scheme}:fid1:abc`,
        );
      }
    });

    it("returns an id in another subject's scheme unchanged", () => {
      // The schemes this module knows are the entity kinds, and they are not
      // every scheme an id can carry. A `cid:` schema document and a `data:`
      // URI are ids in their own right, so scheming one builds a different id
      // that nothing holds — and a lookup then reports a document that is
      // there as absent, which is what `packages/fuse` reads entity directory
      // names into.

      expect(idStringForEntityAddress("cid:fid1:abc")).toBe("cid:fid1:abc");
      expect(idStringForEntityAddress("data:application/json,{}")).toBe(
        "data:application/json,{}",
      );
      expect(idStringForEntityAddress("did:key:z6MkExample")).toBe(
        "did:key:z6MkExample",
      );
      expect(idStringForEntityAddress("future:fid1:abc")).toBe(
        "future:fid1:abc",
      );
    });

    it("returns a string that is no address at all unchanged", () => {
      expect(idStringForEntityAddress("my-board")).toBe("my-board");
      expect(idStringForEntityAddress("")).toBe("");
    });

    it("schemes exactly what `FabricHash` reads back as a bare tagged hash", () => {
      // The rule is written here as a shape and owned there as a parser, so
      // this is what stops the two drifting: for each address, what this
      // schemes and what that parser calls a bare tagged hash agree. A hash
      // reads back as itself, and everything the parser refuses or would
      // respell — a second colon, a padded or non-base64url payload — is left
      // as it stands.
      //
      // The table exhibits the forms in circulation rather than closing the
      // set: it says the two agree on these, not on every string. What it
      // does close is that a change to either side has to move both.

      const addresses = [
        base.toString(),
        `of:${base.toString()}`,
        `computed:${base.toString()}`,
        `cid:${base.toString()}`,
        "data:application/json,{}",
        "did:key:z6MkExample",
        "fid1:abc",
        "fid1:AA==",
        "fid1:a b",
        "fid1:",
        "unminted-tag:abc",
        "my-board",
        "",
      ];
      for (const address of addresses) {
        let bare: boolean;
        try {
          bare = FabricHash.fromString(address).taggedHashString === address;
        } catch {
          bare = false;
        }
        expect({ address, id: idStringForEntityAddress(address) }).toEqual({
          address,
          id: bare ? `of:${address}` : address,
        });
      }
    });

    it("returns the id `toURI()` builds from the same address", () => {
      // The two agree on the spelling a document is stored under, which is
      // what makes a lookup keyed on that id answer about the entity a read
      // through `entityIdFrom()` would reach.
      const address = base.toString();
      expect(idStringForEntityAddress(address)).toBe(toURI(base));
      expect(idStringForEntityAddress(`of:${address}`)).toBe(toURI(base));
    });
  });
});
