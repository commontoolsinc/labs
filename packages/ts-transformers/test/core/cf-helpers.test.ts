import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import {
  sourceDisablesCfTransform,
  sourceUsesCfDirective,
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

Deno.test("transformCfDirective preserves legacy cts-enable behavior", () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "export default pattern<{ value: string }>(({ value }) => ({ value }));",
  ].join("\n");

  const transformed = transformCfDirective(source);

  assertEquals(sourceUsesCfDirective(source), true);
  assertMatch(
    transformed,
    /^import \{ __cfHelpers \} from "commonfabric";/m,
  );
  assertNotMatch(transformed, /cts-enable/);
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
