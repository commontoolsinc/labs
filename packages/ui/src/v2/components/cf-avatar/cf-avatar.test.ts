import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFAvatar,
  initialsForName,
  isAvatarImageUrl,
  isRemoteLikeSource,
} from "./index.ts";

describe("CFAvatar", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-avatar")).toBe(CFAvatar);
  });

  it("defaults to a medium circle", () => {
    const el = new CFAvatar();
    expect(el.size).toBe("md");
    expect(el.shape).toBe("circle");
  });

  describe("isAvatarImageUrl", () => {
    it("treats only inline data: URIs as images", () => {
      expect(isAvatarImageUrl("data:image/png;base64,AAAA")).toBe(true);
      expect(isAvatarImageUrl("data:image/svg+xml,<svg></svg>")).toBe(true);
      expect(isAvatarImageUrl("  data:image/png;base64,AAAA  ")).toBe(true);
      expect(isAvatarImageUrl("DATA:image/png;base64,AAAA")).toBe(true);
    });

    it("rejects external/remote sources (no external resources)", () => {
      // Remote URLs must NOT become an <img>; they fall back to glyph/initials.
      expect(isAvatarImageUrl("https://example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("http://example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("//example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("blob:abc")).toBe(false);
      expect(isAvatarImageUrl("/avatars/me.png")).toBe(false);
      expect(isAvatarImageUrl("./me.png")).toBe(false);
      expect(isAvatarImageUrl("ftp://example.com/a.png")).toBe(false);
    });

    it("treats glyphs / plain text / empty as non-images", () => {
      expect(isAvatarImageUrl("🦊")).toBe(false);
      expect(isAvatarImageUrl("AB")).toBe(false);
      expect(isAvatarImageUrl("ada")).toBe(false);
      expect(isAvatarImageUrl("")).toBe(false);
      expect(isAvatarImageUrl("   ")).toBe(false);
    });
  });

  describe("isRemoteLikeSource", () => {
    it("flags URL/path/scheme sources so they degrade to initials, not raw text", () => {
      expect(isRemoteLikeSource("https://example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("http://example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("//example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("/avatars/me.png")).toBe(true);
      expect(isRemoteLikeSource("blob:abc")).toBe(true);
      expect(isRemoteLikeSource("ftp://example.com/a.png")).toBe(true);
    });

    it("does not flag glyphs, initials text, or inline data URIs", () => {
      expect(isRemoteLikeSource("🦊")).toBe(false);
      expect(isRemoteLikeSource("AB")).toBe(false);
      expect(isRemoteLikeSource("ada")).toBe(false);
      expect(isRemoteLikeSource("data:image/png;base64,AAAA")).toBe(false);
      expect(isRemoteLikeSource("")).toBe(false);
    });
  });

  describe("initialsForName", () => {
    it("takes up to two uppercase initials", () => {
      expect(initialsForName("Ada Lovelace")).toBe("AL");
      expect(initialsForName("Alan Mathison Turing")).toBe("AM");
      expect(initialsForName("grace")).toBe("G");
    });

    it("falls back to ? for empty/undefined names", () => {
      expect(initialsForName(undefined)).toBe("?");
      expect(initialsForName("")).toBe("?");
      expect(initialsForName("   ")).toBe("?");
    });
  });
});
