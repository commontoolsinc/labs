import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

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
      import { pattern, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
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
      import { pattern, h } from "commontools";

      interface Item { name: string; }

      function format(name: string): string { return name.toUpperCase(); }

      export default pattern<{ item: Item }>(({ item }) => {
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
      import { pattern, h } from "commontools";

      interface Item { name?: string; nested?: { value: number } }

      export default pattern<{ item: Item }>(({ item }) => {
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
      import { pattern, Cell, h } from "commontools";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
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
      import { pattern, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
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
      import { pattern, action, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
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
      import { pattern, derive, Cell, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item, discount: Cell<number> }>(({ item, discount }) => {
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

  await t.step(
    "allows reading opaques inside standalone derive()",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, derive, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        // Standalone derive (nullary form) - should allow opaque access
        const isExpensive = derive(() => item.price > 100);
        const doubled = derive(() => item.price * 2);
        return <div>{isExpensive ? "Expensive" : "Affordable"} - {doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reading opaques inside standalone derive() should be allowed",
      );
    },
  );

  await t.step(
    "errors on lift() inside pattern (must be at module scope)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, lift, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "lift() inside pattern should error (must be at module scope)",
      );
      assertEquals(errors[0]!.type, "pattern-context:builder-placement");
    },
  );

  await t.step(
    "errors on handler() inside pattern (must be at module scope)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, handler, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
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
      assertGreater(
        errors.length,
        0,
        "handler() inside pattern should error (must be at module scope)",
      );
      assertEquals(errors[0]!.type, "pattern-context:builder-placement");
    },
  );

  await t.step(
    "allows reading opaques inside inline JSX event handlers",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, Cell, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item, count: Cell<number> }>(({ item, count }) => {
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
    "errors on standalone function declarations in pattern (must be at module scope)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        // Helper function defined in pattern - now an error
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
      assertGreater(
        errors.length,
        0,
        "Function declarations in pattern should error (must be at module scope)",
      );
      assertEquals(errors[0]!.type, "pattern-context:function-creation");
    },
  );

  await t.step(
    "errors on standalone arrow functions in pattern (must be at module scope)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, h } from "commontools";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        // Helper arrow function defined in pattern - now an error
        const isExpensive = () => item.price > 100;

        const expensive = computed(() => isExpensive());
        return <div>{expensive}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "Arrow functions in pattern should error (must be at module scope)",
      );
      assertEquals(errors[0]!.type, "pattern-context:function-creation");
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

Deno.test("Pattern Context Validation - Function Creation", async (t) => {
  await t.step("errors on arrow function in pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const helper = () => item.price * 2;
        return <div>{helper()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "pattern-context:function-creation");
  });

  await t.step("errors on function expression in pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const helper = function() { return item.price * 2; };
        return { UI: <div>{helper()}</div> };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "pattern-context:function-creation");
  });

  await t.step("errors on function declaration in pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        function helper() { return item.price * 2; }
        return <div>{helper()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "pattern-context:function-creation");
  });

  await t.step("allows arrow function inside computed()", async () => {
    const source = `/// <cts-enable />
      import { pattern, computed, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = computed(() => {
          const multiply = (x: number) => x * 2;
          return multiply(item.price);
        });
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
      "Arrow function inside computed() should be allowed",
    );
  });

  await t.step("allows arrow function inside action()", async () => {
    const source = `/// <cts-enable />
      import { pattern, action, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doSomething = action(() => {
          const helper = () => item.price * 2;
          console.log(helper());
        });
        return <div onClick={doSomething}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Arrow function inside action() should be allowed",
    );
  });

  await t.step("allows inline JSX event handler", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        return <div onClick={() => console.log(item.price)}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Inline JSX event handler should be allowed",
    );
  });

  await t.step("allows map callback inside JSX", async () => {
    const source = `/// <cts-enable />
      import { pattern, h, OpaqueRef } from "commontools";

      interface Item { name: string; }

      export default pattern<{ items: OpaqueRef<Item[]> }>(({ items }) => {
        return <div>{items.map(item => <span>{item.name}</span>)}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Map callback inside JSX should be allowed");
  });

  await t.step("allows map callback outside JSX in pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, OpaqueRef } from "commontools";

      interface Item { name: string; }

      const listItems = pattern<
        { items: OpaqueRef<Item[]> },
        { result: Array<{ label: string }> }
      >(({ items }) => {
        const result = items.map((item) => ({
          label: item.name,
        }));
        return { result };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Map callback outside JSX in pattern should be allowed (transformed to pattern)",
    );
  });
});

Deno.test("Pattern Context Validation - Builder Placement", async (t) => {
  await t.step("errors on lift() inside pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, lift, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "pattern-context:builder-placement");
  });

  await t.step(
    "errors on lift() immediately invoked with computed suggestion",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, lift, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(({ x }: { x: number }) => x * 2)({ x: item.price });
        return <div>{doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "pattern-context:builder-placement");
      assertEquals(
        errors[0]!.message.includes("computed"),
        true,
        "Error should suggest using computed()",
      );
    },
  );

  await t.step("errors on handler() inside pattern body", async () => {
    const source = `/// <cts-enable />
      import { pattern, handler, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const onClick = handler(() => console.log(item.price));
        return { UI: <div onClick={onClick}>Click</div> };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "pattern-context:builder-placement");
  });

  await t.step("allows lift() at module scope", async () => {
    const source = `/// <cts-enable />
      import { pattern, lift, h } from "commontools";

      interface Item { price: number; }

      const doublePrice = lift((price: number) => price * 2);

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = doublePrice(item.price);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "lift() at module scope should be allowed");
  });

  await t.step("allows handler() at module scope", async () => {
    const source = `/// <cts-enable />
      import { pattern, handler, h } from "commontools";

      interface Item { price: number; }

      const logPrice = handler((price: number) => console.log(price));

      export default pattern<{ item: Item }>(({ item }) => {
        return <div onClick={() => logPrice(item.price)}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "handler() at module scope should be allowed",
    );
  });

  await t.step("allows computed() inside pattern", async () => {
    const source = `/// <cts-enable />
      import { pattern, computed, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = computed(() => item.price * 2);
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
      "computed() inside pattern should be allowed",
    );
  });

  await t.step("allows action() inside pattern", async () => {
    const source = `/// <cts-enable />
      import { pattern, action, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const log = action(() => console.log(item.price));
        return <div onClick={log}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "action() inside pattern should be allowed");
  });

  await t.step("allows derive() inside pattern", async () => {
    const source = `/// <cts-enable />
      import { pattern, derive, h } from "commontools";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = derive(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "derive() inside pattern should be allowed");
  });
});

Deno.test("OpaqueRef .get() Validation", async (t) => {
  await t.step(
    "errors on .get() called on computed result",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed } from "commontools";

      export default pattern<{ foo: number }>(({ foo }) => {
        const bar = computed(() => foo + 1);
        const baz = computed(() => bar.get() + 1);
        return { result: baz };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "opaque-get:invalid-call");
      assertEquals(
        errors[0]!.message.includes("bar"),
        true,
        "Error should mention the receiver name",
      );
      assertEquals(
        errors[0]!.message.includes("bar.get()"),
        true,
        "Error should show the full .get() call",
      );
      assertEquals(
        errors[0]!.message.includes("reactive value"),
        true,
        "Error should explain it's a reactive value",
      );
    },
  );

  await t.step(
    "errors on .get() called on pattern input without Writable",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed } from "commontools";

      export default pattern<{ items: string[] }>(({ items }) => {
        const count = computed(() => items.get().length);
        return { count };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "opaque-get:invalid-call");
    },
  );

  await t.step(
    "allows .get() on Writable pattern input",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, Writable } from "commontools";

      export default pattern<{ count: Writable<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        ".get() on Writable should be allowed",
      );
    },
  );

  await t.step(
    "allows .get() on Cell pattern input",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, Cell } from "commontools";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        ".get() on Cell should be allowed",
      );
    },
  );

  await t.step(
    "allows direct access on computed result (correct usage)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed } from "commontools";

      export default pattern<{ foo: number }>(({ foo }) => {
        const bar = computed(() => foo + 1);
        const baz = computed(() => bar + 1);
        return { result: baz };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Direct access on computed result should be allowed",
      );
    },
  );
});

Deno.test("Pattern Context Validation - Map on Fallback", async (t) => {
  await t.step(
    "errors on .map() after ?? [] fallback with reactive left side",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, UI } from "commontools";

      interface Item { name: string; }

      export default pattern<{ items?: Item[] }>(({ items }) => {
        return {
          [UI]: (
            <div>
              {(items ?? []).map((item) => <span>{item.name}</span>)}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "pattern-context:map-on-fallback");
    },
  );

  await t.step(
    "errors on .map() after || [] fallback with reactive left side",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, UI } from "commontools";

      interface Item { name: string; }

      export default pattern<{ items?: Item[] }>(({ items }) => {
        return {
          [UI]: (
            <div>
              {(items || []).map((item) => <span>{item.name}</span>)}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "pattern-context:map-on-fallback");
    },
  );

  await t.step(
    "allows .map() on direct property access (correct usage)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, UI } from "commontools";

      interface Item { name: string; }

      export default pattern<{ items: Item[] }>(({ items }) => {
        return {
          [UI]: (
            <div>
              {items.map((item) => <span>{item.name}</span>)}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        ".map() on direct property access should be allowed",
      );
    },
  );

  await t.step(
    "allows .map() on non-reactive fallback (plain arrays)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, UI } from "commontools";

      export default pattern<{}>(({}) => {
        const items: string[] | undefined = undefined;
        return {
          [UI]: (
            <div>
              {(items ?? []).map((item) => <span>{item}</span>)}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        ".map() on non-reactive fallback should be allowed",
      );
    },
  );
});

Deno.test("Standalone Function Validation", async (t) => {
  await t.step(
    "errors on computed() inside standalone function",
    async () => {
      const source = `/// <cts-enable />
      import { computed, Cell } from "commontools";

      const count = {} as Cell<number>;

      const helper = () => {
        return computed(() => count.get() * 2);
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "standalone-function:reactive-operation");
      assertEquals(
        errors[0]!.message.includes("computed()"),
        true,
        "Error should mention computed()",
      );
    },
  );

  await t.step(
    "errors on derive() inside standalone function",
    async () => {
      const source = `/// <cts-enable />
      import { derive, Cell } from "commontools";

      const value = {} as Cell<number>;

      const helper = () => {
        return derive(() => value.get() * 2);
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "standalone-function:reactive-operation");
      assertEquals(
        errors[0]!.message.includes("derive()"),
        true,
        "Error should mention derive()",
      );
    },
  );

  await t.step(
    "errors on .map() on reactive type inside standalone function",
    async () => {
      const source = `/// <cts-enable />
      import { cell } from "commontools";

      const items = cell(["a", "b", "c"]);

      const helper = () => {
        return items.map((item) => item.toUpperCase());
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "standalone-function:reactive-operation");
      assertEquals(
        errors[0]!.message.includes(".map()"),
        true,
        "Error should mention .map()",
      );
    },
  );

  await t.step(
    "allows reactive operations in functions passed to patternTool()",
    async () => {
      const source = `/// <cts-enable />
      import { patternTool, derive, Cell } from "commontools";

      const multiplier = {} as Cell<number>;

      const tool = patternTool(({ query }: { query: string }) => {
        return derive(() => query.length * multiplier.get());
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reactive operations inside patternTool() should be allowed",
      );
    },
  );

  await t.step(
    "allows plain array .map() inside standalone function",
    async () => {
      const source = `/// <cts-enable />
      const helper = () => {
        const items = ["a", "b", "c"];
        return items.map((item) => item.toUpperCase());
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Plain array .map() should be allowed in standalone functions",
      );
    },
  );

  await t.step(
    "allows standalone function without reactive operations",
    async () => {
      const source = `/// <cts-enable />
      const helper = (x: number) => {
        return x * 2 + 10;
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Standalone functions without reactive operations should be allowed",
      );
    },
  );

  await t.step(
    "allows reactive operations inside pattern body (not standalone)",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, Cell } from "commontools";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reactive operations directly in pattern body should be allowed",
      );
    },
  );

  await t.step(
    "errors only on inner function, not outer, when nested function has reactive ops",
    async () => {
      const source = `/// <cts-enable />
      import { computed, Cell } from "commontools";

      const count = {} as Cell<number>;

      const outer = () => {
        // Nested function uses computed() — error should be on inner,
        // not on outer, because validateStandaloneFunction skips
        // nested function bodies when walking the outer function.
        const inner = () => {
          return computed(() => count.get() * 2);
        };
        return inner;
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(diagnostics).filter(
        (e) => e.type === "standalone-function:reactive-operation",
      );
      // Exactly 1 error — on the inner function, not the outer
      assertEquals(
        errors.length,
        1,
        "Should flag inner standalone function but not outer",
      );
    },
  );
});
