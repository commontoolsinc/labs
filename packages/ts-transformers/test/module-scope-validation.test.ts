import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

/**
 * Helper to validate with SES validation enabled
 */
async function validateWithSES(source: string) {
  return await validateSource(source, {
    types: COMMONTOOLS_TYPES,
  });
}

Deno.test("Module-Scope Validation - Variable Declarations", async (t) => {
  await t.step("allows const at module scope", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { UI: <div>{name}</div> };
      });

      export default MyPattern;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "const at module scope should be allowed");
  });

  await t.step("errors on let at module scope", async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commontools";

      let counter = 0;

      const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { result: name };
      });

      export default MyPattern;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "module-scope-let-var");
    assertEquals(
      errors[0]!.message.includes("let"),
      true,
      "Error should mention 'let'",
    );
  });

  await t.step("errors on var at module scope", async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commontools";

      var counter = 0;

      const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { result: name };
      });

      export default MyPattern;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "module-scope-let-var");
    assertEquals(
      errors[0]!.message.includes("var"),
      true,
      "Error should mention 'var'",
    );
  });
});

Deno.test("Module-Scope Validation - Allowed Calls", async (t) => {
  await t.step("allows pattern() call", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { UI: <div>{name}</div> };
      });

      export default MyPattern;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "pattern() should be allowed");
  });

  await t.step("allows recipe() call", async () => {
    const source = `/// <cts-enable />
      import { recipe, h } from "commontools";

      const MyRecipe = recipe<{ name: string }>("test", ({ name }) => {
        return <div>{name}</div>;
      });

      export default MyRecipe;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "recipe() should be allowed");
  });

  await t.step("allows lift() call", async () => {
    const source = `/// <cts-enable />
      import { lift } from "commontools";

      const doubleValue = lift((x: number) => x * 2);

      export default doubleValue;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "lift() should be allowed");
  });

  await t.step("allows handler() call", async () => {
    const source = `/// <cts-enable />
      import { handler } from "commontools";

      const onClick = handler((e: MouseEvent) => console.log("clicked"));

      export default onClick;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "handler() should be allowed");
  });

  await t.step("allows Object.freeze() call", async () => {
    const source = `/// <cts-enable />
      const CONFIG = Object.freeze({
        maxItems: 100,
        minItems: 0,
      });

      export default CONFIG;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Object.freeze() should be allowed");
  });

  await t.step("allows harden() call", async () => {
    const source = `/// <cts-enable />
      declare function harden<T>(obj: T): T;

      const CONFIG = harden({
        maxItems: 100,
        minItems: 0,
      });

      export default CONFIG;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "harden() should be allowed");
  });
});

Deno.test("Module-Scope Validation - Disallowed Calls", async (t) => {
  await t.step(
    "allows arbitrary function call in const initializer",
    async () => {
      const source = `/// <cts-enable />
      declare function computeValue(): number;

      const result = computeValue();

      export default result;
    `;
      const { diagnostics } = await validateWithSES(source);
      const errors = getErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        "Function calls in const initializers should be allowed",
      );
    },
  );

  await t.step("errors on IIFE", async () => {
    const source = `/// <cts-enable />
      const result = (() => {
        return 42;
      })();

      export default result;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "module-scope-iife");
    assertEquals(
      errors[0]!.message.includes("IIFE"),
      true,
      "Error should mention IIFE",
    );
  });

  await t.step("errors on IIFE with function expression", async () => {
    const source = `/// <cts-enable />
      const result = (function() {
        return 42;
      })();

      export default result;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one error");
    assertEquals(errors[0]!.type, "module-scope-iife");
  });
});

Deno.test("Module-Scope Validation - Allowed Expressions", async (t) => {
  await t.step("allows string literals", async () => {
    const source = `/// <cts-enable />
      const MESSAGE = "Hello, World!";
      export default MESSAGE;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "String literals should be allowed");
  });

  await t.step("allows number literals", async () => {
    const source = `/// <cts-enable />
      const COUNT = 42;
      export default COUNT;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Number literals should be allowed");
  });

  await t.step("allows object literals", async () => {
    const source = `/// <cts-enable />
      const CONFIG = {
        maxItems: 100,
        minItems: 0,
      };
      export default CONFIG;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Object literals should be allowed");
  });

  await t.step("allows array literals", async () => {
    const source = `/// <cts-enable />
      const ITEMS = [1, 2, 3];
      export default ITEMS;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Array literals should be allowed");
  });

  await t.step("allows arrow function definitions", async () => {
    const source = `/// <cts-enable />
      const helper = (x: number): number => x * 2;
      export default helper;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Arrow function definitions should be allowed",
    );
  });

  await t.step("allows function expression definitions", async () => {
    const source = `/// <cts-enable />
      const helper = function(x: number): number { return x * 2; };
      export default helper;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Function expression definitions should be allowed",
    );
  });
});

Deno.test("Module-Scope Validation - Export Annotations", async (t) => {
  await t.step("allows __exportName property assignment", async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commontools";

      const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { result: name };
      });

      MyPattern.__exportName = "MyPattern";

      export default MyPattern;
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "__exportName assignment should be allowed",
    );
  });
});

Deno.test("Module-Scope Validation - Always Active", async (t) => {
  await t.step("errors on let by default", async () => {
    const source = `/// <cts-enable />
      let counter = 0;
      export default counter;
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getErrors(diagnostics);
    assertEquals(
      errors.length > 0,
      true,
      "Should error on let declarations by default",
    );
  });
});

Deno.test("Module-Scope Validation - Type Declarations", async (t) => {
  await t.step("allows interface declarations", async () => {
    const source = `/// <cts-enable />
      interface Item {
        name: string;
        price: number;
      }

      export type { Item };
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Interface declarations should be allowed");
  });

  await t.step("allows type alias declarations", async () => {
    const source = `/// <cts-enable />
      type ItemType = {
        name: string;
        price: number;
      };

      export type { ItemType };
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Type alias declarations should be allowed");
  });

  await t.step("allows function declarations", async () => {
    const source = `/// <cts-enable />
      function helper(x: number): number {
        return x * 2;
      }

      export { helper };
    `;
    const { diagnostics } = await validateWithSES(source);
    const errors = getErrors(diagnostics);
    assertEquals(errors.length, 0, "Function declarations should be allowed");
  });
});
