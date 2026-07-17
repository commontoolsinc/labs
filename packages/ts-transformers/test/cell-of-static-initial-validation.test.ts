import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

const DIAGNOSTIC_TYPE = "cell-factory:non-static-initial";

function getStaticInitialErrors(
  diagnostics: readonly TransformationDiagnostic[],
) {
  return diagnostics.filter((d) =>
    d.type === DIAGNOSTIC_TYPE && d.severity === "error"
  );
}

async function staticInitialErrorsFor(body: string) {
  const source = `
    import { Cell, cell, NAME, pattern, safeDateNow, Writable } from "commonfabric";
    export default pattern(() => {
      ${body}
      return <div />;
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return getStaticInitialErrors(diagnostics);
}

Deno.test("cell-factory static initial validation", async (t) => {
  await t.step("accepts literals and no-value calls", async () => {
    const errors = await staticInitialErrorsFor(`
      const a = Cell.of(42);
      const b = Cell.of("hello");
      const c = Cell.of(true);
      const d = Cell.of(null);
      const e = Cell.of<number>();
      const f = Writable.perSession.of<string>("");
      const g = cell({ theme: "dark", tags: ["a"], nested: { n: -1 } });
    `);
    assertEquals(errors.length, 0);
  });

  await t.step("accepts const references to static initializers", async () => {
    const errors = await staticInitialErrorsFor(`
      const SEED = ["a", "b"];
      const CONFIG = { retries: 3, name: "poll" } as const;
      const a = Cell.of(SEED);
      const b = Cell.of(CONFIG);
    `);
    assertEquals(errors.length, 0);
  });

  await t.step("accepts static member and element access", async () => {
    const errors = await staticInitialErrorsFor(`
      const PROMPTS = [{ id: "p1", label: "One" }, { id: "p2", label: "Two" }];
      const CONFIG = { retries: 3, labels: ["a", "b"] };
      const a = Cell.of(PROMPTS[0].id);
      const b = Cell.of(CONFIG.retries);
      const c = Cell.of(CONFIG.labels[1]);
    `);
    assertEquals(errors.length, 0);
  });

  await t.step("rejects member access onto runtime values", async () => {
    const errors = await staticInitialErrorsFor(`
      const arr = [safeDateNow()];
      const a = Cell.of(arr[0]);
    `);
    assertEquals(errors.length, 1);
  });

  await t.step("constant-folds arithmetic and string concat", async () => {
    const errors = await staticInitialErrorsFor(`
      const HOUR = 60 * 60;
      const a = cell(10 + 20);
      const b = cell(HOUR * 24);
      const c = cell("hello" + " " + "world");
      const d = cell(-(1 + 2));
    `);
    assertEquals(errors.length, 0);
  });

  await t.step("rejects runtime expressions", async () => {
    const errors = await staticInitialErrorsFor(`
      const today = Writable.perSession.of<number>(safeDateNow());
    `);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, "must be compile-time static");
    assertStringIncludes(errors[0].message, "cell.set");
  });

  await t.step("rejects non-const and mutable references", async () => {
    const errors = await staticInitialErrorsFor(`
      let seed = 42;
      const a = Cell.of(seed);
    `);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, "let");
  });

  await t.step(
    "rejects a const whose initializer is not static",
    async () => {
      const errors = await staticInitialErrorsFor(`
        const seed = safeDateNow();
        const a = Cell.of(seed);
      `);
      assertEquals(errors.length, 1);
      assertStringIncludes(errors[0].message, "seed");
    },
  );

  await t.step("rejects bigint literals with a cell.set pointer", async () => {
    const errors = await staticInitialErrorsFor(`
      const a = cell(123n);
    `);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, "bigint");
    assertStringIncludes(errors[0].message, "cell.set");
  });

  await t.step("rejects non-finite folds", async () => {
    const errors = await staticInitialErrorsFor(`
      const a = cell(1 / 0);
    `);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, "finite");
  });

  await t.step("rejects spreads and runtime computed keys", async () => {
    const errors = await staticInitialErrorsFor(`
      const base = { a: 1 };
      const a = cell({ ...base });
      const b = cell({ [String(safeDateNow())]: 1 });
    `);
    assertEquals(errors.length, 2);
  });

  await t.step(
    "accepts static computed keys and template substitutions",
    async () => {
      const errors = await staticInitialErrorsFor(`
        const KEY = "k";
        const NAME = "poll";
        const a = cell({ [KEY]: 1 });
        const b = cell(\`item-\${KEY}-\${1 + 2}\`);
        const c = cell({ [NAME]: "display" });
      `);
      assertEquals(errors.length, 0);
    },
  );

  await t.step(
    "names the scoped constructor chain in the message",
    async () => {
      const errors = await staticInitialErrorsFor(`
        const today = Writable.perSession.of<number>(safeDateNow());
      `);
      assertEquals(errors.length, 1);
      assertStringIncludes(errors[0].message, "Writable.perSession.of");
    },
  );
});
