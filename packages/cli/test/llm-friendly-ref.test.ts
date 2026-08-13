import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalizeLLMFriendlyRef } from "../lib/llm-friendly-ref.ts";

// The 43-character id length matches the entity ids the runtime mints, and
// clears the runner parser's handle-length threshold.
const ID = "baedreiabcdefghijklmnopqrstuvwxyz0123456789";
const HANDLE = `of:fid1:${ID}`;
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

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

  it("rejects an embedded space DID that names another space", () => {
    expect(() =>
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}`, { space: "other-space" })
    ).toThrow(
      `Reference names space "${DID}" but the command targets ` +
        `space "other-space".`,
    );
  });

  it("surfaces the runner parser's rejection of short ids", () => {
    expect(() => normalizeLLMFriendlyRef("/of:short")).toThrow(
      /must use handles/,
    );
  });
});
