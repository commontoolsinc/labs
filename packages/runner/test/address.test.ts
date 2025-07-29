import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Address from "../src/storage/transaction/address.ts";
import { IMemoryAddress } from "../src/storage/interface.ts";

describe("Address Module", () => {
  describe("toString function", () => {
    it("should convert address with empty path to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/user:1/application/json/");
    });

    it("should convert address with single path element to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/user:1/application/json/profile");
    });

    it("should convert address with nested path to string", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/user:1/application/json/profile/settings/theme");
    });

    it("should handle address with numeric path elements", () => {
      const address = {
        id: "array:1",
        type: "application/json",
        path: ["items", "0", "name"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/array:1/application/json/items/0/name");
    });

    it("should handle address with special characters in id", () => {
      const address = {
        id: "user:special-chars_123",
        type: "application/json",
        path: ["data"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/user:special-chars_123/application/json/data");
    });

    it("should handle different content types", () => {
      const address = {
        id: "document:1",
        type: "text/plain",
        path: ["metadata", "title"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe("/document:1/text/plain/metadata/title");
    });
  });

  describe("includes function", () => {
    it("should return true when source includes candidate (source is parent)", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when source includes candidate (partial path)", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when candidate is same as source", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.includes(address, address);

      expect(result).toBe(true);
    });

    it("should return false when source does not include candidate", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when addresses have different ids", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:2",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when addresses have different types", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "text/plain",
        path: ["profile"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when paths are completely different", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["settings"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when paths share prefix but are not parent-child", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(false);
    });

    it("should handle array index paths correctly", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0", "name"],
      } as const;

      const result = Address.includes(source, candidate);

      expect(result).toBe(true);
    });

    it("should handle numeric path prefix matching", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "1"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "10"],
      } as const;

      const result = Address.includes(source, candidate);

      // "items/10" starts with "items/1", but they are not really the same!
      expect(result).toBe(false);
    });
  });

  describe("intersects function", () => {
    it("should return true when addresses are identical", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.intersects(address, address);

      expect(result).toBe(true);
    });

    it("should return true when source is parent of candidate", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when candidate is parent of source", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should return true when one path is empty (root)", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should return false when addresses have different ids", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:2",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when addresses have different types", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "text/plain",
        path: ["profile", "name"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when paths are completely disjoint", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["settings", "theme"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(false);
    });

    it("should return false when paths share prefix but neither contains the other", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "name"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "email"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(false);
    });

    it("should handle deep nesting correctly", () => {
      const source = {
        id: "doc:1",
        type: "application/json",
        path: ["data", "section", "paragraph", "sentence"],
      } as const;

      const candidate = {
        id: "doc:1",
        type: "application/json",
        path: ["data", "section"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should handle array indices correctly", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "0", "properties"],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should handle prefix matching with similar array indices", () => {
      const source = {
        id: "list:1",
        type: "application/json",
        path: ["items", "1"],
      } as const;

      const candidate = {
        id: "list:1",
        type: "application/json",
        path: ["items", "10"],
      } as const;

      const result = Address.intersects(source, candidate);

      // "items/1" is a prefix of "items/10", but they are not really the same!
      expect(result).toBe(false);
    });

    it("should handle edge case with empty string in path", () => {
      const source = {
        id: "test:1",
        type: "application/json",
        path: ["", "data"],
      } as const;

      const candidate = {
        id: "test:1",
        type: "application/json",
        path: [""],
      } as const;

      const result = Address.intersects(source, candidate);

      expect(result).toBe(true);
    });

    it("should be symmetric", () => {
      const source = {
        id: "user:1",
        type: "application/json",
        path: ["profile"],
      } as const;

      const candidate = {
        id: "user:1",
        type: "application/json",
        path: ["profile", "settings", "theme"],
      } as const;

      const result1 = Address.intersects(source, candidate);
      const result2 = Address.intersects(candidate, source);

      expect(result1).toBe(result2);
      expect(result1).toBe(true);
    });
  });

  describe("isInline function", () => {
    it("should return false for regular addresses", () => {
      const address = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address);

      expect(result).toBe(false);
    });

    it("should return true for data URI addresses", () => {
      const address = {
        id: 'data:application/json,{"hello":"world"}',
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address);

      expect(result).toBe(true);
    });

    it("should return true for base64 data URI addresses", () => {
      const address = {
        id: "data:application/json;base64,eyJoZWxsbyI6IndvcmxkIn0=",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address);

      expect(result).toBe(true);
    });

    it("should return false for addresses with data: in the middle", () => {
      const address = {
        id: "user:data:123",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address);

      expect(result).toBe(false);
    });

    it("should return false for empty id", () => {
      const address = {
        id: "",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address as any as IMemoryAddress);

      expect(result).toBe(false);
    });

    it("should return false for addresses starting with 'data' but not 'data:'", () => {
      const address = {
        id: "data-user:1",
        type: "application/json",
        path: [],
      } as const;

      const result = Address.isInline(address);

      expect(result).toBe(false);
    });

    it("should return true for various media types in data URIs", () => {
      const addresses = [
        "data:text/plain,hello%20world",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "data:text/html,<h1>Hello</h1>",
        "data:application/xml,<root><item>value</item></root>",
      ] as const;

      addresses.forEach((id) => {
        const address = {
          id,
          type: "application/json",
          path: [],
        } as const;

        const result = Address.isInline(address);
        expect(result).toBe(true);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle addresses with empty paths consistently", () => {
      const address1 = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      const address2 = {
        id: "user:1",
        type: "application/json",
        path: [],
      } as const;

      expect(Address.toString(address1)).toBe("/user:1/application/json/");
      expect(Address.includes(address1, address2)).toBe(true);
      expect(Address.intersects(address1, address2)).toBe(true);
    });

    it("should handle addresses with complex ids", () => {
      const address = {
        id: "namespace:complex-id-with-dashes_and_underscores.123",
        type: "application/vnd.api+json",
        path: ["data", "attributes", "nested-property"],
      } as const;

      const result = Address.toString(address);

      expect(result).toBe(
        "/namespace:complex-id-with-dashes_and_underscores.123/application/vnd.api+json/data/attributes/nested-property",
      );
    });

    it("should handle path elements that could confuse string operations", () => {
      const source = {
        id: "test:1",
        type: "application/json",
        path: ["path"],
      } as const;

      const candidate = {
        id: "test:1",
        type: "application/json",
        path: ["path", "path/with/slashes"],
      } as const;

      // Even though the path element contains slashes, the function should work correctly
      expect(Address.includes(source, candidate)).toBe(true);
      expect(Address.intersects(source, candidate)).toBe(true);
    });

    it("should handle numeric strings in paths with prefix matching", () => {
      const source = {
        id: "test:1",
        type: "application/json",
        path: ["items", "12"],
      } as const;

      const candidate = {
        id: "test:1",
        type: "application/json",
        path: ["items", "123"],
      } as const;

      // "items/123" starts with "items/12", but they are not really the same!
      expect(Address.includes(source, candidate)).toBe(false);
      expect(Address.intersects(source, candidate)).toBe(false);
    });
  });
});
