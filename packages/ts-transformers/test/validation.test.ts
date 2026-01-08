import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";

const COMMONTOOLS_TYPES = {
  "commontools.d.ts": `
    declare module "commontools" {
      export interface Cell<T> {
        get(): T;
        set(value: T): void;
      }
      export interface OpaqueRef<T> {
        readonly __opaque: T;
      }
      export interface OpaqueCell<T> extends Cell<T> {
        readonly __opaque: T;
      }
      export type Writable<T> = Cell<T>;
      export function recipe<T>(name: string, fn: (state: T) => any): any;
      export function pattern<T>(fn: (state: T) => any): any;
      export function handler<T>(fn: (event: T) => void): any;
      export function action<T>(fn: () => T): any;
      export function computed<T>(fn: () => T): T;
      export function derive<T, U>(cell: Cell<T>, fn: (value: T) => U): U;
    }
  `,
};

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

function getWarnings(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "warning");
}

Deno.test("Cast Validation", async (t) => {
  await t.step("errors on double cast 'as unknown as'", async () => {
    const source = `
      import { OpaqueRef } from "commontools";

      interface Item { name: string; }
      const data = { name: "test" };
      const ref = data as unknown as OpaqueRef<Item>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:double-unknown");
  });

  await t.step("errors on 'as OpaqueRef<>'", async () => {
    const source = `
      import { OpaqueRef } from "commontools";

      interface Item { name: string; }
      const data: any = { name: "test" };
      const ref = data as OpaqueRef<Item>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:forbidden-cast");
  });

  await t.step("warns on 'as Cell<>'", async () => {
    const source = `
      import { Cell } from "commontools";

      const data: any = { value: 42 };
      const cell = data as Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const warnings = getWarnings(diagnostics);
    assertGreater(warnings.length, 0, "Expected at least one warning");
    assertEquals(warnings[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("warns on 'as OpaqueCell<>'", async () => {
    const source = `
      import { OpaqueCell } from "commontools";

      const data: any = { value: 42 };
      const cell = data as OpaqueCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const warnings = getWarnings(diagnostics);
    assertGreater(warnings.length, 0, "Expected at least one warning");
    assertEquals(warnings[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("warns on 'as Writable<>'", async () => {
    const source = `
      import { Writable } from "commontools";

      const data: any = { value: 42 };
      const cell = data as Writable<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const warnings = getWarnings(diagnostics);
    assertGreater(warnings.length, 0, "Expected at least one warning");
    assertEquals(warnings[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("allows valid type assertions", async () => {
    const source = `
      interface Item { name: string; }
      const data: unknown = { name: "test" };
      const item = data as Item;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });
});

Deno.test("Pattern Context Validation", async (t) => {
  await t.step(
    "allows property access in JSX (transformer handles it)",
    async () => {
      const source = `
      import { recipe, OpaqueRef } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        return <div>{item.name}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      // Property access in JSX should be allowed (transformer rewrites these)
      assertEquals(errors.length, 0, "JSX property access should be allowed");
    },
  );

  await t.step("allows passing property to function", async () => {
    const source = `
      import { recipe, OpaqueRef } from "commontools";

      interface Item { name: string; }

      function format(name: string): string { return name.toUpperCase(); }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        const formatted = format(item.name);
        return <div>{formatted}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    // Passing to function is a pass-through, not computation
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Property pass-through to function should be allowed",
    );
  });
});

Deno.test("Diagnostic output format", async (t) => {
  await t.step("includes source location information", async () => {
    const source = `
      import { OpaqueRef } from "commontools";

      const data = {} as unknown as OpaqueRef<any>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0);
    const error = errors[0]!;

    // Verify diagnostic includes location info
    assertEquals(error.fileName, "/test.tsx");
    assertGreater(error.line, 0, "Line should be positive");
    assertGreater(error.column, 0, "Column should be positive");
    assertGreater(error.start, 0, "Start position should be positive");
    assertGreater(error.length, 0, "Length should be positive");
    assertEquals(typeof error.message, "string");
    assertEquals(typeof error.type, "string");
  });
});
