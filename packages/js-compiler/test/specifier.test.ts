import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Source } from "../interface.ts";
import {
  importEscapesProgramRoot,
  resolveImportSpecifier,
} from "../specifier.ts";

const from = (name: string): Source => ({ name, contents: "" });

describe("specifier", () => {
  describe("importEscapesProgramRoot", () => {
    it("returns true for a parent import from a file at the root", () => {
      expect(
        importEscapesProgramRoot("../shared/mod.ts", from("/main.tsx")),
      ).toBe(true);
    });

    it("returns true when the climb exceeds the importer's depth", () => {
      expect(
        importEscapesProgramRoot(
          "../../cfc/admin/mod.ts",
          from("/lot-watch/main.tsx"),
        ),
      ).toBe(true);
    });

    it("returns false for a parent import that stays inside the root", () => {
      expect(
        importEscapesProgramRoot("../util/helpers.ts", from("/core/main.tsx")),
      ).toBe(false);
    });

    it("returns false for a same-directory import", () => {
      expect(
        importEscapesProgramRoot("./helpers.ts", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for an inner traversal that nets inside", () => {
      expect(
        importEscapesProgramRoot("./sub/../helpers.ts", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for a bare specifier", () => {
      expect(
        importEscapesProgramRoot("commonfabric", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for an ungrounded importer name", () => {
      expect(
        importEscapesProgramRoot("../shared/mod.ts", from("main.tsx")),
      ).toBe(false);
    });
  });

  describe("resolveImportSpecifier", () => {
    it("joins a relative specifier against the importer's directory", () => {
      expect(
        resolveImportSpecifier("./helpers.ts", from("/core/main.tsx")),
      ).toBe("/core/helpers.ts");
      expect(
        resolveImportSpecifier("../util/mod.ts", from("/core/main.tsx")),
      ).toBe("/util/mod.ts");
    });

    it("returns a bare specifier unchanged", () => {
      expect(
        resolveImportSpecifier("commonfabric", from("/main.tsx")),
      ).toBe("commonfabric");
    });
  });
});
