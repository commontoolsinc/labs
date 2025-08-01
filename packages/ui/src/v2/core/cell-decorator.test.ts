import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cell, setCellValue } from "./cell-decorator.ts";
import type { CellDecoratorOptions } from "./cell-decorator-types.ts";

describe("@cell() decorator", () => {
  describe("decorator function", () => {
    it("should be callable without options", () => {
      const decorator = cell();
      expect(typeof decorator).toBe("function");
    });

    it("should be callable with options", () => {
      const options: CellDecoratorOptions = {
        timing: { strategy: "debounce", delay: 300 }
      };
      const decorator = cell(options);
      expect(typeof decorator).toBe("function");
    });

    it("should be callable with empty options", () => {
      const decorator = cell({});
      expect(typeof decorator).toBe("function");
    });
  });

  describe("setCellValue function", () => {
    it("should be exported as a function", () => {
      expect(typeof setCellValue).toBe("function");
    });
  });

  describe("type exports", () => {
    it("should allow importing types", () => {
      // This is a compile-time test - if the file compiles, types are exported correctly
      const options: CellDecoratorOptions = {
        timing: { strategy: "immediate" }
      };
      expect(options.timing?.strategy).toBe("immediate");
    });
  });
});