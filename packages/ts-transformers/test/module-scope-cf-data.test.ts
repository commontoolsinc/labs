import { assert, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// The module-scope cf-data transformer wraps a default-exported callable with
// `__cfHelpers.__cf_data` when that callable's body may return a call applied to
// another call result (the `factory()()` shape). These tests drive the decision
// logic that classifies a callable as such.

const PRELUDE = [
  'import { pattern } from "commonfabric";',
  "declare function factory(): () => number;",
].join("\n");

async function transform(lines: string[]): Promise<string> {
  return await transformSource([PRELUDE, ...lines].join("\n"), {
    types: COMMONFABRIC_TYPES,
  });
}

Deno.test("module-scope cf-data wraps an arrow callable returning a call-on-call result", async () => {
  const out = await transform([
    "const helper = () => factory()();",
    "export default helper;",
  ]);
  assertStringIncludes(out, "export default __cfHelpers.__cf_data(helper)");
});

Deno.test("module-scope cf-data wraps a block-body callable whose return is a call-on-call result", async () => {
  const out = await transform([
    "const helper = () => {",
    "  const seed = 1;",
    "  const next = seed + 1;",
    "  return factory()();",
    "};",
    "export default helper;",
  ]);
  assertStringIncludes(out, "export default __cfHelpers.__cf_data(helper)");
});

Deno.test("module-scope cf-data wraps when the call-on-call result is nested in the returned expression", async () => {
  const out = await transform([
    "const helper = () => ({ value: factory()() });",
    "export default helper;",
  ]);
  assertStringIncludes(out, "export default __cfHelpers.__cf_data(helper)");
});

Deno.test("module-scope cf-data ignores a call-on-call result inside a nested function boundary", async () => {
  const out = await transform([
    "const helper = () => {",
    "  const inner = () => factory()();",
    "  return inner;",
    "};",
    "export default helper;",
  ]);
  // The call-on-call result lives inside the inner arrow, which is a traversal
  // boundary, so the outer callable is not treated as returning a call result.
  assert(
    !out.includes("__cf_data(helper)"),
    "expected helper to be left unwrapped",
  );
});

Deno.test("module-scope cf-data ignores a callable whose body expression is itself a function", async () => {
  const out = await transform([
    "const helper = () => () => factory()();",
    "export default helper;",
  ]);
  // The arrow body is a function expression — a traversal boundary — so the
  // nested call-on-call result is not attributed to `helper`.
  assert(
    !out.includes("__cf_data(helper)"),
    "expected helper to be left unwrapped",
  );
});
