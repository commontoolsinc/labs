import { assertEquals, assertGreater, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

function getEmptyArrayErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) =>
    d.type === "cell-factory:empty-array" && d.severity === "error"
  );
}

async function getEmptyArrayErrorCount(
  imports: string,
  expression: string,
): Promise<number> {
  const source = `
    import { ${imports}, pattern } from "commonfabric";
    export default pattern(() => {
      const value = ${expression};
      return <div>{value}</div>;
    });
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  return getEmptyArrayErrors(diagnostics).length;
}

function assertHasErrorType(
  errors: readonly TransformationDiagnostic[],
  expectedType: string,
) {
  assertEquals(
    errors.some((error) => error.type === expectedType),
    true,
    `Expected error list to contain ${expectedType}`,
  );
}

Deno.test("CTS validation skips files with cf-disable-transform", async () => {
  const source = `/// <cf-disable-transform />
import { Cell } from "commonfabric";

const value = Cell.of([]);
const casted = {} as Cell<number>;
`;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(diagnostics.length, 0);
});

Deno.test("Cast Validation", async (t) => {
  await t.step("errors on double cast 'as unknown as'", async () => {
    const source = `
      import { OpaqueRef } from "commonfabric";

      interface Item { name: string; }
      const data = { name: "test" };
      const ref = data as unknown as OpaqueRef<Item>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "cast-validation:double-unknown");
  });

  await t.step("errors on 'as OpaqueRef<>'", async () => {
    const source = `
      import { OpaqueRef } from "commonfabric";

      interface Item { name: string; }
      const data: any = { name: "test" };
      const ref = data as OpaqueRef<Item>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "cast-validation:forbidden-cast");
  });

  await t.step("errors on 'as Cell<>'", async () => {
    const source = `
      import { Cell } from "commonfabric";

      const data: any = { value: 42 };
      const cell = data as Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on 'as OpaqueCell<>'", async () => {
    const source = `
      import { OpaqueCell } from "commonfabric";

      const data: any = { value: 42 };
      const cell = data as OpaqueCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on 'as Writable<>'", async () => {
    const source = `
      import { Writable } from "commonfabric";

      const data: any = { value: 42 };
      const cell = data as Writable<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on union casts containing 'Writable<>'", async () => {
    const source = `
      import { Writable } from "commonfabric";

      const data: any = { value: 42 };
      const cell = data as (Writable<number> | undefined);
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on renamed imports of 'Cell<>'", async () => {
    const source = `
      import { Cell as C } from "commonfabric";

      const data: any = { value: 42 };
      const cell = data as C<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on type aliases to 'Cell<>'", async () => {
    const source = `
      import { Cell } from "commonfabric";

      type MyCell = Cell<number>;
      const data: any = { value: 42 };
      const cell = data as MyCell;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on import type casts to 'Cell<>'", async () => {
    const source = `
      const data: any = { value: 42 };
      const cell = data as import("commonfabric").Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("errors on interfaces extending 'Cell<>'", async () => {
    const source = `
      import { Cell } from "commonfabric";

      interface MyCell extends Cell<number> {}
      const data: any = { value: 42 };
      const cell = data as MyCell;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step(
    "errors on wrappers from framework module declarations",
    async () => {
      const source = `
        import { Cell } from "@commonfabric/local-test";

        const data: any = { value: 42 };
        const cell = data as Cell<number>;
      `;
      const { diagnostics } = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "local-commonfabric.d.ts": `
            declare module "@commonfabric/local-test" {
              export interface Cell<T> {
                get(): T;
              }
            }
          `,
        },
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertEquals(errors[0]!.type, "cast-validation:cell-cast");
    },
  );

  await t.step("errors on qualified framework import types", async () => {
    const source = `
      declare module "@commonfabric/local-test" {
        export namespace wrappers {
          export interface Cell<T> {
            get(): T;
          }
        }
      }

      const data: any = { value: 42 };
      const cell = data as import("@commonfabric/local-test").wrappers.Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "cast-validation:cell-cast");
  });

  await t.step("allows import types from non-framework modules", async () => {
    const source = `
      declare module "not-commonfabric" {
        export interface Cell<T> {
          get(): T;
        }
      }

      const data: any = { value: 42 };
      const cell = data as import("not-commonfabric").Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step(
    "allows imports from non-framework module declarations",
    async () => {
      const source = `
      import { Cell } from "not-commonfabric";

      const data: any = { value: 42 };
      const cell = data as Cell<number>;
    `;
      const { diagnostics } = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "not-commonfabric.d.ts": `
          declare module "not-commonfabric" {
            export interface Cell<T> {
              get(): T;
            }
          }
        `,
        },
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0, "Should not produce any errors");
    },
  );

  await t.step("allows unresolved type references", async () => {
    const source = `
      const data: any = { value: 42 };
      const cell = data as MissingCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step("allows unresolved qualified type references", async () => {
    const source = `
      const data: any = { value: 42 };
      const cell = data as MissingNamespace.MissingCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step("allows recursive local type aliases", async () => {
    const source = `
      type LocalCell<T> = LocalCell<T>;

      const data: any = { value: 42 };
      const cell = data as LocalCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step("allows interfaces extending unresolved types", async () => {
    const source = `
      interface LocalCell<T> extends MissingCell<T> {}

      const data: any = { value: 42 };
      const cell = data as LocalCell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step("allows unrelated local types named 'Cell'", async () => {
    const source = `
      type Cell<T> = { value: T };

      const data: any = { value: 42 };
      const cell = data as Cell<number>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });

  await t.step("allows valid type assertions", async () => {
    const source = `
      interface Item { name: string; }
      const data: unknown = { name: "test" };
      const item = data as Item;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Should not produce any errors");
  });
});

Deno.test("Empty Array .of() Validation", async (t) => {
  const errorCases = [
    {
      name: "errors on Cell.of([])",
      imports: "Cell",
      expression: "Cell.of([])",
    },
    {
      name: "errors on Writable.of([])",
      imports: "Writable",
      expression: "Writable.of([])",
    },
    {
      name: "errors on new Writable([])",
      imports: "Writable",
      expression: "new Writable([])",
    },
    {
      name: "errors on OpaqueCell.of([])",
      imports: "OpaqueCell",
      expression: "OpaqueCell.of([])",
    },
    {
      name: "errors on Stream.of([])",
      imports: "Stream",
      expression: "Stream.of([])",
    },
    {
      name: "errors on deprecated cell([])",
      imports: "cell",
      expression: "cell([])",
    },
  ] as const;

  for (const testCase of errorCases) {
    await t.step(testCase.name, async () => {
      const count = await getEmptyArrayErrorCount(
        testCase.imports,
        testCase.expression,
      );
      assertGreater(count, 0, "Expected at least one empty-array error");
    });
  }

  const okCases = [
    {
      name: "no error on Cell.of<string[]>([])",
      imports: "Cell",
      expression: "Cell.of<string[]>([])",
    },
    {
      name: "no error on new Cell<string[]>([])",
      imports: "Cell",
      expression: "new Cell<string[]>([])",
    },
    {
      name: "no error on Cell.of([1, 2, 3])",
      imports: "Cell",
      expression: "Cell.of([1, 2, 3])",
    },
    {
      name: "no error on Cell.of('hello')",
      imports: "Cell",
      expression: 'Cell.of("hello")',
    },
    {
      name: "no error on Cell.of() with no arguments",
      imports: "Cell",
      expression: "Cell.of<string>()",
    },
  ] as const;

  for (const testCase of okCases) {
    await t.step(testCase.name, async () => {
      const count = await getEmptyArrayErrorCount(
        testCase.imports,
        testCase.expression,
      );
      assertEquals(count, 0);
    });
  }
});

Deno.test("Pattern Context Validation - Restricted Contexts", async (t) => {
  await t.step(
    "allows property access in JSX (transformer handles it)",
    async () => {
      const source = `      import { pattern, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        return <div>{item.name}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0, "JSX property access should be allowed");
    },
  );

  await t.step(
    "allows passing property to function (pass-through)",
    async () => {
      const source = `      import { pattern, h } from "commonfabric";

      interface Item { name: string; }

      function format(name: string): string { return name.toUpperCase(); }

      export default pattern<{ item: Item }>(({ item }) => {
        const formatted = format(item.name);
        return <div>{formatted}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
      const source = `      import { pattern, h } from "commonfabric";

      interface Item { name?: string; nested?: { value: number } }

      export default pattern<{ item: Item }>(({ item }) => {
        return <div>{item?.name} - {item?.nested?.value}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Optional chaining inside JSX should be allowed (OpaqueRefJSXTransformer handles it)",
      );
    },
  );

  await t.step(
    "errors on top-level optional call in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern((input) => input?.foo());
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:optional-chaining");
      assertEquals(
        errors.some((error) => error.message.includes("Optional chaining")),
        true,
        "Optional call diagnostics should explain the optional chaining restriction",
      );
    },
  );

  await t.step(
    "errors on statement-position optional call in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern((input) => {
        input?.foo();
        return {};
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:optional-chaining");
    },
  );

  await t.step(
    "errors on spread of pattern input outside computed()",
    async () => {
      const source = `      import { pattern, h } from "commonfabric";

      interface State {
        name: string;
        count: number;
      }

      export default pattern<State>((input) => {
        return { ...input };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const spreadErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );
      assertGreater(
        spreadErrors.length,
        0,
        "Spreading pattern input outside computed() should produce an error",
      );
      assertEquals(
        spreadErrors[0]!.message.includes("computed"),
        true,
        "Error should suggest using computed()",
      );
    },
  );

  await t.step("allows .get() calls inside JSX expressions", async () => {
    const source = `      import { pattern, Cell, h } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        return <div>Count: {count.get()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      ".get() inside JSX should be allowed (explicit opaque-path-terminal JSX owner handles it)",
    );
  });
});

Deno.test(
  "Pattern Context Validation - Destructuring and Structural Traversal",
  async (t) => {
    await t.step(
      "errors on rest destructuring in pattern params",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const p = pattern(({ foo, ...rest }) => <div>{foo}</div>);
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        const computationErrors = errors.filter((error) =>
          error.type === "pattern-context:computation"
        );

        assertEquals(computationErrors.length, 1);
        assertStringIncludes(
          computationErrors[0]!.message,
          "Rest destructuring",
        );
      },
    );

    await t.step(
      "allows array destructuring in pattern params",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const p = pattern(([first]) => <div>{first}</div>);
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        const computationErrors = errors.filter((error) =>
          error.type === "pattern-context:computation"
        );

        assertEquals(computationErrors.length, 0);
      },
    );

    await t.step(
      "errors on Object.keys/values/entries over pattern input",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const p = pattern((input) => {
        Object.keys(input);
        Object.values(input);
        Object.entries(input);
        return input;
      });
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        const computationErrors = errors.filter((error) =>
          error.type === "pattern-context:computation"
        );

        assertGreater(computationErrors.length, 2);
      },
    );

    await t.step(
      "errors on dynamic key access over pattern input",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const p = pattern((input, key: string) => input[key]);
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        const computationErrors = errors.filter((error) =>
          error.type === "pattern-context:computation"
        );

        assertGreater(computationErrors.length, 0);
      },
    );

    await t.step("allows known symbol key access", async () => {
      const source = `      import { NAME, UI, pattern } from "commonfabric";

      const p = pattern(({ items }) =>
        items.map((item) => ({ n: item[NAME], u: item[UI] }))
      );
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const computationErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );

      assertEquals(computationErrors.length, 0);
    });

    await t.step("allows SELF destructuring key", async () => {
      const source = `      import { SELF, pattern } from "commonfabric";

      const p = pattern(({ [SELF]: self, value }) => self);
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const computationErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );

      assertEquals(computationErrors.length, 0);
    });

    await t.step("errors on for..in over pattern input", async () => {
      const source = `      import { pattern } from "commonfabric";

      const p = pattern((input) => {
        for (const key in input) {
          key;
        }
        return input;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const computationErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );

      assertGreater(computationErrors.length, 0);
    });

    await t.step(
      "allows JSON.stringify over pattern input in return position",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const p = pattern((input) => JSON.stringify(input));
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        const computationErrors = errors.filter((error) =>
          error.type === "pattern-context:computation"
        );

        assertEquals(computationErrors.length, 0);
      },
    );
  },
);

Deno.test("Pattern Context Validation - Statement Boundaries", async (t) => {
  await t.step(
    "errors on let declaration in top-level pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        let display = count;
        return display;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:let-declaration");
    },
  );

  await t.step(
    "errors on loop in top-level pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern(() => {
        const values: number[] = [];
        for (let i = 0; i < 3; i++) {
          values.push(i);
        }
        return values;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:loop");
    },
  );

  await t.step(
    "errors on early return in top-level pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ flag: boolean }>(({ flag }) => {
        if (flag) {
          return "yes";
        }
        return "no";
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:early-return");
    },
  );

  await t.step(
    "errors on let declaration in pattern-owned map callback",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        return items.map((item) => {
          let upper = item.toUpperCase();
          return upper;
        });
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:let-declaration");
    },
  );

  await t.step(
    "errors on loop in pattern-owned map callback",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        return items.map((item) => {
          const chars: string[] = [];
          for (const char of item) {
            chars.push(char);
          }
          return chars.join("-");
        });
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:loop");
    },
  );

  await t.step(
    "allows early return inside computed callback",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ flag: boolean }>(({ flag }) => {
        return computed(() => {
          if (flag) {
            return "yes";
          }
          return "no";
        });
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "computed() callbacks should retain their own control-flow semantics",
      );
    },
  );

  await t.step(
    "errors on reassignment in top-level pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      let lastSeen = "";

      export default pattern<{ name: string }>(({ name }) => {
        lastSeen = name;
        return lastSeen;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:assignment");
    },
  );

  await t.step(
    "allows let and loops inside computed map callback",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        return computed(() =>
          items.map((item) => {
            let total = "";
            for (const char of item) {
              total += char;
            }
            return total;
          })
        );
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "compute-owned callbacks should keep imperative local control flow",
      );
    },
  );

  await t.step(
    "allows let inside plain array callback in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern(() => {
        const items = ["a", "b"];
        return items.map((item) => {
          let upper = item.toUpperCase();
          return upper;
        });
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "plain array callbacks should stay outside the pattern-owned statement boundary",
      );
    },
  );

  await t.step(
    "allows reassignment inside computed callback",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        const next = computed(() => {
          let total = 0;
          total = count + 1;
          return total;
        });
        return next;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "computed() callbacks should still allow local reassignment",
      );
    },
  );

  await t.step(
    "errors on var declaration in top-level pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        var display = count;
        return display;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:var-declaration");
    },
  );

  await t.step(
    "errors on block-scoped early return inside pattern-owned nested map callback",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface State {
        sections: { tasks: { label: string }[]; tags: { name: string }[] }[];
      }

      export default pattern<State>((state) => ({
        [UI]: (
          <div>
            {state.sections.map((section) => {
              if (!section.tags.length) return <div />;
              {
                const tasks = section.tasks;
                return (
                  <div>
                    {section.tags.map((tag) => (
                      <span>{tag.name}:{tasks.length}</span>
                    ))}
                  </div>
                );
              }
            })}
          </div>
        ),
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:early-return");
    },
  );
});

Deno.test(
  "Pattern Context Validation - Lowerable Non-JSX Expression Sites",
  async (t) => {
    await t.step(
      "allows top-level call-argument ternary in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const identity = <T,>(value: T) => value;

      export default pattern<{ done: boolean }>((state) => {
        const label = identity(state.done ? "Done" : "Pending");
        return { label };
      });
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level object-property logical-or in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      export default pattern<{ label?: string }>((state) => ({
        label: state.label || "Pending",
      }));
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level call-argument property access in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const identity = <T,>(value: T) => value;

      export default pattern<{ user: { name: string } }>((state) => {
        const label = identity(state.user.name);
        return { label };
      });
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level object-property arithmetic in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      export default pattern<{ count: number }>((state) => ({
        next: state.count + 1,
      }));
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level object-property nullish coalescing in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      export default pattern<{ label?: string | null }>((state) => ({
        label: state.label ?? "Pending",
      }));
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level return-expression optional property access in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      export default pattern<{ user?: { name: string } }>((state) =>
        state.user?.name
      );
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level call-argument optional property access in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      const identity = <T,>(value: T) => value;

      export default pattern<{ user?: { name: string } }>((state) => {
        const label = identity(state.user?.name);
        return { label };
      });
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );

    await t.step(
      "allows top-level object-property optional element access in pattern body",
      async () => {
        const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items?: string[] }>((state) => ({
        first: state.items?.[0],
      }));
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertEquals(errors.length, 0);
      },
    );
  },
);

Deno.test("Pattern Context Validation - Destructuring Defaults", async (t) => {
  await t.step(
    "errors on non-static default initializer destructuring",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      const fallback = "fallback";

      export default pattern(({ foo = fallback }) => <div>{foo}</div>);
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const computationErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );

      assertEquals(computationErrors.length, 1);
      assertStringIncludes(
        computationErrors[0]!.message,
        "Non-static destructuring initializers",
      );
    },
  );

  await t.step(
    "errors on opaque local default destructuring",
    async () => {
      const source =
        `      import { computed, generateObject, pattern } from "commonfabric";

      export default pattern<{ messages: string[] }>(({ messages }) => {
        const preview = computed(() => messages[0] ?? "");
        const { result = { title: "fallback" } } = generateObject({
          prompt: preview,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        });
        return <div>{result.title}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const computationErrors = errors.filter((error) =>
        error.type === "pattern-context:computation"
      );

      assertEquals(computationErrors.length, 1);
      assertStringIncludes(
        computationErrors[0]!.message,
        "opaque local bindings",
      );
    },
  );
});

