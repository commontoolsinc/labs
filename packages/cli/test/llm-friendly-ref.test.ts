import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  normalizeLLMFriendlyRef,
  validateEmbeddedSpaces,
} from "../lib/llm-friendly-ref.ts";

// The 43-character id length matches the entity ids the runtime mints, and
// clears the runner parser's handle-length threshold.
const ID = "baedreiabcdefghijklmnopqrstuvwxyz0123456789";
const HANDLE = `of:fid1:${ID}`;
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

describe("llm-friendly-ref", () => {
  it("returns undefined for references outside the LLM-friendly form", () => {
    expect(normalizeLLMFriendlyRef("piece1")).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1@user")).toBeUndefined();
    expect(normalizeLLMFriendlyRef(HANDLE)).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1/path/to/field")).toBeUndefined();
  });

  it("normalizes an id-only reference to the bare handle", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}`)).toEqual({
      pieceId: HANDLE,
      path: [],
    });
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

  it("passes a deferred embedded DID that matches the resolved space", () => {
    expect(() => validateEmbeddedSpaces([DID], DID)).not.toThrow();
    expect(() => validateEmbeddedSpaces(undefined, DID)).not.toThrow();
  });

  it("rejects a deferred embedded DID against another resolved space", () => {
    expect(() => validateEmbeddedSpaces([DID], OTHER_DID)).toThrow(
      `Reference names space "${DID}" but the command targets ` +
        `space "${OTHER_DID}".`,
    );
  });

  it("surfaces the runner parser's rejection of short ids", () => {
    expect(() => normalizeLLMFriendlyRef("/of:short")).toThrow(
      /must use handles/,
    );
  });
});
