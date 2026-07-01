import { assert, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// `emitCallExpression` has a dedicated branch for an authored zero-argument
// inline IIFE — `(() => ...)()` — that appears inside a reactive array-method
// callback. That branch (and its receiver-scanning helpers) runs today only as
// a side effect of patterns compiling through the transformer in CI's
// pattern-integration jobs, because reaching it needs the in-place expression
// rewrite that array-method callback lowering performs. These tests place such
// an IIFE inside a `.map()`/`.filter()` callback and assert on how the branch
// treats it.
//
// Two outcomes are exercised. When the IIFE's body still performs a direct cell
// read on a receiver declared outside the IIFE, the branch wraps the IIFE so the
// read runs under a reactive cause context — the read is lowered and its cell
// dependency is tracked into the callback's pattern input (`item.key("x")`).
// When the IIFE instead decomposes through a local alias or an object-literal
// projection, the branch preserves the authored IIFE verbatim so the inner
// expression-site machinery handles it.

const HEAD = `/// <cts-enable />
import { Cell, pattern, UI, VNode } from "commonfabric";
interface Row { x: Cell<number>; label: Cell<string>; }
interface Input { items: Cell<Row[]>; base: Cell<number>; }
interface Output { [UI]: VNode; }
`;

async function transformRender(body: string): Promise<string> {
  const source = `${HEAD}
export default pattern<Input, Output>(({ items, base }) => ({
  [UI]: <div>{${body}}</div>,
}));`;
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

/** The lowered `mapWithPattern` callback body extracted for focused assertions. */
function patternCallbackBody(output: string): string {
  const start = output.indexOf("__cfPattern_1 =");
  assert(start >= 0, "expected an extracted map pattern callback");
  const end = output.indexOf("}, {", start);
  return output.slice(start, end);
}

Deno.test(
  "zero-arg IIFE reading an element cell inside a map callback wraps the read into a reactive lift",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => item.x.get())() + 1)`,
    );
    // The map lowered to mapWithPattern, and the IIFE's `item.x.get()` was
    // wrapped into a lift-applied call whose input tracks the element cell path.
    assertStringIncludes(output, "mapWithPattern");
    const body = patternCallbackBody(output);
    assertStringIncludes(body, "__cfLift");
    assertStringIncludes(body, 'item.key("x")');
    // The raw IIFE call form was replaced by the wrapper, not left authored.
    assert(
      !/\(\(\) =>/.test(body),
      "expected the IIFE to be lowered, not preserved verbatim",
    );
  },
);

Deno.test(
  "zero-arg IIFE mixing an outer cell and an element cell tracks both dependencies",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => base.get() || 0)() + item.x.get())`,
    );
    const body = patternCallbackBody(output);
    // Both the outer `base` cell and the element `item.x` cell reach the lift
    // input, so neither reactive dependency is lost across the IIFE boundary.
    assertStringIncludes(body, "__cfLift");
    assertStringIncludes(body, "base: base");
    assertStringIncludes(body, 'item.key("x")');
  },
);

Deno.test(
  "zero-arg IIFE read inside a filter predicate is wrapped while the chain lowers",
  async () => {
    const output = await transformRender(
      `items.filter((item) => (() => item.x.get() > 0)()).map((item) => item.label)`,
    );
    // The filter+map chain lowers to filterWithPattern/mapWithPattern and the
    // predicate IIFE's cell read is wrapped into a lift tracking the element.
    assertStringIncludes(output, "filterWithPattern");
    assertStringIncludes(output, "mapWithPattern");
    assertStringIncludes(output, "__cfLift");
    assertStringIncludes(output, 'item.key("x")');
  },
);

Deno.test(
  "zero-arg IIFE decomposing through a local alias is preserved verbatim",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => { const p = item.x.get() || 0; return p; })() + 1)`,
    );
    const body = patternCallbackBody(output);
    // The IIFE holds a local alias (`const p = item.x.get() || 0`), so the branch
    // leaves the authored IIFE in place for the inner machinery to decompose
    // rather than forcing a blanket wrapper around the whole call.
    assert(
      /\(\(\) =>/.test(body),
      "expected the authored IIFE to be preserved",
    );
    assertStringIncludes(body, "item.x.get()");
  },
);

Deno.test(
  "zero-arg IIFE projecting an object-literal property is preserved verbatim",
  async () => {
    const output = await transformRender(
      `items.map((item) => (() => ({ v: item.x.get() }))().v)`,
    );
    const body = patternCallbackBody(output);
    // The IIFE returns an object literal that is immediately projected (`.v`);
    // no direct external cell read survives the child rewrite, so the IIFE is
    // returned unchanged.
    assert(
      /\(\(\) =>/.test(body),
      "expected the authored IIFE to be preserved",
    );
    assertStringIncludes(body, "item.x.get()");
  },
);
