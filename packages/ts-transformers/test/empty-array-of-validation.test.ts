import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

function getEmptyArrayErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.type === "cell-factory:empty-array");
}

Deno.test("Empty Array .of() Validation", async (t) => {
  await t.step("errors on Cell.of([])", async () => {
    const source = `
      import { Cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = Cell.of([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertGreater(errors.length, 0, "Expected at least one empty-array error");
    assertEquals(errors[0]!.type, "cell-factory:empty-array");
  });

  await t.step("errors on Writable.of([])", async () => {
    const source = `
      import { Writable, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = Writable.of([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertGreater(
      errors.length,
      0,
      "Expected at least one empty-array error",
    );
  });

  await t.step("errors on OpaqueCell.of([])", async () => {
    const source = `
      import { OpaqueCell, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = OpaqueCell.of([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertGreater(
      errors.length,
      0,
      "Expected at least one empty-array error",
    );
  });

  await t.step("errors on Stream.of([])", async () => {
    const source = `
      import { Stream, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = Stream.of([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertGreater(
      errors.length,
      0,
      "Expected at least one empty-array error",
    );
  });

  await t.step("errors on deprecated cell([])", async () => {
    const source = `
      import { cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = cell([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertGreater(
      errors.length,
      0,
      "Expected at least one empty-array error for deprecated cell()",
    );
  });

  await t.step("no error on Cell.of<string[]>([])", async () => {
    const source = `
      import { Cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = Cell.of<string[]>([]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Should not error when explicit type argument is provided",
    );
  });

  await t.step("no error on Cell.of([1, 2, 3])", async () => {
    const source = `
      import { Cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const items = Cell.of([1, 2, 3]);
        return <div>{items}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Non-empty array should not trigger the error",
    );
  });

  await t.step("no error on Cell.of('hello')", async () => {
    const source = `
      import { Cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const msg = Cell.of("hello");
        return <div>{msg}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "Non-array values should not trigger the error",
    );
  });

  await t.step("no error on Cell.of() with no arguments", async () => {
    const source = `
      import { Cell, pattern } from "commontools";
      export default pattern(({ }) => {
        const val = Cell.of<string>();
        return <div>{val}</div>;
      });
    `;
    const { diagnostics } = await validateSource(source, {
      types: COMMONTOOLS_TYPES,
    });
    const errors = getEmptyArrayErrors(diagnostics);
    assertEquals(
      errors.length,
      0,
      "No-argument .of() should not trigger the error",
    );
  });
});
