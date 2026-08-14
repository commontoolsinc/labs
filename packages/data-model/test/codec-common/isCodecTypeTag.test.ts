import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isCodecTypeTag } from "@/codec-common/isCodecTypeTag.ts";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

describe("isCodecTypeTag", () => {
  it("returns `true` for every tag in `CODEC_TYPE_TAGS`", () => {
    // The constants are the definition of the syntax, so a predicate that
    // rejected one of them would be wrong whatever it said about anything
    // else.
    for (const tag of Object.values(CODEC_TYPE_TAGS)) {
      expect(isCodecTypeTag(tag)).toBe(true);
    }
  });

  it("returns `false` for every tag in `CODEC_META_TAGS`", () => {
    // A meta-tag is a structural marker its format handles itself, and is
    // outside this syntax by design.
    for (const tag of Object.values(CODEC_META_TAGS)) {
      expect(isCodecTypeTag(tag)).toBe(false);
    }
  });

  it("returns `true` for a tag naming a type nothing here defines", () => {
    // Syntax, not recognition: this is what an `UnknownValue` is made of.
    expect(isCodecTypeTag("FutureType@2")).toBe(true);
    expect(isCodecTypeTag("X@1")).toBe(true);
    expect(isCodecTypeTag("Abc123@1234")).toBe(true);
  });

  it("returns `false` for a string with no version", () => {
    expect(isCodecTypeTag("")).toBe(false);
    expect(isCodecTypeTag("Bytes")).toBe(false);
    expect(isCodecTypeTag("Bytes@")).toBe(false);
  });

  it("returns `false` for a malformed version", () => {
    expect(isCodecTypeTag("Bytes@0")).toBe(false);
    expect(isCodecTypeTag("Bytes@01")).toBe(false);
    expect(isCodecTypeTag("Bytes@-1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1.0")).toBe(false);
    expect(isCodecTypeTag("Bytes@1@2")).toBe(false);
  });

  it("returns `false` for a malformed name", () => {
    expect(isCodecTypeTag("@1")).toBe(false);
    expect(isCodecTypeTag("1Bytes@1")).toBe(false);
    expect(isCodecTypeTag("By tes@1")).toBe(false);
    expect(isCodecTypeTag("By-tes@1")).toBe(false);
    expect(isCodecTypeTag("/Bytes@1")).toBe(false);
  });

  it("returns `false` for a string that only contains a tag", () => {
    // Anchored at both ends, so neither a prefix nor a suffix sneaks a tag
    // past a check made on data off a channel.
    expect(isCodecTypeTag(" Bytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1 ")).toBe(false);
    expect(isCodecTypeTag("x\nBytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1\nx")).toBe(false);
  });

  it("returns `false` for a value that is not a string", () => {
    expect(isCodecTypeTag(undefined)).toBe(false);
    expect(isCodecTypeTag(null)).toBe(false);
    expect(isCodecTypeTag(42)).toBe(false);
    expect(isCodecTypeTag(Symbol("Bytes@1"))).toBe(false);
    expect(isCodecTypeTag(["Bytes@1"])).toBe(false);
    expect(isCodecTypeTag(new String("Bytes@1"))).toBe(false);
  });
});
