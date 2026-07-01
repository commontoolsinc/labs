import { assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// Targeted coverage for schema-injection branches that ran in CI only through
// patterns: the per-session scope on a `new` cell constructor, and the schema-
// argument detection that skips injection when two schemas are already present.

Deno.test("schema injection reads the session scope from a `new X.perSession(...)` constructor", async () => {
  const source = [
    'import { Writable as WritableConstructor } from "commonfabric";',
    "export default function Test() {",
    '  const value = new WritableConstructor.perSession("seed");',
    "  return { value };",
    "}",
  ].join("\n");

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  assertStringIncludes(output, 'scope: "session"');
});

Deno.test("schema injection skips a pattern that already supplies input and result schemas", async () => {
  const source = [
    'import { pattern } from "commonfabric";',
    "export default pattern(",
    "  (state: { count: number }) => ({ doubled: state.count * 2 }),",
    '  { type: "object" } as const,',
    '  { type: "object" } as const,',
    ");",
  ].join("\n");

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  // Injection is skipped, so the pattern keeps exactly the two author-supplied
  // schema literals — no inferred input/result schema is added.
  const schemaCount =
    output.split("as const satisfies __cfHelpers.JSONSchema").length - 1;
  assertEquals(schemaCount, 2);
});
