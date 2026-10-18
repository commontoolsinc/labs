import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { traverseValue, visitValue } from "../../src/builder/traverse-utils.ts";

describe("traverse-utils", () => {
  describe("visitValue()", () => {
    it("shows `fn` every value a rebuilding traversal shows it, holes excepted", () => {
      const sparse: unknown[] = [];
      sparse[0] = { a: 1 };
      sparse[2] = [2, { b: 3 }];
      const value = { list: sparse, c: 4 };
      const seenByVisit: unknown[] = [];
      const seenByTraverse: unknown[] = [];
      visitValue(value, (item) => {
        seenByVisit.push(item);
      });
      traverseValue(value, (item) => {
        seenByTraverse.push(item);
      });
      expect(seenByVisit).toEqual(seenByTraverse);
      expect(seenByVisit).not.toContain(undefined);
    });

    it("descends into what `fn` returns in place of a value", () => {
      const seen: unknown[] = [];
      visitValue({ a: 1 }, (item) => {
        seen.push(item);
        return item === 1 ? { replaced: true } : undefined;
      });
      expect(seen).toEqual([{ a: 1 }, 1, true]);
    });
  });

  describe("traverseValue()", () => {
    it("keeps the holes of a sparse array in the rebuilt copy", () => {
      const sparse: unknown[] = [];
      sparse[1] = "x";
      const copy = traverseValue({ list: sparse }, () => undefined) as {
        list: unknown[];
      };
      expect(copy.list.length).toBe(2);
      expect(0 in copy.list).toBe(false);
      expect(copy.list[1]).toBe("x");
    });
  });
});
