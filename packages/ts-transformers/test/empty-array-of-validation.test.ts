import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

function getEmptyArrayErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.type === "cell-factory:empty-array");
}

async function getEmptyArrayErrorCount(
  imports: string,
  expression: string,
): Promise<number> {
  const source = `
    import { ${imports}, pattern } from "commontools";
    export default pattern(() => {
      const value = ${expression};
      return <div>{value}</div>;
    });
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONTOOLS_TYPES,
  });

  return getEmptyArrayErrors(diagnostics).length;
}

Deno.test("Empty Array .of() Validation", async (t) => {
  const errorCases = [
    { name: "errors on Cell.of([])", imports: "Cell", expression: "Cell.of([])" },
    {
      name: "errors on Writable.of([])",
      imports: "Writable",
      expression: "Writable.of([])",
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
