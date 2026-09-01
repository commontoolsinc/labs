import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isReference,
  normalizeLLMFriendlyRef,
  validateEmbeddedSpaces,
} from "../lib/llm-friendly-ref.ts";

// The 43-character id length matches the entity ids the runtime mints, and
// clears the runner parser's handle-length threshold.
const ID = "baedreiabcdefghijklmnopqrstuvwxyz0123456789";
const HANDLE = `of:fid1:${ID}`;
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

/** A resolver that fails the test if a DID-spelled space reaches it. */
const resolveName = (name: string) =>
  Promise.resolve(name === "my-space" ? DID : OTHER_DID);

describe("llm-friendly-ref", () => {
  it("returns undefined for references outside the reference form", () => {
    expect(normalizeLLMFriendlyRef("piece1")).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1@user")).toBeUndefined();
    expect(normalizeLLMFriendlyRef(HANDLE)).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1/path/to/field")).toBeUndefined();
  });

  it("reads the rooting as what makes a token a reference", () => {
    expect(isReference("/tracker")).toBe(true);
    expect(isReference(`  /${HANDLE}  `)).toBe(true);
    expect(isReference("tracker")).toBe(false);
    expect(isReference("items/0/title")).toBe(false);
  });

  it("normalizes an id-only reference to the bare handle", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}`)).toEqual({
      pieceId: HANDLE,
      path: [],
    });
  });

  it("names the piece by slug where a handle is accepted", () => {
    expect(normalizeLLMFriendlyRef("/tracker")).toEqual({
      pieceId: "tracker",
      path: [],
    });
    expect(normalizeLLMFriendlyRef("/tracker/items/0/title")).toEqual({
      pieceId: "tracker",
      path: ["items", 0, "title"],
    });
    expect(normalizeLLMFriendlyRef("/tracker@session/draft")).toEqual({
      pieceId: "tracker",
      scope: "session",
      path: ["draft"],
    });
  });

  it("names the space by name where a DID is accepted", () => {
    expect(normalizeLLMFriendlyRef("/@my-space/tracker/items")).toEqual({
      pieceId: "tracker",
      embeddedSpace: "my-space",
      path: ["items"],
    });
  });

  it("settles two space names against each other at parse time", () => {
    // Same name, same space: nothing is left for the session to check.
    expect(
      normalizeLLMFriendlyRef("/@my-space/tracker", { space: "my-space" }),
    ).toEqual({ pieceId: "tracker", path: [] });
    expect(() =>
      normalizeLLMFriendlyRef("/@my-space/tracker", { space: "other-space" })
    ).toThrow(
      `Reference names space "my-space" but the command targets ` +
        `space "other-space".`,
    );
  });

  it("defers a space name against a DID target space", () => {
    // Only a derivation can compare the two spellings, and that needs the
    // session the target space is resolved by.
    expect(
      normalizeLLMFriendlyRef("/@my-space/tracker", { space: DID }),
    ).toEqual({
      pieceId: "tracker",
      embeddedSpace: "my-space",
      path: [],
    });
  });

  it("refuses a piece segment that is neither a handle nor a slug", () => {
    expect(() => normalizeLLMFriendlyRef("/of:short")).toThrow(
      `"of:short" is neither a piece handle (of:fid1:...) nor a slug.`,
    );
    expect(() => normalizeLLMFriendlyRef("/Tracker")).toThrow(
      /is not a slug/,
    );
    expect(() => normalizeLLMFriendlyRef("/my--tracker")).toThrow(
      /is not a slug/,
    );
  });

  it("converts embedded path segments the way a positional path is", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/items/0/title`)).toEqual({
      pieceId: HANDLE,
      path: ["items", 0, "title"],
    });
  });

  it("converts only canonical array-index segments to numbers", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/items/0/10/01/007`)).toEqual({
      pieceId: HANDLE,
      path: ["items", 0, 10, "01", "007"],
    });
  });

  it("keeps canonical segments beyond the array-index range as strings", () => {
    expect(
      normalizeLLMFriendlyRef(
        `/${HANDLE}/items/4294967294/4294967295/9007199254740993`,
      ),
    ).toEqual({
      pieceId: HANDLE,
      path: ["items", 4294967294, "4294967295", "9007199254740993"],
    });
  });

  it("parses a scope suffix on the id segment", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}@session/draft`)).toEqual({
      pieceId: HANDLE,
      scope: "session",
      path: ["draft"],
    });
  });

  it("rejects an invalid scope suffix", () => {
    expect(() => normalizeLLMFriendlyRef(`/${HANDLE}@bogus`)).toThrow(
      /Invalid scope suffix/,
    );
  });

  it("accepts an embedded space DID that matches the target space", () => {
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}/value`, { space: DID }),
    ).toEqual({
      pieceId: HANDLE,
      path: ["value"],
    });
  });

  it("rejects an embedded DID that differs from a DID target space", () => {
    expect(() =>
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}`, { space: OTHER_DID })
    ).toThrow(
      `Reference names space "${DID}" but the command targets ` +
        `space "${OTHER_DID}".`,
    );
  });

  it("defers an embedded DID when the target space is a name", () => {
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}/value`, {
        space: "my-space",
      }),
    ).toEqual({
      pieceId: HANDLE,
      embeddedSpace: DID,
      path: ["value"],
    });
  });

  it("passes a deferred embedded DID that matches the resolved space", async () => {
    // A DID is already what the comparison is in, so the resolver — which
    // would answer with the wrong space here — is never reached for one.
    const refuse = () => Promise.reject(new Error("resolved a DID"));
    await validateEmbeddedSpaces([DID], DID, refuse);
    await validateEmbeddedSpaces(undefined, DID, refuse);
  });

  it("rejects a deferred embedded DID against another resolved space", () => {
    return expect(validateEmbeddedSpaces([DID], OTHER_DID, resolveName))
      .rejects.toThrow(
        `Reference names space "${DID}" but the command targets ` +
          `space "${OTHER_DID}".`,
      );
  });

  it("holds a deferred space name to the DID it derives to", async () => {
    await validateEmbeddedSpaces(["my-space"], DID, resolveName);
    await expect(
      validateEmbeddedSpaces(["their-space"], DID, resolveName),
    ).rejects.toThrow(
      `Reference names space "their-space" but the command targets ` +
        `space "${DID}".`,
    );
  });

  it('reads a trailing "#argument" as the arguments-cell selection', () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}#argument`)).toEqual({
      pieceId: HANDLE,
      input: true,
      path: [],
    });
    // The suffix closes the whole reference: scope, space, and an embedded
    // path all sit before it.
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}@user/draft#argument`, {
        space: "my-space",
      }),
    ).toEqual({
      pieceId: HANDLE,
      scope: "user",
      embeddedSpace: DID,
      input: true,
      path: ["draft"],
    });
  });

  it("rejects any fragment other than #argument", () => {
    expect(() => normalizeLLMFriendlyRef(`/${HANDLE}#result`)).toThrow(
      /Unknown reference suffix "#result"/,
    );
    // "#" is reserved for the suffix, so a path key containing it is not an
    // embedded-path spelling.
    expect(() => normalizeLLMFriendlyRef(`/${HANDLE}/we#ird`)).toThrow(
      /Unknown reference suffix/,
    );
  });
});
