import { assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

/**
 * Helper to transform with SES validation enabled
 */
async function transformWithSES(source: string): Promise<string> {
  return await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesValidation: true,
  });
}

Deno.test("Export Annotation - pattern exports", async (t) => {
  await t.step("annotates exported pattern", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      export const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { UI: <div>{name}</div> };
      });
    `;
    const output = await transformWithSES(source);
    assertStringIncludes(output, 'MyPattern.__exportName = "MyPattern"');
  });

  await t.step("annotates multiple exported patterns", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      export const PatternA = pattern<{ a: string }>(({ a }) => {
        return { UI: <div>{a}</div> };
      });

      export const PatternB = pattern<{ b: string }>(({ b }) => {
        return { UI: <div>{b}</div> };
      });
    `;
    const output = await transformWithSES(source);
    assertStringIncludes(output, 'PatternA.__exportName = "PatternA"');
    assertStringIncludes(output, 'PatternB.__exportName = "PatternB"');
  });
});

Deno.test("Export Annotation - recipe exports", async (t) => {
  await t.step("annotates exported recipe", async () => {
    const source = `/// <cts-enable />
      import { recipe, h } from "commontools";

      export const MyRecipe = recipe<{ name: string }>("test", ({ name }) => {
        return <div>{name}</div>;
      });
    `;
    const output = await transformWithSES(source);
    assertStringIncludes(output, 'MyRecipe.__exportName = "MyRecipe"');
  });
});

Deno.test("Export Annotation - lift exports", async (t) => {
  await t.step("annotates exported lift", async () => {
    const source = `/// <cts-enable />
      import { lift } from "commontools";

      export const double = lift((x: number) => x * 2);
    `;
    const output = await transformWithSES(source);
    assertStringIncludes(output, 'double.__exportName = "double"');
  });
});

Deno.test("Export Annotation - handler exports", async (t) => {
  await t.step("annotates exported handler", async () => {
    const source = `/// <cts-enable />
      import { handler } from "commontools";

      export const onClick = handler((e: MouseEvent) => console.log(e));
    `;
    const output = await transformWithSES(source);
    assertStringIncludes(output, 'onClick.__exportName = "onClick"');
  });
});

Deno.test("Export Annotation - non-builder exports", async (t) => {
  await t.step("does not annotate regular const exports", async () => {
    const source = `/// <cts-enable />
      export const CONFIG = { maxItems: 100 };
    `;
    const output = await transformWithSES(source);
    // Should not have any __exportName annotation
    assertEquals(output.includes("__exportName"), false);
  });

  await t.step("does not annotate function exports", async () => {
    const source = `/// <cts-enable />
      export const helper = (x: number) => x * 2;
    `;
    const output = await transformWithSES(source);
    // Should not have any __exportName annotation
    assertEquals(output.includes("__exportName"), false);
  });
});

Deno.test("Export Annotation - disabled when sesValidation is false", async (t) => {
  await t.step("does not annotate when sesValidation is false", async () => {
    const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      export const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { UI: <div>{name}</div> };
      });
    `;
    const output = await transformSource(source, {
      types: COMMONTOOLS_TYPES,
      sesValidation: false,
    });
    assertEquals(output.includes("__exportName"), false);
  });

  await t.step(
    "does not annotate when sesValidation is undefined",
    async () => {
      const source = `/// <cts-enable />
      import { pattern, h } from "commontools";

      export const MyPattern = pattern<{ name: string }>(({ name }) => {
        return { UI: <div>{name}</div> };
      });
    `;
      const output = await transformSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(output.includes("__exportName"), false);
    },
  );
});
