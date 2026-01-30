import { assertEquals } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

function getWarnings(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.type === "ses-html-comment");
}

async function validate(source: string) {
  return await validateSource(source, { types: COMMONTOOLS_TYPES });
}

Deno.test("HTML Comment Validation", async (t) => {
  await t.step("warns on <!-- in string literal", async () => {
    const source = `/// <cts-enable />
      const x = "<!-- hello -->";
      export default x;
    `;
    const { diagnostics } = await validate(source);
    const warnings = getWarnings(diagnostics);
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]!.severity, "error");
  });

  await t.step("warns on --> in string literal", async () => {
    const source = `/// <cts-enable />
      const x = "end -->";
      export default x;
    `;
    const { diagnostics } = await validate(source);
    const warnings = getWarnings(diagnostics);
    assertEquals(warnings.length, 1);
  });

  await t.step("warns on template literal", async () => {
    const source = `/// <cts-enable />
      const x = \`<!-- comment -->\`;
      export default x;
    `;
    const { diagnostics } = await validate(source);
    const warnings = getWarnings(diagnostics);
    assertEquals(warnings.length, 1);
  });

  await t.step("no warning when absent", async () => {
    const source = `/// <cts-enable />
      const x = "perfectly fine string";
      export default x;
    `;
    const { diagnostics } = await validate(source);
    const warnings = getWarnings(diagnostics);
    assertEquals(warnings.length, 0);
  });
});
