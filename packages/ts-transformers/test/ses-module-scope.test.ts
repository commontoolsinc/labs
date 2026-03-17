import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

Deno.test("SES module-scope canonicalization emits wrappers and sentinels", async () => {
  const source = `/// <cts-enable />
import { lift, pattern, h } from "commontools";

const SCALE = 2;

function addScale(value: number) {
  return value + SCALE;
}

const DEFAULTS = {
  scale: SCALE,
  labels: ["a", "b"],
};

const double = lift((value: number) => addScale(value) * DEFAULTS.scale);

export default pattern<{ count: number }>(({ count }) => {
  return <div>{double(count)}</div>;
});
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertStringIncludes(output, "__ct_builder(");
  assertStringIncludes(output, "__ct_fn(");
  assertStringIncludes(output, "__ct_data(");
  assertStringIncludes(output, "/*__CT_TOPLEVEL__:");
  assertMatch(output, /__ct_builder\("lift",\s*"[^"]+",\s*function/);
  assertMatch(output, /__ct_fn\(\s*"[^"]+",\s*function/);
  assertMatch(output, /__ct_data\(\s*"[^"]+",\s*\[/);
});

Deno.test("SES module-scope hoists derive and action callbacks that capture module scope", async () => {
  const source = `/// <cts-enable />
import { action, derive, pattern, h } from "commontools";

const FACTOR = 3;
const adjust = (value: number) => value + FACTOR;

export default pattern<{ count: number }>(({ count }) => {
  const derived = derive(count, (value) => adjust(value));
  const clicked = action(() => adjust(count));
  return <div onClick={clicked}>{derived}</div>;
});
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertMatch(
    output,
    /const __ct_hoisted_lift_\d+ = (?:__ctHelpers\.)?__ct_builder\("lift"/,
  );
  assertMatch(
    output,
    /const __ct_hoisted_handler_\d+ = (?:__ctHelpers\.)?__ct_builder\("handler"/,
  );
  assertMatch(output, /const derived = __ct_hoisted_lift_\d+\(count\)/);
  assertMatch(output, /const clicked = __ct_hoisted_handler_\d+\(\{\s*count: count\s*\}\)/);
});

Deno.test("SES module-scope keeps patternTool-like builders inline", async () => {
  const source = `/// <cts-enable />
import { pattern, patternTool, h } from "commontools";

export default pattern<{ count: number }>(({ count }) => {
  const tool = patternTool("count-tool", () =>
    pattern(() => <div>{count}</div>)
  );
  return <div>{tool}</div>;
});
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertEquals(
    output.includes('__ct_builder("pattern"'),
    false,
    "nested patternTool/pattern builders should stay inline",
  );
});
