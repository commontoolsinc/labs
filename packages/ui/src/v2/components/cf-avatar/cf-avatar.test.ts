import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFAvatar, initialsForName, isAvatarImageUrl } from "./cf-avatar.ts";

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
    it("treats http(s)/data/blob/root-relative as images", () => {
      expect(isAvatarImageUrl("https://example.com/a.png")).toBe(true);
      expect(isAvatarImageUrl("http://example.com/a.png")).toBe(true);
      expect(isAvatarImageUrl("data:image/png;base64,AAAA")).toBe(true);
      expect(isAvatarImageUrl("blob:abc")).toBe(true);
      expect(isAvatarImageUrl("/avatars/me.png")).toBe(true);
    });

    it("treats glyphs / plain text as non-images", () => {
      expect(isAvatarImageUrl("🦊")).toBe(false);
      expect(isAvatarImageUrl("AB")).toBe(false);
      expect(isAvatarImageUrl("ada")).toBe(false);
      expect(isAvatarImageUrl("")).toBe(false);
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
