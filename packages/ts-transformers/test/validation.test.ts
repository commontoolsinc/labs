import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";

const COMMONTOOLS_TYPES = {
  "commontools.d.ts": `
    declare module "commontools" {
      export interface Cell<T> {
        get(): T;
        set(value: T): void;
        map<U>(fn: (value: T) => U): Cell<U>;
      }
      export interface OpaqueRef<T> {
        readonly __opaque: T;
        map<U>(fn: (value: T) => U): OpaqueRef<U>;
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
      export function lift<T>(fn: () => T): T;
      export function h(tag: string, props?: any, ...children: any[]): any;
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

Deno.test("Pattern Context Validation - Restricted Contexts", async (t) => {
  await t.step(
    "allows property access in JSX (transformer handles it)",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        return <div>{item.name}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0, "JSX property access should be allowed");
    },
  );

  await t.step(
    "allows passing property to function (pass-through)",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, h } from "commontools";

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
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Property pass-through to function should be allowed",
      );
    },
  );

  await t.step(
    "allows optional chaining inside JSX expressions",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, h } from "commontools";

      interface Item { name?: string; nested?: { value: number } }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        return <div>{item?.name} - {item?.nested?.value}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Optional chaining inside JSX should be allowed (OpaqueRefJSXTransformer handles it)",
      );
    },
  );

  await t.step("allows .get() calls inside JSX expressions", async () => {
    const source = `/// <cts-enable />
      import { recipe, Cell, h } from "commontools";

      export default recipe<{ count: Cell<number> }>("test", ({ count }) => {
        return <div>Count: {count.get()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      ".get() inside JSX should be allowed (OpaqueRefJSXTransformer handles it)",
    );
  });
});

Deno.test("Pattern Context Validation - Safe Wrappers", async (t) => {
  await t.step("allows reading opaques inside computed()", async () => {
    const source = `/// <cts-enable />
      import { recipe, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        const isExpensive = computed(() => item.price > 100);
        return <div>{isExpensive}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside computed() should be allowed",
    );
  });

  await t.step("allows reading opaques inside action()", async () => {
    const source = `/// <cts-enable />
      import { recipe, action, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        const logPrice = action(() => {
          console.log(item.price > 100 ? "expensive" : "cheap");
        });
        return <div onClick={logPrice}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside action() should be allowed",
    );
  });

  await t.step("allows reading opaques inside derive()", async () => {
    const source = `/// <cts-enable />
      import { recipe, derive, Cell, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item, discount: Cell<number> }>("test", ({ item, discount }) => {
        const finalPrice = derive(discount, (d) => item.price * (1 - d));
        return <div>{finalPrice}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside derive() should be allowed",
    );
  });

  await t.step("allows reading opaques inside lift()", async () => {
    const source = `/// <cts-enable />
      import { recipe, lift, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        const doubled = lift(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside lift() should be allowed",
    );
  });

  await t.step("allows reading opaques inside handler()", async () => {
    const source = `/// <cts-enable />
      import { recipe, handler, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        const onClick = handler((e: MouseEvent) => {
          if (item.price > 100) {
            console.log("expensive!");
          }
        });
        return <div onClick={onClick}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside handler() should be allowed",
    );
  });

  await t.step(
    "allows reading opaques inside inline JSX event handlers",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, Cell, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item, count: Cell<number> }>("test", ({ item, count }) => {
        return (
          <div>
            <button onClick={() => {
              const currentPrice = item.price;
              if (currentPrice > 100) {
                count.set(count.get() + 1);
              }
            }}>
              Click me
            </button>
          </div>
        );
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reading opaques inside inline JSX event handlers should be allowed",
      );
    },
  );

  await t.step(
    "allows reading opaques inside standalone function declarations",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        // Helper function defined in pattern - called from computed
        function isExpensive() {
          return item.price > 100;
        }

        const expensive = computed(() => isExpensive());
        return <div>{expensive}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reading opaques inside standalone function declarations should be allowed",
      );
    },
  );

  await t.step(
    "allows reading opaques inside standalone arrow functions",
    async () => {
      const source = `/// <cts-enable />
      import { recipe, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default recipe<{ item: Item }>("test", ({ item }) => {
        // Helper arrow function defined in pattern - called from computed
        const isExpensive = () => item.price > 100;

        const expensive = computed(() => isExpensive());
        return <div>{expensive}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reading opaques inside standalone arrow functions should be allowed",
      );
    },
  );
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