Deno.test("Pattern Context Validation - Receiver Method Calls", async (t) => {
  await t.step(
    "allows top-level object-property receiver method call in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ name: string }>((state) => ({
        upper: state.name.toUpperCase(),
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows top-level call-argument receiver method call in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      const identity = <T,>(value: T) => value;

      export default pattern<{ name: string }>((state) => {
        const upper = identity(state.name.trim());
        return { upper };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step("allows receiver method call inside JSX", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      export default pattern<{ name: string }>((state) => {
        return <div>{state.name.toUpperCase()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0);
  });

  await t.step("allows receiver method call inside computed()", async () => {
    const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ name: string }>((state) => {
        const upper = computed(() => state.name.toUpperCase());
        return { upper };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0);
  });

  await t.step(
    "allows receiver method call inside authored ifElse branch",
    async () => {
      const source = `      import { ifElse, pattern } from "commonfabric";

      export default pattern<{ name: string; show: boolean }>((state) => ({
        value: ifElse(state.show, state.name.trim(), "fallback"),
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows direct receiver-method root inside pattern-owned array-method callbacks",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        return items.map((item) => item.toUpperCase());
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows call-argument receiver-method root inside pattern-owned array-method callbacks",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      const identity = <T,>(value: T) => value;

      export default pattern<{ items: string[] }>(({ items }) => {
        return items.map((item) => identity(item.toUpperCase()));
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows receiver-method roots through aliased reactive array-method chains",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{ items: string[] }>((state) => {
        const inner = computed(() => state.items);
        const value = computed(() => {
          const foo = computed(() => inner);
          const filtered = foo.filter((item) => item.length > 1);
          return filtered.map((item) => item.toUpperCase());
        });
        return { value };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows opaque array receiver-method calls nested inside array-callback expressions when the enclosing expression is lowerable",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Person {
        name: string;
        spotPreferences: string[];
      }

      export default pattern<{ people: Person[] }>(({ people }) => ({
        [UI]: <ul>{people.map((person) => {
          const { name, spotPreferences } = person;
          return (
            <li>
              {spotPreferences.length > 0
                ? name + ": " + spotPreferences.join(", ")
                : name}
            </li>
          );
        })}</ul>,
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows the same opaque array receiver-method call when wrapped in computed()",
    async () => {
      const source =
        `      import { computed, pattern, UI } from "commonfabric";

      interface Person {
        spotPreferences: string[];
      }

      export default pattern<{ people: Person[] }>(({ people }) => ({
        [UI]: <ul>{people.map((person) => {
          const { spotPreferences } = person;
          return <li><span>{computed(() => spotPreferences.join(", "))}</span></li>;
        })}</ul>,
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "still errors on optional receiver-call root inside pattern-owned array-method callbacks",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items: Array<string | undefined> }>(({ items }) => {
        return items.map((item) => item?.toUpperCase());
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:optional-chaining");
    },
  );

  await t.step(
    "points body-level writes to a module-scope handler<>, not computed() (CT-1641)",
    async () => {
      const source =
        `      import { pattern, UI, Writable } from "commonfabric";

      interface Item { id: string; }
      interface State { items: Writable<Item[]>; }

      export default pattern<State>(({ items }) => {
        items.push({ id: "x" });
        return { [UI]: <div />, items };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected a not-lowerable error");
      const writeError = errors.find((e) =>
        e.message.includes("not lowerable")
      );
      assertEquals(
        writeError !== undefined,
        true,
        "Expected the not-lowerable diagnostic for the body-level push",
      );
      assertStringIncludes(writeError!.message, "module-scope handler<>");
      // The misleading remedy must NOT appear for a write.
      assertEquals(
        writeError!.message.includes("Move this call into computed()"),
        false,
        "Writes should not be told to move into computed()",
      );
    },
  );

  await t.step(
    "still suggests computed() for a non-write non-lowerable method call",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Item { label: string; }
      interface State { items: Item[]; }

      export default pattern<State>(({ items }) => {
        const s = items.toLocaleString();
        return { [UI]: <div>{s}</div>, items };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const methodError = errors.find((e) =>
        e.message.includes("not lowerable")
      );
      if (methodError) {
        assertStringIncludes(methodError.message, "computed()");
        assertEquals(
          methodError.message.includes("module-scope handler<>"),
          false,
          "Non-write methods should not be pointed at handler<>",
        );
      }
    },
  );
});

Deno.test("Pattern Context Validation - Safe Wrappers", async (t) => {
  await t.step("allows reading opaques inside computed()", async () => {
    const source = `      import { pattern, computed, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const isExpensive = computed(() => item.price > 100);
        return <div>{isExpensive}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside computed() should be allowed",
    );
  });

  await t.step("allows reading opaques inside action()", async () => {
    const source = `      import { pattern, action, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const logPrice = action(() => {
          console.log(item.price > 100 ? "expensive" : "cheap");
        });
        return <div onClick={logPrice}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside action() should be allowed",
    );
  });

  await t.step("allows reading opaques inside computed()", async () => {
    const source =
      `      import { pattern, computed, Cell, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item, discount: Cell<number> }>(({ item, discount }) => {
        const finalPrice = computed(() => item.price * (1 - discount.get()));
        return <div>{finalPrice}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Reading opaques inside computed() should be allowed",
    );
  });

  await t.step(
    "errors on lift() inside pattern (must be at module scope)",
    async () => {
      const source = `      import { pattern, lift, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "lift() inside pattern should error (must be at module scope)",
      );
      assertHasErrorType(errors, "pattern-context:builder-placement");
    },
  );

  await t.step(
    "errors on handler() inside pattern (must be at module scope)",
    async () => {
      const source = `      import { pattern, handler, h } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "handler() inside pattern should error (must be at module scope)",
      );
      assertHasErrorType(errors, "pattern-context:builder-placement");
    },
  );

  await t.step(
    "allows reading opaques inside inline JSX event handlers",
    async () => {
      const source = `      import { pattern, Cell, h } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
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
      const source = `      import { pattern, computed, h } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "Function declarations in pattern should error (must be at module scope)",
      );
      assertHasErrorType(errors, "pattern-context:function-creation");
    },
  );

  await t.step(
    "errors on standalone arrow functions in pattern (must be at module scope)",
    async () => {
      const source = `      import { pattern, computed, h } from "commonfabric";

      interface Item { name: string; price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        // Helper arrow function defined in pattern - now an error
        const isExpensive = () => item.price > 100;

        const expensive = computed(() => isExpensive());
        return <div>{expensive}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(
        errors.length,
        0,
        "Arrow functions in pattern should error (must be at module scope)",
      );
      assertHasErrorType(errors, "pattern-context:function-creation");
    },
  );
});

Deno.test("Computed local reactive alias validation", async (t) => {
  await t.step(
    "errors on truthiness checks of locally created computed results",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const foo = computed(() => true);
          if (foo) {
            return 1;
          }
          return 0;
        });

        return outer;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "compute-context:local-reactive-use");
    },
  );

  await t.step(
    "errors on arithmetic using a locally created computed result",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const foo = computed(() => 21);
          return foo * 2;
        });

        return outer;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "compute-context:local-reactive-use");
    },
  );

  await t.step(
    "allows nested computed callbacks to use locally created computed results",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const outer = computed(() => {
          const foo = computed(() => 21);
          const doubled = computed(() => foo * 2);
          return doubled;
        });

        return outer;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows later computed callbacks to use outer computed results",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const foo = computed(() => 21);
        const outer = computed(() => foo * 2);

        return outer;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );
});

Deno.test("Diagnostic output format", async (t) => {
  await t.step("includes source location information", async () => {
    const source = `
      import { OpaqueRef } from "commonfabric";

      const data = {} as unknown as OpaqueRef<any>;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
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
    const source = `      import { pattern, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const helper = () => item.price * 2;
        return <div>{helper()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:function-creation");
  });

  await t.step("errors on function expression in pattern body", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const helper = function() { return item.price * 2; };
        return { UI: <div>{helper()}</div> };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:function-creation");
  });

  await t.step("errors on function declaration in pattern body", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        function helper() { return item.price * 2; }
        return <div>{helper()}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:function-creation");
  });

  await t.step("allows arrow function inside computed()", async () => {
    const source = `      import { pattern, computed, h } from "commonfabric";

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
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Arrow function inside computed() should be allowed",
    );
  });

  await t.step("allows arrow function inside action()", async () => {
    const source = `      import { pattern, action, h } from "commonfabric";

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
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Arrow function inside action() should be allowed",
    );
  });

  await t.step("allows inline JSX event handler", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        return <div onClick={() => console.log(item.price)}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Inline JSX event handler should be allowed",
    );
  });

  await t.step("allows map callback inside JSX", async () => {
    const source = `      import { pattern, h, OpaqueRef } from "commonfabric";

      interface Item { name: string; }

      export default pattern<{ items: OpaqueRef<Item[]> }>(({ items }) => {
        return <div>{items.map(item => <span>{item.name}</span>)}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Map callback inside JSX should be allowed");
  });

  await t.step("allows value-returning array callback inside JSX", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      interface Item { id: number; name: string; }

      export default pattern<{ items: Item[] }>(({ items }) => {
        return <div>{items.find((item) => item.id === 1)?.name}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Value-returning array callbacks inside JSX should be allowed",
    );
  });

  await t.step("errors on foreign callback container inside JSX", async () => {
    const source = `      import { pattern, h } from "commonfabric";

      export default pattern<{ list: string[] }>(({ list }) => {
        return <div>{[0, 1].forEach(() => list.map((item) => item))}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:callback-container");
  });

  await t.step("allows map callback outside JSX in pattern body", async () => {
    const source = `      import { pattern, OpaqueRef } from "commonfabric";

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
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Map callback outside JSX in pattern should be allowed (transformed to pattern)",
    );
  });

  await t.step(
    "allows arithmetic computation inside authored ifElse branches",
    async () => {
      const source = `      import { ifElse, pattern } from "commonfabric";

      export default pattern<{ count: number; show: boolean }>(({ count, show }) => {
        return {
          value: ifElse(show, count + 1, 0),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Arithmetic inside authored ifElse branches should be owned by helper rewriting",
      );
    },
  );

  await t.step(
    "allows nested map/filter callbacks inside module-scope helpers",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      interface Entry {
        label: string;
        score: number;
      }

      const normalize = (entries: Entry[]) =>
        entries
          .map((entry) => ({
            label: entry.label.trim(),
            score: entry.score,
          }))
          .filter((entry) => entry.score > 0);

      export default pattern<{ entries: Entry[] }>(({ entries }) => {
        const normalized = normalize(entries);
        return { normalized };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const creationErrors = errors.filter((error) =>
        error.type === "pattern-context:function-creation"
      );
      assertEquals(
        creationErrors.length,
        0,
        "Callbacks in standalone helpers should not be flagged as pattern-context function creation",
      );
    },
  );

  await t.step(
    "errors on class expression with reactive-capturing method in pattern body",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      interface Auth { token?: string }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        const C = class { read() { return value?.token; } };
        return { C };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:function-creation");
    },
  );

  await t.step("errors on class declaration in pattern body", async () => {
    const source = `      import { pattern } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        class Helper { double() { return item.price * 2; } }
        return { Helper };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:function-creation");
  });

  await t.step("allows class expression inside computed()", async () => {
    const source = `      import { pattern, computed } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = computed(() => {
          const Doubler = class { run() { return item.price * 2; } };
          return new Doubler().run();
        });
        return { doubled };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Class expression inside computed() should be allowed",
    );
  });

  await t.step("allows class at module scope", async () => {
    const source = `      import { pattern } from "commonfabric";

      interface Item { price: number; }

      class Doubler {
        constructor(private price: number) {}
        run() { return this.price * 2; }
      }

      export default pattern<{ item: Item }>(({ item }) => {
        return { item };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Class declared at module scope should be allowed",
    );
  });

  await t.step(
    "a standalone function const is still pattern-context:function-creation",
    async () => {
      const source = `      import { pattern, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const helper = () => item.price * 2;
        return <div>{helper()}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "pattern-context:function-creation");
      assertEquals(
        errors.filter((e) => e.type === "pattern-context:object-member")
          .length,
        0,
      );
    },
  );
});

Deno.test("Pattern Context Validation - Object Members", async (t) => {
  const memberErrors = (diagnostics: readonly TransformationDiagnostic[]) =>
    getErrors(diagnostics).filter((e) =>
      e.type === "pattern-context:object-member"
    );

  // The reactive value `value` is captured by every member body below; the
  // rule rejects the whole member regardless of how the body reads it.
  const withReactiveLocal = (memberSource: string, returns = "api") =>
    `      import { computed, pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        const api = ${memberSource};
        return ${returns};
      });
    `;

  await t.step(
    "errors on a method, naming the unstorable-function reason",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ read() { return value?.token; } }"),
        { types: COMMONFABRIC_TYPES },
      );
      const errs = memberErrors(diagnostics);
      assertEquals(errs.length, 1);
      assertStringIncludes(
        errs[0]!.message,
        "function value, which the reactive data model cannot store",
      );
      assertStringIncludes(errs[0]!.message, "handler()");
    },
  );

  await t.step(
    "errors on a getter, naming the serialization-snapshot reason",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ get t() { return value?.token; } }"),
        { types: COMMONFABRIC_TYPES },
      );
      const errs = memberErrors(diagnostics);
      assertEquals(errs.length, 1);
      assertStringIncludes(
        errs[0]!.message,
        "evaluated when the pattern result is stored",
      );
      assertStringIncludes(errs[0]!.message, "one-time snapshot");
    },
  );

  await t.step("errors on a setter, advising handler()", async () => {
    const source = `      import { pattern } from "commonfabric";

      export default pattern<{ name: string }>(({ name }) => {
        const api = { set label(v: string) { v.trim(); } };
        return api;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errs = memberErrors(diagnostics);
    assertEquals(errs.length, 1);
    assertStringIncludes(errs[0]!.message, "A setter on an object literal");
    assertStringIncludes(errs[0]!.message, "module-scope handler()");
  });

  await t.step(
    "errors on a toJSON() method with the serialization reason",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ toJSON() { return value?.token; } }"),
        { types: COMMONFABRIC_TYPES },
      );
      const errs = memberErrors(diagnostics);
      assertEquals(errs.length, 1);
      assertStringIncludes(
        errs[0]!.message,
        "toJSON() member on an object literal",
      );
      assertStringIncludes(
        errs[0]!.message,
        "runs when the pattern result is stored",
      );
    },
  );

  await t.step(
    "a toJSON property (arrow) gets the serialization message, not unstorable",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ toJSON: () => value?.token }"),
        { types: COMMONFABRIC_TYPES },
      );
      const errs = memberErrors(diagnostics);
      assertEquals(errs.length, 1);
      assertStringIncludes(
        errs[0]!.message,
        "toJSON() member on an object literal",
      );
      assertStringIncludes(
        errs[0]!.message,
        "runs when the pattern result is stored",
      );
    },
  );

  await t.step("errors on a function-valued property (arrow)", async () => {
    const { diagnostics } = await validateSource(
      withReactiveLocal("{ read: () => value?.token }"),
      { types: COMMONFABRIC_TYPES },
    );
    const errs = memberErrors(diagnostics);
    assertEquals(errs.length, 1);
    assertStringIncludes(
      errs[0]!.message,
      "A function-valued property on an object literal",
    );
  });

  await t.step("errors on a function-expression-valued property", async () => {
    const { diagnostics } = await validateSource(
      withReactiveLocal("{ read: function () { return value?.token; } }"),
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(memberErrors(diagnostics).length, 1);
  });

  await t.step(
    "errors on a returned-object member as well as a local one",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { computed, pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        return { read() { return value?.token; } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // The rule ignores the body, so reactive reads laundered through these shapes
  // are caught without a body scanner.
  await t.step(
    "errors regardless of how the body reads the reactive value",
    async () => {
      const bodies = [
        "{ get t() { const { token } = value; return token; } }", // destructuring
        "{ read() { return { ...value }; } }", // spread
        `{ ["read"]() { return value?.token; } }`, // computed member name
        "{ read(a = value?.token) { return a; } }", // parameter default
      ];
      for (const body of bodies) {
        const { diagnostics } = await validateSource(
          withReactiveLocal(body),
          { types: COMMONFABRIC_TYPES },
        );
        assertEquals(
          memberErrors(diagnostics).length,
          1,
          `expected an object-member error for ${body}`,
        );
      }
    },
  );

  // Closing the JSX hole: an object-literal member function in a JSX data
  // position is not lowered there and is rejected, but JSX event handlers and
  // render/array-method callbacks stay legal.
  await t.step("errors on a function-valued property inside JSX", async () => {
    const { diagnostics } = await validateSource(
      `      import { computed, pattern, h } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        return <div data-x={{ read: () => value?.token }} />;
      });
    `,
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(memberErrors(diagnostics).length, 1);
  });

  await t.step("allows a JSX event handler arrow", async () => {
    const { diagnostics } = await validateSource(
      `      import { pattern, h } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => {
        return <button onClick={() => console.log(n)}>x</button>;
      });
    `,
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(getErrors(diagnostics).length, 0);
  });

  await t.step("allows a JSX array-method render callback", async () => {
    const { diagnostics } = await validateSource(
      `      import { pattern, h, OpaqueRef } from "commonfabric";

      interface Item { name: string; }

      export default pattern<{ items: OpaqueRef<Item[]> }>(({ items }) => {
        return <div>{items.map((item) => <span>{item.name}</span>)}</div>;
      });
    `,
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(getErrors(diagnostics).length, 0);
  });

  await t.step(
    "allows a plain reactive property read (it lowers)",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ token: value?.token }", "api"),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(getErrors(diagnostics).length, 0);
    },
  );

  await t.step("allows an object member inside computed()", async () => {
    const { diagnostics } = await validateSource(
      `      import { computed, pattern, h } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => {
        const doubled = computed(() => {
          const helper = { calc() { return n * 2; } };
          return helper.calc();
        });
        return <div>{doubled}</div>;
      });
    `,
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(memberErrors(diagnostics).length, 0);
  });

  await t.step("allows object members at module scope", async () => {
    const { diagnostics } = await validateSource(
      `      import { computed, pattern } from "commonfabric";

      interface Auth { token?: string; }

      const helpers = { double(n: number) { return n * 2; } };

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        return { token: value?.token };
      });
    `,
      { types: COMMONFABRIC_TYPES },
    );
    assertEquals(memberErrors(diagnostics).length, 0);
  });

  // A class in pattern context is flagged by pattern-context:function-creation
  // (the class rule), not by the object-member rule — object-member is scoped to
  // object-literal members. This pins the division between the two diagnostics.
  await t.step(
    "flags a class via function-creation, not via object-member",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { computed, pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        const Api = class { read() { return value?.token; } };
        return { Api };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
      assertHasErrorType(
        getErrors(diagnostics),
        "pattern-context:function-creation",
      );
    },
  );

  // A function-valued property may be wrapped in transparent expressions
  // (parentheses, `as`, `satisfies`, `!`, `<T>`) before the property assignment.
  // The wrapped spelling is the same member and reports object-member, not
  // function-creation, in and out of JSX.
  await t.step(
    "reports object-member for transparently-wrapped function properties",
    async () => {
      const wrapped = [
        "{ read: (() => value?.token) as () => string | undefined }", // as-cast
        "{ read: (() => value?.token) }", // parentheses
        "{ read: (() => value?.token) satisfies () => string | undefined }", // satisfies
        "{ read: (() => value?.token)! }", // non-null
      ];
      for (const member of wrapped) {
        const { diagnostics } = await validateSource(
          withReactiveLocal(member),
          { types: COMMONFABRIC_TYPES },
        );
        assertEquals(
          memberErrors(diagnostics).length,
          1,
          `expected one object-member error for ${member}`,
        );
        const types = getErrors(diagnostics).map((e) => e.type);
        assertEquals(
          types.includes("pattern-context:function-creation"),
          false,
          `wrapped property should not report function-creation for ${member}`,
        );
      }
    },
  );

  await t.step(
    "reports object-member for a wrapped function property inside JSX",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { computed, pattern, h } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        return <div data-x={{ read: (() => value?.token) as () => string | undefined }}>x</div>;
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // A toJSON member is storable (the data model converts a toJSON-bearing
  // object), so a pure toJSON that reads no reactive value is allowed, while one
  // that reads a reactive value still freezes a snapshot and is reported.
  await t.step(
    "allows a pure toJSON() member with no reactive read",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => {
        return { v: n, toJSON() { return { v: 1 }; } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
    },
  );

  await t.step(
    "allows a pure toJSON property (arrow) with no reactive read",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => {
        return { v: n, toJSON: () => ({ v: 1 }) };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
    },
  );

  await t.step(
    "still flags a toJSON() member that reads a reactive value",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ toJSON() { return { t: value?.token }; } }"),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // The toJSON body check follows reactive values laundered through plain local
  // bindings (a destructured parameter, a re-alias) and reads of an outer
  // pattern value from a toJSON nested in a callback.
  await t.step(
    "flags a toJSON() that reads a destructured pattern parameter",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>((props) => {
        const { auth } = props;
        return { v: 1, toJSON() { return { t: auth?.token }; } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  await t.step(
    "flags a toJSON() nested in a callback that reads an outer pattern value",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth; items: number[] }>(
        ({ auth, items }) => {
          return {
            rows: items.map((x) => ({ x, toJSON() { return { t: auth }; } })),
          };
        },
      );
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // Reactive roots are matched by symbol, so a toJSON parameter that shadows an
  // input name reads its own non-reactive value and is not flagged.
  await t.step(
    "allows a toJSON() whose own parameter shadows an input name",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        return { v: 1, toJSON(auth: string = "x") { return { t: auth }; } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
    },
  );

  // A nested callback's own parameter is not a reactive root, so reading a plain
  // element of a non-reactive array literal in a toJSON is not flagged.
  await t.step(
    "allows a toJSON() that reads a plain non-reactive array element",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => {
        const plain = [1, 2, 3];
        return {
          v: n,
          rows: plain.map((x) => ({ x, toJSON() { return { y: x }; } })),
        };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
    },
  );

  // A function inside an object literal passed as a JSX prop is an unstorable
  // member, the same as in a result object — no catalog component accepts an
  // object-of-functions prop, so this rejection is intended, not a false
  // positive.
  await t.step(
    "rejects an object-of-handlers passed as a JSX prop value",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { computed, pattern, h } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Auth }>(({ auth }) => {
        const value = computed(() => auth);
        return <div data-x={{ onClick: () => value?.token }}>x</div>;
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // A member named by a string literal is matched the same as an identifier
  // name.
  await t.step(
    "flags a method whose name is a string literal",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal(`{ "read"() { return value?.token; } }`),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // A member whose name is a non-static computed expression cannot be resolved
  // to `toJSON`, so it takes the unstorable-method path.
  await t.step(
    "flags a method whose name is a computed expression",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal("{ [1 + 1]() { return value?.token; } }"),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // A pattern with no inputs has no reactive roots, so a toJSON in its result
  // reads nothing reactive and is allowed.
  await t.step(
    "allows a toJSON() in a pattern that has no inputs",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { pattern } from "commonfabric";

      export default pattern(() => {
        return { v: 1, toJSON() { return { v: 1 }; } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 0);
    },
  );

  // A toJSON that reads a reactive input through a `.get()` call is a reactive
  // read and is flagged.
  await t.step(
    "flags a toJSON() that reads a reactive input via .get()",
    async () => {
      const { diagnostics } = await validateSource(
        `      import { Cell, pattern } from "commonfabric";

      interface Auth { token?: string; }

      export default pattern<{ auth: Cell<Auth> }>(({ auth }) => {
        return { toJSON() { return auth.get(); } };
      });
    `,
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );

  // A toJSON body is walked past nested functions, and the reactive read it
  // does contain is found even when it is not the last node in the body.
  await t.step(
    "flags a toJSON() with a nested function and a reactive read before more statements",
    async () => {
      const { diagnostics } = await validateSource(
        withReactiveLocal(
          "{ toJSON() { const f = () => 1; const a = value?.token; return { a, b: 1 }; } }",
        ),
        { types: COMMONFABRIC_TYPES },
      );
      assertEquals(memberErrors(diagnostics).length, 1);
    },
  );
});

Deno.test("Pattern Context Validation - Builder Placement", async (t) => {
  await t.step("errors on lift() inside pattern body", async () => {
    const source = `      import { pattern, lift, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:builder-placement");
  });

  await t.step(
    "errors on lift() immediately invoked with computed suggestion",
    async () => {
      const source = `      import { pattern, lift, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = lift(({ x }: { x: number }) => x * 2)({ x: item.price });
        return <div>{doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:builder-placement");
      assertEquals(
        errors[0]!.message.includes("computed"),
        true,
        "Error should suggest using computed()",
      );
    },
  );

  await t.step("errors on handler() inside pattern body", async () => {
    const source = `      import { pattern, handler, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const onClick = handler(() => console.log(item.price));
        return { UI: <div onClick={onClick}>Click</div> };
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertHasErrorType(errors, "pattern-context:builder-placement");
  });

  await t.step(
    "does not report builder placement for shadowed lift helper",
    async () => {
      const source = `      import { pattern, h } from "commonfabric";

      const lift = (fn: () => number) => fn();

      export default pattern(() => {
        const doubled = lift(() => 1);
        return <div>{doubled}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.some((error) =>
          error.type === "pattern-context:builder-placement"
        ),
        false,
        "shadowed local helpers named lift should not be treated as builder calls",
      );
    },
  );

  await t.step("errors on aliased lift() inside pattern body", async () => {
    const source = `      import { pattern, lift, h } from "commonfabric";

      interface Item { price: number; }

      const alias = lift;

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = alias(({ x }: { x: number }) => x * 2)({ x: item.price });
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(
      errors.some((error) =>
        error.type === "pattern-context:builder-placement"
      ),
      true,
      "aliases to lift() should still obey module-scope placement rules",
    );
  });

  await t.step("allows lift() at module scope", async () => {
    const source = `      import { pattern, lift, h } from "commonfabric";

      interface Item { price: number; }

      const doublePrice = lift((price: number) => price * 2);

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = doublePrice(item.price);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "lift() at module scope should be allowed");
  });

  await t.step("allows handler() at module scope", async () => {
    const source = `      import { pattern, handler, h } from "commonfabric";

      interface Item { price: number; }

      const logPrice = handler((price: number) => console.log(price));

      export default pattern<{ item: Item }>(({ item }) => {
        return <div onClick={() => logPrice(item.price)}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "handler() at module scope should be allowed",
    );
  });

  await t.step("allows computed() inside pattern", async () => {
    const source = `      import { pattern, computed, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const doubled = computed(() => item.price * 2);
        return <div>{doubled}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "computed() inside pattern should be allowed",
    );
  });

  await t.step("allows action() inside pattern", async () => {
    const source = `      import { pattern, action, h } from "commonfabric";

      interface Item { price: number; }

      export default pattern<{ item: Item }>(({ item }) => {
        const log = action(() => console.log(item.price));
        return <div onClick={log}>Click</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "action() inside pattern should be allowed");
  });
});

Deno.test("OpaqueRef .get() Validation", async (t) => {
  await t.step(
    "errors on .get() called on computed result",
    async () => {
      const source = `      import { pattern, computed } from "commonfabric";

      export default pattern<{ foo: number }>(({ foo }) => {
        const bar = computed(() => foo + 1);
        const baz = computed(() => bar.get() + 1);
        return { result: baz };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "opaque-get:invalid-call");
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
      const source = `      import { pattern, computed } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        const count = computed(() => items.get().length);
        return { count };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "opaque-get:invalid-call");
    },
  );

  await t.step(
    "allows .get() on Writable pattern input",
    async () => {
      const source =
        `      import { pattern, computed, Writable } from "commonfabric";

      export default pattern<{ count: Writable<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
    "errors on top-level .get() on Writable path in pattern body",
    async () => {
      const source = `      import { pattern, Writable } from "commonfabric";

      export default pattern((input: Writable<{ count: number; label: string }>) =>
        input.key("count").get()
      );
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:get-call");
    },
  );

  await t.step(
    "allows .get() on Writable feeding a computation at a binding (auto-wrapped)",
    async () => {
      const source = `      import { pattern, Writable } from "commonfabric";

      export default pattern<{ layout: Writable<string> }>(({ layout }) => {
        const len = layout.get().trim().length;
        return { len };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "binding-site .get() feeding a computation is auto-wrapped, not an error",
      );
    },
  );

  await t.step(
    "allows .get() on Cell pattern input",
    async () => {
      const source =
        `      import { pattern, computed, Cell } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
    "allows nested .get() on Cell<Cell<string>> pattern input",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, computed, Cell } from "commonfabric";

      export default pattern<{ nested: Cell<Cell<string>> }>(({ nested }) => {
        const upper = computed(() => nested.get().get().toUpperCase());
        return { upper };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "nested .get() on Cell<Cell<string>> should be allowed",
      );
    },
  );

  await t.step(
    "allows .get() on Writable inside authored ifElse branch",
    async () => {
      const source =
        `      import { pattern, ifElse, Writable } from "commonfabric";

      export default pattern<{ count: Writable<number>; show: boolean }>((
        { count, show },
      ) => {
        return { value: ifElse(show, count.get(), 0) };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        ".get() on Writable inside authored ifElse should be allowed",
      );
    },
  );

  await t.step(
    "still errors on opaque .get() inside authored ifElse branch",
    async () => {
      const source = `      import { pattern, ifElse } from "commonfabric";

      export default pattern<{ items: string[]; show: boolean }>((
        { items, show },
      ) => {
        return { value: ifElse(show, items.get(), []) };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "opaque-get:invalid-call");
      assertHasErrorType(errors, "pattern-context:get-call");
    },
  );

  await t.step(
    "errors on statement-position .get() in pattern body",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ items: string[] }>(({ items }) => {
        items.get();
        return {};
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern-context:get-call");
    },
  );

  await t.step(
    "allows direct access on computed result (correct usage)",
    async () => {
      const source = `      import { pattern, computed } from "commonfabric";

      export default pattern<{ foo: number }>(({ foo }) => {
        const bar = computed(() => foo + 1);
        const baz = computed(() => bar + 1);
        return { result: baz };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Direct access on computed result should be allowed",
      );
    },
  );

  await t.step(
    "does not report opaque-get on Cell lift callback input",
    async () => {
      const source = `      import { lift, Cell } from "commonfabric";

      const readCount = lift<{ count: Cell<number> }>(({ count }) => {
        return count.get();
      });

      export default readCount;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.some((error) => error.type === "opaque-get:invalid-call"),
        false,
        "lift() callback inputs should keep their declared Cell semantics",
      );
    },
  );

  await t.step(
    "does not report opaque-get on Cell handler callback state",
    async () => {
      const source = `      import { handler, Cell } from "commonfabric";

      const increment = handler<unknown, { count: Cell<number> }>((
        _,
        { count },
      ) => {
        count.set(count.get() + 1);
      });

      export default increment;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.some((error) => error.type === "opaque-get:invalid-call"),
        false,
        "handler() callback state should keep declared Cell semantics",
      );
    },
  );

  await t.step(
    "errors on .get() called on lifted factory result",
    async () => {
      const source = `      import { lift } from "commonfabric";

      const addOne = lift<{ count: number }>(({ count }) => count + 1);
      const result = addOne({ count: 1 });
      const value = result.get();

      export default value;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "opaque-get:invalid-call");
    },
  );

  await t.step(
    "errors on .get() called on generateText result",
    async () => {
      const source = `      import { generateText } from "commonfabric";

      const text = generateText({ prompt: "hi" });
      const value = text.get();

      export default value;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "opaque-get:invalid-call");
    },
  );

  await t.step(
    "does not report opaque-get on same-named local helper result",
    async () => {
      const source = `      function generateText() {
        return { get: () => "hi" };
      }

      const text = generateText();
      const value = text.get();

      export default value;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.some((error) => error.type === "opaque-get:invalid-call"),
        false,
        "local helpers should not be classified as reactive origins by name",
      );
    },
  );
});

Deno.test("Pattern Context Validation - Fallback Array Methods", async (t) => {
  await t.step(
    "allows .map() after ?? [] fallback with reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows .map() after ?? [] fallback with cast-wrapped reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Item {
        id: string;
      }

      export default pattern<{ items?: Item[] }>(({ items }) => ({
        [UI]: <div>{((items as Item[] | undefined) ?? []).map((item) => item.id)}</div>,
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
        diagnostic.type === "pattern-context:map-on-fallback"
      );
      assertEquals(fallbackDiagnostics.length, 0);
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows .map() after ?? [] fallback with satisfies-wrapped reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Item {
        id: string;
      }

      export default pattern<{ items?: Item[] }>(({ items }) => ({
        [UI]: <div>{((items satisfies Item[] | undefined) ?? []).map((item) => item.id)}</div>,
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const fallbackDiagnostics = diagnostics.filter((diagnostic) =>
        diagnostic.type === "pattern-context:map-on-fallback"
      );
      assertEquals(fallbackDiagnostics.length, 0);
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows .map() after || [] fallback with reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "allows .map() after ?? [] fallback without fallback-specific diagnostics",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
      });
      const fallbackErrors = getErrors(diagnostics).filter((error) =>
        error.type === "pattern-context:map-on-fallback"
      );
      assertEquals(fallbackErrors.length, 0);
    },
  );

  await t.step(
    "allows .filter() after ?? [] fallback with reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Item { name: string; }

      export default pattern<{ items?: Item[] }>(({ items }) => {
        return {
          [UI]: (
            <div>
              {(items ?? []).filter((item) => item.name.length > 0)}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const fallbackErrors = getErrors(diagnostics).filter((error) =>
        error.type === "pattern-context:map-on-fallback"
      );
      assertEquals(fallbackErrors.length, 0);
      assertEquals(getErrors(diagnostics).length, 0);
    },
  );

  await t.step(
    "allows .flatMap() after ?? [] fallback with reactive left side",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

      interface Item { name: string; }

      export default pattern<{ items?: Item[] }>(({ items }) => {
        return {
          [UI]: (
            <div>
              {(items ?? []).flatMap((item) => [item.name])}
            </div>
          ),
        };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const fallbackErrors = getErrors(diagnostics).filter((error) =>
        error.type === "pattern-context:map-on-fallback"
      );
      assertEquals(fallbackErrors.length, 0);
      assertEquals(getErrors(diagnostics).length, 0);
    },
  );

  await t.step(
    "allows .map() on direct property access (correct usage)",
    async () => {
      const source = `      import { pattern, UI } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
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
      const source = `      import { pattern, UI } from "commonfabric";

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
        types: COMMONFABRIC_TYPES,
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

Deno.test("Pattern Result Schema Inference", async (t) => {
  await t.step(
    "errors when pattern return type infers as any (one type arg)",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      declare function fetchAny(): any;

      export default pattern<{ prompt: string }>(({ prompt }) => {
        return fetchAny();
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern:any-result-schema");
    },
  );

  await t.step(
    "errors when pattern return type infers as any (no type args)",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      declare function fetchAny(): any;

      export default pattern(({ prompt }: { prompt: string }) => {
        return fetchAny();
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern:any-result-schema");
    },
  );

  await t.step(
    "errors when pattern return type infers as unknown",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      declare function fetchUnknown(): unknown;

      export default pattern<{ prompt: string }>(({ prompt }) => {
        return fetchUnknown();
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "pattern:any-result-schema");
    },
  );

  await t.step(
    "no error when pattern has explicit Output type",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      declare function fetchAny(): any;

      export default pattern<{ prompt: string }, string>(({ prompt }) => {
        const result = fetchAny();
        return result?.title || prompt;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Explicit Output type should prevent the error",
      );
    },
  );

  await t.step(
    "no error when pattern returns a concrete type",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      export default pattern<{ count: number }>(({ count }) => {
        return { doubled: count * 2 };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Concrete return type should not trigger error",
      );
    },
  );
});

Deno.test("Standalone Function Validation", async (t) => {
  await t.step(
    "errors on computed() inside standalone function",
    async () => {
      const source = `      import { computed, Cell } from "commonfabric";

      declare const count: Cell<number>;

      const helper = () => {
        return computed(() => count.get() * 2);
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "standalone-function:reactive-operation");
      assertEquals(
        errors[0]!.message.includes("computed()"),
        true,
        "Error should mention computed()",
      );
    },
  );

  const builderFactoryCases = [
    {
      name: "action()",
      imports: "action",
      body: `return action(() => {});`,
    },
    {
      name: "handler()",
      imports: "handler",
      body: `return handler((event: MouseEvent) => console.log(event));`,
    },
    {
      name: "lift()",
      imports: "lift",
      body: `return lift((value: number) => value * 2);`,
    },
    {
      name: "pattern()",
      imports: "pattern, h",
      body: `return pattern(() => <div />);`,
    },
  ] as const;

  for (const testCase of builderFactoryCases) {
    await t.step(
      `errors on ${testCase.name} inside standalone function`,
      async () => {
        const source =
          `      import { ${testCase.imports} } from "commonfabric";

      const helper = () => {
        ${testCase.body}
      };
    `;
        const { diagnostics } = await validateSource(source, {
          types: COMMONFABRIC_TYPES,
        });
        const errors = getErrors(diagnostics);
        assertGreater(errors.length, 0, "Expected at least one error");
        assertHasErrorType(errors, "standalone-function:reactive-operation");
        assertEquals(
          errors.some((error) => error.message.includes(testCase.name)),
          true,
          `Error should mention ${testCase.name}`,
        );
      },
    );
  }

  await t.step(
    "errors on .map() on reactive type inside standalone function",
    async () => {
      const source = `      import { cell } from "commonfabric";

      const items = cell(["a", "b", "c"]);

      const helper = () => {
        return items.map((item) => item.toUpperCase());
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertGreater(errors.length, 0, "Expected at least one error");
      assertHasErrorType(errors, "standalone-function:reactive-operation");
      assertEquals(
        errors[0]!.message.includes(".map()"),
        true,
        "Error should mention .map()",
      );
      assertEquals(
        errors[0]!.message.includes(".get().map(...)"),
        true,
        "Error should suggest explicit .get().map(...) workaround",
      );
    },
  );

  await t.step(
    "allows reactive operations in the pattern passed to patternTool()",
    async () => {
      const source =
        `      import { pattern, patternTool, computed, Cell } from "commonfabric";

      declare const multiplier: Cell<number>;

      const tool = patternTool(pattern(({ query }: { query: string }) => {
        return computed(() => query.length * multiplier.get());
      }));
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Reactive operations inside a patternTool's pattern should be allowed",
      );
    },
  );

  await t.step(
    "errors when patternTool's first argument is a bare callback",
    async () => {
      const source =
        `      import { patternTool, computed, Cell } from "commonfabric";

      declare const multiplier: Cell<number>;

      const tool = patternTool(({ query }: { query: string }) => {
        return computed(() => query.length * multiplier.get());
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(
        errors,
        "pattern-context:patterntool-requires-pattern",
      );
    },
  );

  await t.step(
    "keeps unresolved patternTool callbacks in compute context",
    async () => {
      const source = `      const helpers: Record<string, unknown> = {};

      const tool = (helpers.patternTool as (fn: (input: { value?: string }) => string | undefined) => unknown)(
        (input) => input?.value,
      );
      tool;
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const optionalErrors = errors.filter((error) =>
        error.type === "pattern-context:optional-chaining"
      );
      assertEquals(
        optionalErrors.length,
        0,
        "Callbacks passed to name-matched patternTool should not be treated as restricted pattern context",
      );
    },
  );

  await t.step(
    "does not treat shadowed local patternTool helpers as safe wrappers in pattern context",
    async () => {
      const source = `      import { pattern } from "commonfabric";

      const patternTool = <T,>(fn: T) => fn;

      export default pattern<{ value?: string }>((state) => {
        const tool = patternTool((input: { value?: string }) => input?.value);
        return state.value ?? tool;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "pattern-context:function-creation");
    },
  );

  await t.step(
    "allows plain array .map() inside standalone function",
    async () => {
      const source = `      const helper = () => {
        const items = ["a", "b", "c"];
        return items.map((item) => item.toUpperCase());
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
      const source = `      const helper = (x: number) => {
        return x * 2 + 10;
      };
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
      const source =
        `      import { pattern, computed, Cell } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const doubled = computed(() => count.get() * 2);
        return { doubled };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
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
      const source = `      import { computed, Cell } from "commonfabric";

      declare const count: Cell<number>;

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
        types: COMMONFABRIC_TYPES,
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

Deno.test("SES Callback Self-Containment Validation", async (t) => {
  await t.step(
    "errors when computed callback captures enclosing helper function",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          return computed(() => helper("x"));
        });
        return { label };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when computed callback captures forwarded enclosing helper function",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          const forwarded = helper;
          return computed(() => ({ helper: forwarded }));
        });
        return { label };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when computed callback captures forwarded function-typed pattern input",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern<{
        helper: (value: string) => string;
      }>(({ helper }) => {
        const label = computed(() => {
          return computed(() => ({ helper }));
        });
        return { label };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when action callback captures enclosing helper function",
    async () => {
      const source =
        `      import { action, computed, pattern } from "commonfabric";

      export default pattern(() => {
        const stream = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          return action(() => helper("x"));
        });
        return { stream };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when JSX event handler captures enclosing helper function",
    async () => {
      const source = `      import { computed, h, pattern } from "commonfabric";

      export default pattern(() => {
        const button = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          return <button onClick={() => helper("x")}>Click</button>;
        });
        return <div>{button}</div>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when patternTool callback captures enclosing helper function",
    async () => {
      const source =
        `      import { computed, pattern, patternTool } from "commonfabric";

      export default pattern(() => {
        const tool = computed(() => {
          const helper = (value: string) => value.toUpperCase();
          return patternTool(({ query }: { query: string }) => helper(query));
        });
        return { tool };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "errors when reactive map callback captures function-typed pattern input",
    async () => {
      const source = `      import { h, pattern } from "commonfabric";

      export default pattern<{
        items: string[];
        helper: (value: string) => string;
      }>(({ items, helper }) => {
        return <ul>{items.map((item) => <li>{helper(item)}</li>)}</ul>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertHasErrorType(errors, "ses-callback:callable-capture");
    },
  );

  await t.step(
    "allows computed callback to capture forwarded non-callable data",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      export default pattern(() => {
        const label = computed(() => {
          const value = "x";
          const forwarded = value;
          return computed(() => forwarded);
        });
        return { label };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics).filter((error) =>
        error.type === "ses-callback:callable-capture"
      );
      assertEquals(
        errors.length,
        0,
        "Forwarded non-callable data should remain valid callback state",
      );
    },
  );

  await t.step(
    "allows module-scope helper functions in callbacks",
    async () => {
      const source = `      import { computed, pattern } from "commonfabric";

      const helper = (value: string) => value.toUpperCase();

      export default pattern(() => {
        return { label: computed(() => helper("x")) };
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics).filter((error) =>
        error.type === "ses-callback:callable-capture"
      );
      assertEquals(
        errors.length,
        0,
        "Module-scope helpers should remain valid callback dependencies",
      );
    },
  );

  await t.step(
    "allows action callbacks to capture reactive state cells",
    async () => {
      const source =
        `      import { action, Cell, h, pattern } from "commonfabric";

      export default pattern<{ count: Cell<number> }>(({ count }) => {
        const increment = action(() => count.set(count.get() + 1));
        return <button onClick={increment}>Increment</button>;
      });
    `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics).filter((error) =>
        error.type === "ses-callback:callable-capture"
      );
      assertEquals(
        errors.length,
        0,
        "Schema-backed reactive state captures should not be rejected by the callable-capture validator",
      );
    },
  );
});

Deno.test("Inline reactive-root access diagnostic", async (t) => {
  await t.step(
    "does not flag identity-preserving methods on reactive-origin calls",
    async () => {
      // `new Writable(...).for(...)` is the standard cell-naming idiom — the
      // `.for(...)` call returns the same cell (identity-preserving), so this
      // shape is not the broken-reactivity pattern the diagnostic guards.
      const source = `
        import { pattern, Writable } from "commonfabric";

        export default pattern<Record<string, never>>(() => {
          const flag = new Writable(false).for("flag");
          return { flag };
        });
      `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const inlineErrors = getErrors(diagnostics).filter((d) =>
        d.type === "pattern-context:inline-reactive-root-access"
      );
      assertEquals(
        inlineErrors.length,
        0,
        "new Writable(...).for(...) should not trigger the inline-reactive-root diagnostic",
      );
    },
  );

  await t.step(
    "flags chains like wish(...).result.get() that read off the unwrapped value",
    async () => {
      // `wish(...).result.get()` is the broken shape: `.result` is plain JS
      // access that defeats reactivity, and `.get()` then tries to call a
      // method on the unwrapped value. The fact that `.get()` is a call
      // does not make this access site safe.
      const source = `
        import { pattern, wish } from "commonfabric";

        export default pattern<Record<string, never>>(() => {
          const broken = wish<{ result: number }>({ query: "/" }).result.get();
          return { broken };
        });
      `;
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const inlineErrors = getErrors(diagnostics).filter((d) =>
        d.type === "pattern-context:inline-reactive-root-access"
      );
      assertGreater(
        inlineErrors.length,
        0,
        "wish(...).result.get() should still trigger the inline-reactive-root diagnostic",
      );
    },
  );
});

Deno.test("Inline reactive-root chain rewrite", async (t) => {
  await t.step(
    "preserves cast wrappers around the call when rewriting one-line chains",
    async () => {
      // `(wish(...) as T).result` carries load-bearing type information in
      // the `as T` cast — downstream schema-injection / type-aware passes
      // rely on it. The rewrite must keep the cast attached to the call so
      // the destructure form sees the same type.
      const source = `
        import { pattern, wish } from "commonfabric";

        type ResultShape = { allPieces: { id: string }[] };

        export default pattern<Record<string, never>>(() => {
          const { allPieces } =
            (wish({ query: "/" }) as { result: ResultShape }).result;
          return { count: allPieces.length };
        });
      `;
      const { diagnostics, output } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        `Rewrite should produce clean output (got: ${
          errors.map((e) => e.message).join("; ")
        })`,
      );
      assertStringIncludes(
        output,
        "result: ResultShape",
        "The `as { result: ResultShape }` cast should survive the chain rewrite",
      );
    },
  );
});

Deno.test("Module-extracted reactive callback bodies (CT-1587)", async (t) => {
  // ClosureTransformer hoists reactive callback bodies (computed/lift/etc.)
  // into top-level `const __cfModuleCallback_N = ...` declarations. Those
  // bodies must still receive the reactive-root lowering pass so chains like
  // `cell.result` get lowered to `cell.key("result")` — otherwise the access
  // stays as plain JS and unwraps the cell at runtime.
  await t.step(
    "lowers property access on opaque roots inside computed() bodies",
    async () => {
      const source = `
        import { computed, Default, pattern, wish } from "commonfabric";

        export default pattern<Record<string, never>>(() => {
          const result = computed(() => {
            const fooWish = wish<Default<string[], []>>({ query: "#items" });
            const foo = fooWish.result!;
            return foo[0];
          });
          return { result };
        });
      `;
      const { diagnostics, output } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        `Should produce clean output (got: ${
          errors.map((e) => e.message).join("; ")
        })`,
      );
      assertStringIncludes(
        output,
        'fooWish.key("result")',
        'fooWish.result! inside computed() should lower to fooWish.key("result")',
      );
      assertStringIncludes(
        output,
        'foo.key("0")',
        'foo[0] inside computed() should lower to foo.key("0")',
      );
    },
  );
});
