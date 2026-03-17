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
  assertEquals(
    output.includes("__ct_hoisted_lift_0.argumentSchema"),
    false,
    "compiler-generated hoisted lifts must stay schema-less",
  );
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

  const topLevelPatternWrappers = output.match(/__ct_builder\("pattern"/g) ?? [];
  assertEquals(
    topLevelPatternWrappers.length,
    1,
    "only the top-level default export should be canonicalized into a pattern wrapper",
  );
});

Deno.test("SES module-scope preserves function-hoist semantics for later function declarations", async () => {
  const source = `/// <cts-enable />
const value = helper();

function helper() {
  return 2;
}

export default value;
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  const helperIndex = output.indexOf("const helper =");
  const valueIndex = output.indexOf("const value =");

  assertEquals(helperIndex >= 0, true);
  assertEquals(valueIndex >= 0, true);
  assertEquals(
    helperIndex < valueIndex,
    true,
    "wrapped function declarations must be emitted before dependent data initializers",
  );
});

Deno.test("SES module-scope canonicalizes builder references to module-scope helper functions", async () => {
  const source = `/// <cts-enable />
import { lift } from "commontools";

function sanitize(value: number) {
  return value + 1;
}

export const lifted = lift(sanitize);
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertMatch(
    output,
    /__ct_builder\("lift",\s*"[^"]+",\s*function\s*\(value(?::\s*number)?\)/,
  );
});

Deno.test("SES module-scope canonicalizes direct default-export builder expressions", async () => {
  const source = `/// <cts-enable />
import { pattern } from "commontools";

export default pattern<{ count: number }>(({ count }) => {
  return { count };
});
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertMatch(
    output,
    /\/\*__CT_TOPLEVEL__:[^*]+:builder\*\/\s*const __ct_default_export_\d+ = __ctHelpers\.__ct_builder\("pattern"/,
  );
  assertMatch(output, /exports\.default = __ct_default_export_\d+;/);
  assertEquals(
    output.includes("exports.default = (0, commontools_1.pattern)"),
    false,
    "direct default-export builder calls must be rewritten into canonical wrapper bindings",
  );
});

Deno.test("SES module-scope encodes top-level Set and Map data wrappers as plain data", async () => {
  const source = `/// <cts-enable />
const VALUES = ["a", "b"] as const;
const LOOKUP = new Set(VALUES);
const INDEX = new Map(VALUES.map((value, index) => [value, index] as const));
const IDENTIFIER = /^[a-z]+$/i;

export default { LOOKUP, INDEX, IDENTIFIER };
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertStringIncludes(output, '__ctDataKind: "Set"');
  assertStringIncludes(output, '__ctDataKind: "Map"');
  assertStringIncludes(output, '__ctDataKind: "RegExp"');
  assertMatch(output, /__ct_data\(\s*"[^"]+",\s*\[[^\]]*\],\s*\{\s*__ctDataKind: "Set"/);
  assertMatch(output, /__ct_data\(\s*"[^"]+",\s*\[[^\]]*\],\s*\{\s*__ctDataKind: "Map"/);
  assertMatch(output, /__ct_data\(\s*"[^"]+",\s*\[[^\]]*\],\s*\{\s*__ctDataKind: "RegExp"/);
});

Deno.test("SES module-scope does not hoist callbacks that rely on cell methods", async () => {
  const source = `/// <cts-enable />
import { Cell, computed, pattern } from "commontools";

const sanitizeEnabled = (value: boolean | undefined): boolean => value === true;

export default pattern<{ enabled: Cell<boolean> }>(({ enabled }) => {
  const active = computed(() => sanitizeEnabled(enabled.get()));
  return { active };
});
`;

  const output = await transformSource(source, {
    types: COMMONTOOLS_TYPES,
    sesMode: true,
  });

  assertEquals(
    output.includes("__ct_hoisted_lift_"),
    false,
    "callbacks that call cell methods must remain inline",
  );
});
