import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { compareUtf8 } from "@commonfabric/utils/utf8";

describe("compareUtf8", () => {
  it("returns `0` for two equal UTF-8 strings", () => {
    expect(compareUtf8("abc", "abc")).toBe(0);
  });

  it("returns a negative number if `first < second`", () => {
    expect(compareUtf8("abc", "def")).toBeLessThan(0);
  });

  it("returns a positive number if `first > second`", () => {
    expect(compareUtf8("def", "abc")).toBeGreaterThan(0);
  });

  it("returns a negative number if `first` is a prefix of `second`", () => {
    expect(compareUtf8("abc", "abcd")).toBeLessThan(0);
  });

  it("returns a positive number if `second` is a prefix of `first`", () => {
    expect(compareUtf8("abcd", "abc")).toBeGreaterThan(0);
  });

  describe("strings with astral-plane characters", () => {
    it("returns `0` for two equal astral-plane characters", () => {
      expect(compareUtf8("😊", "😊")).toBe(0);
    });

    it("returns a negative number if `first < second`", () => {
      expect(compareUtf8("😊", "😎")).toBeLessThan(0);
    });

    it("returns a positive number if `first > second`", () => {
      expect(compareUtf8("😎", "😊")).toBeGreaterThan(0);
    });

    it("returns `0` for two equal multi-character strings with astral-plane characters", () => {
      expect(compareUtf8("happy 😊😊 folks", "happy 😊😊 folks")).toBe(0);
    });

    it("returns a negative number if `first < second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(compareUtf8("What 😊 is a biscuit?", "What 😊 is a muffin?")).toBeLessThan(0);
    });

    it("returns a positive number if `first > second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(compareUtf8("What 😊 is a muffin?", "What 😊 is a biscuit?")).toBeGreaterThan(0);
    });

    it("sorts astral plane characters after non-astral-plane characters", () => {
      const firstAstral = String.fromCodePoint(0x10000);

      expect(compareUtf8("\x00", firstAstral)).toBeLessThan(0);
      expect(compareUtf8("\uffff", firstAstral)).toBeLessThan(0);
      expect(compareUtf8(firstAstral, "\x00")).toBeGreaterThan(0);
      expect(compareUtf8(firstAstral, "\uffff")).toBeGreaterThan(0);

      for (let ch = 123; ch < 0xffff; ch += 876) {
        const str = String.fromCharCode(ch);
        expect(compareUtf8(str, firstAstral)).toBeLessThan(0);
        expect(compareUtf8(firstAstral, str)).toBeGreaterThan(0);
      }
    });
  });
});
