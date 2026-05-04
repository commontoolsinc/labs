import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { utf8Compare, utf8SortedKeysOf } from "@commonfabric/utils/utf8";

describe("utf8Compare", () => {
  it("returns `0` for two equal UTF-8 strings", () => {
    expect(utf8Compare("abc", "abc")).toBe(0);
  });

  it("returns a negative number if `first < second`", () => {
    expect(utf8Compare("abc", "def")).toBeLessThan(0);
  });

  it("returns a positive number if `first > second`", () => {
    expect(utf8Compare("def", "abc")).toBeGreaterThan(0);
  });

  it("returns a negative number if `first` is a prefix of `second`", () => {
    expect(utf8Compare("abc", "abcd")).toBeLessThan(0);
  });

  it("returns a positive number if `second` is a prefix of `first`", () => {
    expect(utf8Compare("abcd", "abc")).toBeGreaterThan(0);
  });

  describe("strings with astral-plane characters", () => {
    it("returns `0` for two equal astral-plane characters", () => {
      expect(utf8Compare("😊", "😊")).toBe(0);
    });

    it("returns a negative number if `first < second`", () => {
      expect(utf8Compare("😊", "😎")).toBeLessThan(0);
    });

    it("returns a positive number if `first > second`", () => {
      expect(utf8Compare("😎", "😊")).toBeGreaterThan(0);
    });

    it("returns `0` for two equal multi-character strings with astral-plane characters", () => {
      expect(utf8Compare("happy 😊😊 folks", "happy 😊😊 folks")).toBe(0);
    });

    it("returns a negative number if `first < second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(utf8Compare("What 😊 is a biscuit?", "What 😊 is a muffin?"))
        .toBeLessThan(0);
    });

    it("returns a positive number if `first > second` for multi-character strings with _same_ astral-plane characters", () => {
      expect(utf8Compare("What 😊 is a muffin?", "What 😊 is a biscuit?"))
        .toBeGreaterThan(0);
    });

    it("sorts astral plane characters after non-astral-plane characters", () => {
      const firstAstral = String.fromCodePoint(0x10000);

      expect(utf8Compare("\x00", firstAstral)).toBeLessThan(0);
      expect(utf8Compare("\uffff", firstAstral)).toBeLessThan(0);
      expect(utf8Compare(firstAstral, "\x00")).toBeGreaterThan(0);
      expect(utf8Compare(firstAstral, "\uffff")).toBeGreaterThan(0);

      for (let ch = 123; ch < 0xffff; ch += 876) {
        const str = String.fromCharCode(ch);
        expect(utf8Compare(str, firstAstral)).toBeLessThan(0);
        expect(utf8Compare(firstAstral, str)).toBeGreaterThan(0);
      }
    });
  });
});

describe("utf8SortedKeysOf", () => {
  it("returns a sorted array of keys for an object", () => {
    const obj = { b: 2, a: 1, c: 3 };
    const sorted = utf8SortedKeysOf(obj);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("returns a frozen value", () => {
    const obj = { beep: "x", bop: "y", awOOOOga: "z" };
    const sorted = utf8SortedKeysOf(obj);
    expect(Object.isFrozen(sorted)).toBe(true);
  });

  it("returns the same (`===`) value on two different calls, given the same frozen object", () => {
    const obj = Object.freeze({
      "what": [],
      "a": [1, 2, 3],
      "feeling": [4],
      "to": -99,
      "be": null,
      "alive": true,
    });
    const sorted1 = utf8SortedKeysOf(obj);
    const sorted2 = utf8SortedKeysOf(obj);
    expect(sorted1).toBe(sorted2);
  });
});
