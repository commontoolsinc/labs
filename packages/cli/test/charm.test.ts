import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  parseLink,
  parsePieceOptions,
  parseSpaceOptions,
} from "../commands/piece.ts";

const API_URL = "https://ct.dev";
const SPACE = "common-knowledge";
const PIECE = "abcdefghijklmnopqrstuvwxyz";
const ID = "~/.my.key";
const FULL_URL = `${API_URL}/${SPACE}/${PIECE}`;
const NO_PIECE_FULL_URL = `${API_URL}/${SPACE}`;

describe("cli piece parsing", () => {
  it("parseSpaceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    };
    expect(parseSpaceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: NO_PIECE_FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parseSpaceOptions() throws on incomplete input", () => {
    expect(() =>
      parseSpaceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        space: SPACE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        identity: ID,
      })
    ).toThrow(/--space/);
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parseSpaceOptions({
        identity: ID,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
      })
    ).toThrow();
  });

  it("parsePieceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    };
    expect(parsePieceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    })).toMatchObject(expected);
    expect(parsePieceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parsePieceOptions() throws on incomplete input", () => {
    expect(() =>
      parsePieceOptions({
        url: NO_PIECE_FULL_URL,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        piece: PIECE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        identity: ID,
        piece: PIECE,
      })
    ).toThrow(/--space/);
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        identity: ID,
        piece: PIECE,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parsePieceOptions({
        identity: ID,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        piece: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
        piece: PIECE,
      })
    ).toThrow();
  });

  describe("parseLink", () => {
    it("should parse piece ID only", () => {
      const result = parseLink("piece1");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toBeUndefined();
    });

    it("should parse simple paths correctly", () => {
      const result = parseLink("piece1/field");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toEqual(["field"]);
    });

    it("should parse deep paths with array indices", () => {
      const result = parseLink("piece2/data/items/0/title");
      expect(result.pieceId).toBe("piece2");
      expect(result.path).toEqual(["data", "items", 0, "title"]);
    });

    it("should handle mixed string and numeric paths", () => {
      const result = parseLink("piece/users/5/profile/settings/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["users", 5, "profile", "settings", 2]);
    });

    it("should handle paths with only numbers", () => {
      const result = parseLink("piece/0/1/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual([0, 1, 2]);
    });

    it("should handle empty string after slash", () => {
      const result = parseLink("piece/field/");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["field", ""]);
    });
  });
});
