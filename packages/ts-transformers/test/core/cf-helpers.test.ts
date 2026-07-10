import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import {
  sourceDisablesCfTransform,
  sourceHasIgnoredDisableDirective,
  transformCfDirective,
} from "../../src/mod.ts";

Deno.test("transformCfDirective injects helpers by default", () => {
  const source = [
    'import { pattern } from "commonfabric";',
    "export default pattern<{ value: string }>(({ value }) => ({ value }));",
  ].join("\n");

  const transformed = transformCfDirective(source);

  assertMatch(
    transformed,
    /^import \{ __cfHelpers \} from "commonfabric";/m,
  );
  assertMatch(transformed, /function h\(\.\.\.args: any\[\]\)/);
});

Deno.test("transformCfDirective strips cf-disable-transform without helpers", () => {
  const source = [
    "/// <cf-disable-transform />",
    'export const value = "plain";',
  ].join("\n");

  const transformed = transformCfDirective(source);

  assertEquals(sourceDisablesCfTransform(source), true);
  assertEquals(transformed.split("\n")[0], "");
  assertNotMatch(transformed, /import \{ __cfHelpers \} from "commonfabric";/);
  assertNotMatch(transformed, /cf-disable-transform/);
});

// The disable directive is honored only at column zero (matching TypeScript's
// own triple-slash directive convention). An indented directive-lookalike as
// the first content line is intentionally NOT honored: the file transforms as
// usual and the directive line is left untouched.
Deno.test("transformCfDirective does not honor an indented cf-disable-transform", () => {
  const source = [
    "  /// <cf-disable-transform />",
    'export const value = "plain";',
  ].join("\n");

  assertEquals(sourceDisablesCfTransform(source), false);

  const transformed = transformCfDirective(source);
  assertMatch(transformed, /import \{ __cfHelpers \} from "commonfabric";/);
  // The indented directive line is preserved, not stripped.
  assertMatch(transformed, /\/\/\/ <cf-disable-transform \/>/);
});

// `sourceHasIgnoredDisableDirective` names the compile-time signal for warning
// an author: it flags exactly the indented first-content-line lookalikes, and
// nothing that is honored (column zero, with any leading blank lines) or absent.
Deno.test("sourceHasIgnoredDisableDirective flags only indented directive-lookalikes", () => {
  const spaceIndented = "  /// <cf-disable-transform />\nexport const x = 1;";
  const tabIndented = "\t/// <cf-disable-transform />\nexport const x = 1;";
  const columnZero = "/// <cf-disable-transform />\nexport const x = 1;";
  const blanksThenColumnZero =
    "\n\n/// <cf-disable-transform />\nexport const x = 1;";
  const absent = "export const x = 1;";

  // Indented lookalikes are flagged as ignored...
  assertEquals(sourceHasIgnoredDisableDirective(spaceIndented), true);
  assertEquals(sourceHasIgnoredDisableDirective(tabIndented), true);
  // ...while none of these are: two are honored, one has no directive.
  assertEquals(sourceHasIgnoredDisableDirective(columnZero), false);
  assertEquals(sourceHasIgnoredDisableDirective(blanksThenColumnZero), false);
  assertEquals(sourceHasIgnoredDisableDirective(absent), false);

  // "Honored" is exactly the column-zero cases; leading blank lines are fine.
  assertEquals(sourceDisablesCfTransform(columnZero), true);
  assertEquals(sourceDisablesCfTransform(blanksThenColumnZero), true);
  assertEquals(sourceDisablesCfTransform(spaceIndented), false);
});
