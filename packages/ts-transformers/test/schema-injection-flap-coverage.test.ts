import { assert, assertEquals } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, callsNamed, parseModule } from "./transformed-ast.ts";

// A few branches in schema-injection.ts run only while a pattern compiles
// through the transformer from cold. When CI's compile cache is warm the
// compilation is skipped, so the same code alternates between covered and
// uncovered across runs of identical source. These unit tests drive each branch
// directly from small pattern sources and assert on the real emitted schema
// objects, so the branches stay covered regardless of cache state.
//
// The assertions parse the printed output back into an AST and evaluate the
// emitted `... satisfies ...JSONSchema` literals to their JS values, so a
// preserved comment or an input substring cannot satisfy them.

function t(source: string): Promise<string> {
  return transformSource(source, { types: COMMONFABRIC_TYPES });
}

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

Deno.test(
  "a lift result recovered as any leaves the downstream capture schema permissive",
  async () => {
    // `liftSummary` is applied to build `summary`, which a `computed` closure then
    // captures. The closure transformer types the captured `summary` as `any`, so
    // schema injection tries to recover its type from the originating lift factory.
    // The lift callback is annotated to return `any`, so the recovered result type
    // is `any` and the recovery declines (the any/unknown result guard returns
    // undefined). The captured-input schema for `summary` therefore stays the
    // permissive `true` schema instead of a concrete recovered object shape.
    const source = `/// <cts-enable />
import { Cell, computed, lift, pattern, Writable } from "commonfabric";
const liftSummary = lift<
  { primary: Writable<number>; secondary: Writable<number> }
>(
  // deno-lint-ignore no-explicit-any
  ({ primary, secondary }): any => primary.get() + secondary.get(),
);
export default pattern<{ primary: Cell<number>; secondary: Cell<number> }>(
  ({ primary, secondary }) => {
    const summary = liftSummary({ primary, secondary });
    const difference = computed(() => summary);
    return { summary, difference };
  },
);`;
    const output = parseModule(await t(source));

    // The `computed` closure captures `summary` reactively via a generated lift.
    // Its input schema (the first schema argument) keeps `summary` permissive
    // (`true`) because the recovery could not infer a concrete type for the
    // any-typed lift result.
    const liftCalls = callsNamed(output, "lift").filter((c) =>
      c.arguments.length >= 2
    );
    assert(liftCalls.length >= 1);
    const [inputSchema] = callSchemas(output, "lift");
    assert(inputSchema, "expected an input schema on the generated lift");
    const props = inputSchema.properties as Obj;
    assertEquals(props.summary, true);
  },
);

Deno.test(
  "a lift result recovered as a concrete object keeps its projected schema",
  async () => {
    // Companion to the case above: with a concrete lift callback return type the
    // recovery succeeds (the any/unknown guard is not taken), so the captured
    // `summary` schema carries the projected object's properties rather than the
    // permissive `true`.
    const source = `/// <cts-enable />
import { Cell, computed, lift, pattern, Writable } from "commonfabric";
const liftSummary = lift<
  { primary: Writable<number>; secondary: Writable<number> }
>(({ primary, secondary }) => {
  const primaryValue = primary.get();
  const secondaryValue = secondary.get();
  return {
    primary: primaryValue,
    secondary: secondaryValue,
    difference: primaryValue - secondaryValue,
  };
});
export default pattern<{ primary: Cell<number>; secondary: Cell<number> }>(
  ({ primary, secondary }) => {
    const summary = liftSummary({ primary, secondary });
    const difference = computed(() => summary.difference);
    return { summary, difference };
  },
);`;
    const output = parseModule(await t(source));
    const [inputSchema] = callSchemas(output, "lift");
    assert(inputSchema, "expected an input schema on the generated lift");
    const summarySchema = (inputSchema.properties as Obj).summary as Obj;
    // Unlike the any-result case (where `summary` stays the permissive `true`),
    // recovery here produced a concrete object schema that projects the read
    // `difference` property.
    assert(
      summarySchema && typeof summarySchema === "object" &&
        !Array.isArray(summarySchema),
      "expected a concrete recovered object schema for summary, not `true`",
    );
    assertEquals(summarySchema.type, "object");
    assert(
      Object.keys(summarySchema.properties as Obj).includes("difference"),
      "expected the recovered summary schema to project `difference`",
    );
    assertEquals(
      (summarySchema.required as string[]).includes("difference"),
      true,
    );
  },
);

Deno.test(
  "a parenthesized scope-wrapper type on a lift object return is unwrapped into a scope marker",
  async () => {
    // The lift callback returns `{ v }` where `v` is declared with the
    // parenthesized type `(PerSpace<number>)`. Building the object-literal return
    // schema reads that declared type node and unwraps the parentheses before
    // testing for a scope wrapper. Once unwrapped, `PerSpace` is recognized and
    // the emitted property schema carries `scope: "space"`.
    const source = `/// <cts-enable />
import { Cell, pattern, lift, PerSpace, UI, VNode } from "commonfabric";
interface Input { seed: Cell<number>; }
interface Output { [UI]: VNode; }
export default pattern<Input, Output>(({ seed }) => {
  const make = lift((n: number) => {
    const v: (PerSpace<number>) = n as unknown as PerSpace<number>;
    return { v };
  });
  const r = make(seed);
  return { [UI]: <div>{r}</div> };
});`;
    const output = parseModule(await t(source));

    // The lift's result schema encodes `v` as a space-scoped number, which only
    // happens if the parenthesized type node was unwrapped and the scope wrapper
    // recognized.
    const resultSchemas = callSchemas(output, "lift");
    const scoped = resultSchemas.find((schema) => {
      const v = (schema.properties as Obj | undefined)?.v as Obj | undefined;
      return v?.scope === "space";
    });
    assert(
      scoped,
      "expected a lift result schema with v marked scope: space",
    );
    const v = (scoped!.properties as Obj).v as Obj;
    assertEquals(v.type, "number");
    assertEquals(v.scope, "space");
  },
);
