import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getExportInfo } from "../src/utils/export-info.ts";

describe("getExportInfo", () => {
  describe("default exports", () => {
    it("detects export default expression", () => {
      const info = getExportInfo(`
        const foo = 1;
        export default foo;
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual([]);
    });

    it("detects export default function declaration", () => {
      const info = getExportInfo(`
        export default function foo() {
          return 42;
        }
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual([]);
    });

    it("detects export default class declaration", () => {
      const info = getExportInfo(`
        export default class Foo {
          value = 42;
        }
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual([]);
    });

    it("detects export { x as default }", () => {
      const info = getExportInfo(`
        const foo = 1;
        export { foo as default };
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual([]);
    });

    it("does not detect export = (CommonJS)", () => {
      const info = getExportInfo(`
        const foo = 1;
        export = foo;
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual([]);
    });
  });

  describe("named exports", () => {
    it("detects export const", () => {
      const info = getExportInfo(`
        export const foo = 1;
        export const bar = 2, baz = 3;
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["foo", "bar", "baz"]);
    });

    it("detects export function", () => {
      const info = getExportInfo(`
        export function foo() {}
        export function bar() {}
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["foo", "bar"]);
    });

    it("detects export class", () => {
      const info = getExportInfo(`
        export class Foo {}
        export class Bar {}
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["Foo", "Bar"]);
    });

    it("detects export type", () => {
      const info = getExportInfo(`
        export type Foo = string;
        export type Bar = number;
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["Foo", "Bar"]);
    });

    it("detects export interface", () => {
      const info = getExportInfo(`
        export interface Foo { x: string; }
        export interface Bar { y: number; }
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["Foo", "Bar"]);
    });

    it("detects export enum", () => {
      const info = getExportInfo(`
        export enum Foo { A, B }
        export enum Bar { X, Y }
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["Foo", "Bar"]);
    });

    it("detects export { ... }", () => {
      const info = getExportInfo(`
        const foo = 1;
        const bar = 2;
        export { foo, bar };
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["foo", "bar"]);
    });

    it("detects export { x as y }", () => {
      const info = getExportInfo(`
        const foo = 1;
        export { foo as bar };
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["bar"]);
    });
  });

  describe("combined exports", () => {
    it("detects both default and named exports", () => {
      const info = getExportInfo(`
        export const foo = 1;
        export function bar() {}
        export default class Baz {}
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual(["foo", "bar"]);
    });

    it("detects export { x as default, y }", () => {
      const info = getExportInfo(`
        const foo = 1;
        const bar = 2;
        export { foo as default, bar };
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual(["bar"]);
    });

    it("handles complex real-world example", () => {
      const info = getExportInfo(`
        import { Recipe } from "commontools";

        interface Task {
          id: string;
          title: string;
        }

        export const defaultTasks: Task[] = [
          { id: "1", title: "First" }
        ];

        export function sanitize(task: Task): Task {
          return { ...task };
        }

        export default Recipe({
          tasks: defaultTasks
        });
      `);
      expect(info.hasDefaultExport).toBe(true);
      expect(info.namedExports).toEqual(["defaultTasks", "sanitize"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty file", () => {
      const info = getExportInfo("");
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual([]);
    });

    it("handles file with no exports", () => {
      const info = getExportInfo(`
        const foo = 1;
        function bar() {}
        class Baz {}
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual([]);
    });

    it("handles file with only imports", () => {
      const info = getExportInfo(`
        import { foo } from "bar";
        import type { Baz } from "qux";
      `);
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual([]);
    });

    it("ignores re-exports from other modules", () => {
      const info = getExportInfo(`
        export { foo } from "./other";
        export * from "./another";
      `);
      // Note: These are re-exports, we currently detect them as named exports
      // This behavior could be refined if needed
      expect(info.hasDefaultExport).toBe(false);
      expect(info.namedExports).toEqual(["foo"]);
    });
  });
});
