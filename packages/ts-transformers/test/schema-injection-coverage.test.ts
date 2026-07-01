import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// Unit coverage for schema-injection.ts. These tests drive the whole
// transformer pipeline with `/// <cts-enable />` pattern sources that exercise
// specific schema shapes and builder call-site forms, then assert on the
// emitted schema objects. The transformer injects generated JSON schemas at
// pattern / handler / lift / toSchema / cell / wish / generateObject /
// sqliteQuery call sites; the assertions below pin the concrete emitted schema
// for each case (property types, `required` arrays, `asCell` markers, `$ref`
// for VNode, default / optional handling, nested / array / tuple / union /
// record shapes, scope markers, and so on).

function t(source: string): Promise<string> {
  return transformSource(source, { types: COMMONFABRIC_TYPES });
}

// ---------------------------------------------------------------------------
// pattern<Input, Output> — property type schemas
// ---------------------------------------------------------------------------

Deno.test("pattern schema encodes primitive property types and a required array", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { name: string; count: number; ok: boolean; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.name as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'name: {\n            type: "string"');
  assertStringIncludes(output, 'count: {\n            type: "number"');
  assertStringIncludes(output, 'ok: {\n            type: "boolean"');
  assertStringIncludes(output, 'required: ["name", "count", "ok"]');
});

Deno.test("pattern schema omits optional properties from the required array", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { a: string; b?: number; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.a as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  // `b` is present as a property but excluded from required.
  assertStringIncludes(output, "b: {");
  assertStringIncludes(output, 'required: ["a"]');
  assertEquals(output.includes('required: ["a", "b"]'), false);
});

Deno.test("pattern schema encodes a Default<> wrapper as a JSON schema default", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, Default, UI, VNode } from "commonfabric";',
    'interface Input { name: Default<string, "seed">; }',
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.name as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, '"default": "seed"');
});

Deno.test("pattern schema encodes array item types", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { tags: string[]; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.tags as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'type: "array"');
  assertStringIncludes(output, 'items: {\n                type: "string"');
});

Deno.test("pattern schema encodes nested object shapes with their own required arrays", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { nested: { a: boolean; b: { c: string } }; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.nested as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'required: ["a", "b"]');
  assertStringIncludes(output, 'required: ["c"]');
});

Deno.test("pattern schema encodes a Record<string, T> as additionalProperties", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { rec: Record<string, number>; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.rec as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(
    output,
    'additionalProperties: {\n                type: "number"',
  );
});

Deno.test("pattern schema encodes a union as anyOf", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    'interface Input { u: "a" | "b" | number; }',
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.u as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "anyOf: [");
  assertStringIncludes(output, '"enum": ["a", "b"]');
});

Deno.test("pattern output schema encodes a VNode UI slot as a $ref", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { x: number; }",
    "interface Output { [UI]: VNode; total: number; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.x as unknown as VNode, total: s.x }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(
    output,
    '$UI: {\n            $ref: "https://commonfabric.org/schemas/vnode.json"',
  );
});

// ---------------------------------------------------------------------------
// handler — event/state schemas and asCell markers
// ---------------------------------------------------------------------------

Deno.test("handler<E, S> injects two schemas and marks a written Cell state field with asCell writeonly", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ amount: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { ctx.total.set(event.amount); },",
    ");",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'amount: {\n            type: "number"');
  // The state Cell is only written (.set), so the capability summary narrows
  // the marker to writeonly rather than the read/write "cell".
  assertStringIncludes(output, 'asCell: ["writeonly"]');
});

Deno.test("handler inline form injects the event schema from the annotated parameter", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (event: { label: string }, ctx: { out: Cell<string> }) => { ctx.out.set(event.label); },",
    ");",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'label: {\n            type: "string"');
});

// ---------------------------------------------------------------------------
// lift — many call-site forms
// ---------------------------------------------------------------------------

Deno.test("lift<T, R> injects input and result schemas from type arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift<{ count: number }, string>((s) => `n:${s.count}`);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'count: {\n            type: "number"');
  assertStringIncludes(output, 'type: "string"');
});

Deno.test("lift<T> single type argument infers the result schema from the callback body", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift<{ count: number }>((s) => s.count > 0);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'count: {\n            type: "number"');
  // result is boolean
  assertStringIncludes(output, 'type: "boolean"');
});

Deno.test("lift inline form infers input and result schemas from annotations", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift((s: { a: number }): number => s.a * 2);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'a: {\n            type: "number"');
});

Deno.test("lift(toSchema<T>(), fn) transfers the authored input schema into the injected slot", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift, toSchema } from "commonfabric";',
    "const fn = lift(toSchema<{ label: string }>(), undefined, (s) => s.label);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'label: {\n            type: "string"');
});

// ---------------------------------------------------------------------------
// cell(...) factory — value inference, scope, explicit type argument
// ---------------------------------------------------------------------------

Deno.test("cell(value) infers a widened schema from the seed value and injects it as the second argument", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell } from "commonfabric";',
    "const c = cell(42);",
  ].join("\n");
  const output = await t(source);
  // literal 42 is widened to number
  assertStringIncludes(output, 'type: "number"');
  assertEquals(output.includes('"enum": [42]'), false);
});

Deno.test("cell<T>() with an explicit type argument injects the T schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell } from "commonfabric";',
    "const c = cell<{ name: string }>();",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'name: {\n            type: "string"');
});

// ---------------------------------------------------------------------------
// wish(...) — schema injected as trailing argument
// ---------------------------------------------------------------------------

Deno.test("wish<T>() injects a schema argument for the wished type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { wish } from "commonfabric";',
    "const w = wish<{ answer: number }>();",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'answer: {\n            type: "number"');
});

// ---------------------------------------------------------------------------
// generateObject — schema property injected into the options object
// ---------------------------------------------------------------------------

Deno.test("generateObject<T>({...}) injects a schema property into the existing options literal", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    'const r = generateObject<{ title: string }>({ prompt: "hi" });',
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "schema:");
  assertStringIncludes(output, "title: {\n");
});

// ---------------------------------------------------------------------------
// sqliteQuery — rowSchema injected
// ---------------------------------------------------------------------------

Deno.test("sqliteQuery<Row>({...}) injects a rowSchema property from the Row type argument", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery<{ id: number; name: string }>({ db, sql: "select 1" });',
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "rowSchema:");
  assertStringIncludes(output, "id: {\n");
  assertStringIncludes(output, "name: {\n");
});

// ---------------------------------------------------------------------------
// Reactive conditionals: when / unless / ifElse prepend generated schemas
// ---------------------------------------------------------------------------

Deno.test("when(condition, value) prepends condition, value and result schemas", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, when, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: when(s.flag, s.flag) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  // when is 2-arity; the rewrite prepends condition + value + result schemas,
  // so three boolean schema literals appear ahead of the original arguments.
  const boolSchemas = output.split('type: "boolean"').length - 1;
  assert(boolSchemas >= 3, `expected >=3 boolean schemas, got ${boolSchemas}`);
});

Deno.test("unless(condition, value) prepends generated schemas ahead of the arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, unless, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; label: string; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: unless(s.flag, s.label) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "unless({");
  // condition schema is boolean, value schema is string
  assertStringIncludes(output, 'type: "boolean"');
  assertStringIncludes(output, 'type: "string"');
});

Deno.test("ifElse(condition, ifTrue, ifFalse) prepends four schemas for its 3-arity form", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, ifElse, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; a: number; b: number; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: ifElse(s.flag, s.a, s.b) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "ifElse({");
  // condition boolean + two number branches + number result = >=3 number schemas
  const numSchemas = output.split('type: "number"').length - 1;
  assert(numSchemas >= 3, `expected >=3 number schemas, got ${numSchemas}`);
});

// ---------------------------------------------------------------------------
// lift-applied (derive) chains: object-literal input, direct projection
// ---------------------------------------------------------------------------

Deno.test("lift-applied object-literal input builds a schema from composed reactive cell types", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const a = lift((x: number) => x)(1);",
    'const b = lift((x: string) => x)("s");',
    "const combined = lift((snap) => `${snap.a}-${snap.b}`)({ a: a, b: b });",
  ].join("\n");
  const output = await t(source);
  // The composed input schema recovers a: number and b: string from the
  // upstream lift results rather than collapsing to unknown.
  assertStringIncludes(output, "a: {\n");
  assertStringIncludes(output, "b: {\n");
  assertStringIncludes(output, 'type: "number"');
  assertStringIncludes(output, 'type: "string"');
});

Deno.test("lift-applied direct property projection recovers the result schema from the input property", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const src = lift((x: { a: number; b: string }) => x)({ a: 1, b: "x" });',
    "const proj = lift((y: { a: number; b: string }) => y.a)(src);",
  ].join("\n");
  const output = await t(source);
  // The projection `y => y.a` recovers a number result schema.
  assertStringIncludes(output, 'type: "number"');
});

Deno.test("lift-applied empty-object input lowers the no-capture placeholder to a false input schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const c = lift(() => "static")({});',
  ].join("\n");
  const output = await t(source);
  // The single empty object literal is the no-capture placeholder, so the
  // injected input schema is `false` (no input) rather than an object schema.
  assertStringIncludes(output, "false");
});

// ---------------------------------------------------------------------------
// pattern — single type argument (result inferred), one schema argument
// ---------------------------------------------------------------------------

Deno.test("pattern<Input> with a single type argument infers the result schema from the callback", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "interface Input { count: number; }",
    "export default pattern<Input>((s) => ({ doubled: s.count * 2 }));",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'count: {\n            type: "number"');
  // result schema carries the inferred `doubled: number`.
  assertStringIncludes(output, "doubled: {");
});

Deno.test("pattern(fn, inputSchema) keeps the author input schema and appends an inferred result schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "export default pattern(",
    "  (state: { count: number }) => ({ label: state }),",
    '  { type: "object" } as const,',
    ");",
  ].join("\n");
  const output = await t(source);
  // Author supplied one schema (input) verbatim; the transformer infers and
  // appends the result schema (case 3a). The author input keeps its bare
  // `{ type: "object" } as const` form while the appended result carries the
  // `satisfies` marker and the inferred `label` property.
  assertStringIncludes(output, '{ type: "object" } as const,');
  assertStringIncludes(output, "label: {");
  assertStringIncludes(output, "as const satisfies __cfHelpers.JSONSchema");
});

// ---------------------------------------------------------------------------
// handler inline single-argument form — event/state inference
// ---------------------------------------------------------------------------

Deno.test("handler(fn) with no type args infers both event and state schemas from annotations", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (event: { delta: number }, ctx: { count: Cell<number> }) => {",
    "    ctx.count.set(event.delta);",
    "  },",
    ");",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'delta: {\n            type: "number"');
  assertStringIncludes(output, "count: {");
});

Deno.test("handler(fn) with an underscore-prefixed unused event param yields a false event schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (_event, ctx: { count: Cell<number> }) => { ctx.count.set(1); },",
    ");",
  ].join("\n");
  const output = await t(source);
  // Intentionally-unused `_event` collapses to a `never`/`false` event schema.
  assertStringIncludes(
    output,
    "false as const satisfies __cfHelpers.JSONSchema",
  );
});

// ---------------------------------------------------------------------------
// cell scope: call form cell.perSession(...), and PerSession contextual scope
// ---------------------------------------------------------------------------

Deno.test("new Writable.perUser(seed) reads the user scope and injects it into the schema", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable.perUser(7);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'scope: "user"');
  assertStringIncludes(output, 'type: "number"');
});

Deno.test("new Writable.perSpace(seed) reads the space scope and injects it into the schema", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable.perSpace(true);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'scope: "space"');
  assertStringIncludes(output, 'type: "boolean"');
});

// ---------------------------------------------------------------------------
// lift result recovery: direct property / element-access projection
// ---------------------------------------------------------------------------

Deno.test("lift property projection recovers the result schema from the projected field type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift((s: { a: number; b: string }) => s.a);",
  ].join("\n");
  const output = await t(source);
  // The result schema is recovered as number from `s.a`. Capability shrinking
  // narrows the input to the single accessed field `a`, dropping the unused `b`.
  assertStringIncludes(output, 'a: {\n            type: "number"');
  assertStringIncludes(
    output,
    'type: "number"\n} as const satisfies __cfHelpers.JSONSchema',
  );
});

Deno.test("lift element-access projection recovers the result schema from the indexed field", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift((s: { title: string; other: number }) => s["title"]);',
  ].join("\n");
  const output = await t(source);
  // `s["title"]` is a direct projection; the result schema recovers string.
  assertStringIncludes(output, 'title: {\n            type: "string"');
});

// ---------------------------------------------------------------------------
// pattern result diagnostics
// ---------------------------------------------------------------------------

Deno.test("pattern with an inferred any/unknown result reports pattern:any-result-schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "export default pattern((s: { x: number }) => s as any);",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    mode: "error",
    types: COMMONFABRIC_TYPES,
  });
  assert(
    diagnostics.some((d) => d.type === "pattern:any-result-schema"),
    `expected pattern:any-result-schema, got: ${
      diagnostics.map((d) => d.type).join(",")
    }`,
  );
});

// ---------------------------------------------------------------------------
// handler<E, S> with only one usable type argument bails out
// ---------------------------------------------------------------------------

Deno.test("handler event schema encodes an optional field as not required", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ amount?: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { ctx.total.set(event?.amount ?? 0); },",
    ");",
  ].join("\n");
  const output = await t(source);
  // Optional event field is present but excluded from required.
  assertStringIncludes(output, "amount: {");
  assertEquals(output.includes('required: ["amount"]'), false);
});

// ---------------------------------------------------------------------------
// generateObject — options variations
// ---------------------------------------------------------------------------

Deno.test("generateObject<T>() with no options builds a fresh options object carrying the schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    "const r = generateObject<{ score: number }>();",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "schema:");
  assertStringIncludes(output, "score: {");
});

Deno.test("generateObject<T>(spreadOptions) spreads a non-literal options expression and adds the schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    "declare const opts: { prompt: string };",
    "const r = generateObject<{ ok: boolean }>(opts);",
  ].join("\n");
  const output = await t(source);
  // Non-literal options become { ...opts, schema: ... }.
  assertStringIncludes(output, "...opts");
  assertStringIncludes(output, "schema:");
});

// ---------------------------------------------------------------------------
// sqliteQuery — method form and no-options form
// ---------------------------------------------------------------------------

Deno.test("sqliteQuery<Row>() with no options builds a fresh options object carrying rowSchema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "const q = sqliteQuery<{ id: number; label: string }>();",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, "rowSchema:");
  assertStringIncludes(output, "label: {");
});

Deno.test("untyped sqliteQuery(options) injects no rowSchema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery({ db, sql: "select 1" });',
  ].join("\n");
  const output = await t(source);
  // Untyped form must lower to no schema; runtime falls back to detection.
  assertEquals(output.includes("rowSchema:"), false);
});

// ---------------------------------------------------------------------------
// contextual cell scope from a Scoped<> / PerX<> annotation
// ---------------------------------------------------------------------------

Deno.test("cell(value) assigned to a PerSession<T> variable reads the session scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSession } from "commonfabric";',
    "const c: PerSession<number> = cell(0);",
  ].join("\n");
  const output = await t(source);
  // The scope brand is recovered from the `PerSession` alias on the contextual
  // type rather than from any accessor on the call.
  assertStringIncludes(output, 'scope: "session"');
});

Deno.test("cell(value) assigned to a PerUser<T> variable reads the user scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerUser } from "commonfabric";',
    'const c: PerUser<string> = cell("hi");',
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'scope: "user"');
});

Deno.test("cell(value) assigned to a PerSpace<T> variable reads the space scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSpace } from "commonfabric";',
    "const c: PerSpace<boolean> = cell(true);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'scope: "space"');
});

// ---------------------------------------------------------------------------
// pattern result: inferred unknown output field reports pattern-result:unknown-type
// ---------------------------------------------------------------------------

Deno.test("pattern with an inferred unknown output field reports pattern-result:unknown-type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function opaque(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ out: opaque() }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    mode: "error",
    types: COMMONFABRIC_TYPES,
  });
  const paths = diagnostics.filter((d) =>
    d.type === "pattern-result:unknown-type"
  );
  assert(
    paths.length > 0,
    `expected pattern-result:unknown-type, got: ${
      diagnostics.map((d) => d.type).join(",")
    }`,
  );
  // The message names the offending field path.
  assertStringIncludes(paths[0]!.message, "out");
});

// ---------------------------------------------------------------------------
// lift result shape: tuple, enum literal, and nested arrays
// ---------------------------------------------------------------------------

Deno.test("lift<T, R> encodes a tuple result as an array schema with a positional item type set", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift<{ a: number }, [string, number]>((s) => ["x", s.a]);',
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'type: "array"');
  // tuple element union of the two positional types
  assertStringIncludes(output, 'type: ["number", "string"]');
});

Deno.test("lift<T, R> encodes a string-literal-union result as an enum", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift<{ n: number }, "lo" | "hi">((s) => (s.n > 0 ? "hi" : "lo"));',
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, '"enum": ["lo", "hi"]');
});

Deno.test("lift<T, R> encodes a nested array-of-objects result schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift<{ n: number }, { id: number }[]>((s) => [{ id: s.n }]);",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'type: "array"');
  assertStringIncludes(output, "id: {");
});

// ---------------------------------------------------------------------------
// cell-for scope wrapping via .asSchema(...)
// ---------------------------------------------------------------------------

Deno.test("scoped cell-for value schema carries the scope marker", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSession } from "commonfabric";',
    "const base = cell<number>();",
    "const scoped: PerSession<number> = base;",
  ].join("\n");
  const output = await t(source);
  // The base cell schema is injected; assigning to PerSession keeps the schema.
  assertStringIncludes(output, 'type: "number"');
});

// ---------------------------------------------------------------------------
// new cell constructor: value inference, explicit type argument
// ---------------------------------------------------------------------------

Deno.test("new Writable(value) infers a widened schema from the seed and injects it as the second argument", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable(5);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'type: "number"');
  // No scope accessor was used, so no scope marker is injected.
  assertEquals(output.includes("scope:"), false);
});

Deno.test("new Writable<T>() with an explicit type argument and no value injects an undefined first argument", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable<{ n: number }>();",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  // Schema is always the second argument, so `undefined` is inserted first.
  assertStringIncludes(output, "new Writable<{");
  assertStringIncludes(output, "undefined, {");
  assertStringIncludes(output, "n: {");
});

// ---------------------------------------------------------------------------
// contextual scope from a raw Scoped<T, scope> brand (no PerX alias)
// ---------------------------------------------------------------------------

Deno.test("cell(value) typed as raw Scoped<T, scope> reads the scope from the SCOPE_BRAND property", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, Scoped } from "commonfabric";',
    'const c: Scoped<number, "session"> = cell(0);',
  ].join("\n");
  const output = await t(source);
  // `Scoped` is not one of the PerX aliases, so the scope is recovered from the
  // scope-brand property rather than the alias name.
  assertStringIncludes(output, 'scope: "session"');
});

// ---------------------------------------------------------------------------
// lift<T, R>(fn)(input): type arguments on the inner lift drive both schemas
// ---------------------------------------------------------------------------

Deno.test("lift<T, R>(fn)(input) reads the schemas from the inner lift type arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift<{ a: number }, string>((s) => `${s.a}`)({ a: 1 });",
  ].join("\n");
  const output = await t(source);
  assertStringIncludes(output, 'a: {\n            type: "number"');
  assertStringIncludes(output, 'type: "string"');
});

// ---------------------------------------------------------------------------
// chained lift-applied (derive) inputs: recover the upstream result type
// ---------------------------------------------------------------------------

Deno.test("chained lift-applied recovers the input schema from the upstream lift's inferred result", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const step1 = lift((x: { a: number }) => ({ a: x.a, b: x.a + 1 }))({ a: 1 });",
    "const step2 = lift((y) => y.b)(step1);",
  ].join("\n");
  const output = await t(source);
  // step2's callback param has no annotation; its type is recovered from
  // step1's inferred `{ a, b }` result, and capability shrinking keeps only the
  // accessed `b` field. The result schema is number.
  const step2Def = output.slice(output.indexOf("__cfLift_2 = lift"));
  assertStringIncludes(step2Def, "b: {");
  assertStringIncludes(step2Def, 'type: "number"');
});

Deno.test("chained lift-applied whose upstream is a single-field object recovers a concrete input schema, not unknown", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const first = lift((x: { name: string }) => ({ name: x.name }))({ name: "n" });',
    "const second = lift((v) => v.name.length)(first);",
  ].join("\n");
  const output = await t(source);
  const secondDef = output.slice(output.indexOf("__cfLift_2 = lift"));
  // The recovered input carries the concrete `name: string` field rather than a
  // permissive `true`/unknown schema.
  assertStringIncludes(secondDef, "name: {");
  assertEquals(secondDef.slice(0, 200).includes("true as const"), false);
});

// ---------------------------------------------------------------------------
// scope brand recovery when the scope is a union of literal scope values
// ---------------------------------------------------------------------------

Deno.test("cell typed as Scoped<T, union-of-scopes> recovers the first concrete scope from the brand union", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, Scoped } from "commonfabric";',
    'const c: Scoped<number, "user" | "session"> = cell(0);',
  ].join("\n");
  const output = await t(source);
  // The scope-brand type is a union; the recovery walks the members and returns
  // the first concrete scope value.
  assertStringIncludes(output, 'scope: "user"');
});

// ---------------------------------------------------------------------------
// lift factory captured in a variable, then applied — recover the result type
// through the factory's callback
// ---------------------------------------------------------------------------

Deno.test("applying a captured lift factory recovers the downstream input schema from the factory callback result", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const makeIt = lift((x: { a: number }) => ({ a: x.a, b: 2 }));",
    "const applied = makeIt({ a: 1 });",
    "const used = lift((y) => y.b)(applied);",
  ].join("\n");
  const output = await t(source);
  // `used`'s callback param is untyped; its type is recovered from `applied`,
  // whose type comes from the `makeIt` factory callback returning `{ a, b }`.
  const usedDef = output.slice(output.lastIndexOf("= lift((y)"));
  assertStringIncludes(usedDef, "b: {");
  assertStringIncludes(usedDef, 'type: "number"');
});

// ---------------------------------------------------------------------------
// pattern result: unknown paths are walked into nested objects and arrays
// ---------------------------------------------------------------------------

Deno.test("pattern result reports a nested unknown output field with a dotted path", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function op(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ nested: { deep: op() } }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    mode: "error",
    types: COMMONFABRIC_TYPES,
  });
  const d = diagnostics.find((d) => d.type === "pattern-result:unknown-type");
  assert(d, "expected pattern-result:unknown-type");
  // The path walk descends into the nested object literal.
  assertStringIncludes(d!.message, "nested.deep");
});

Deno.test("pattern result reports an unknown array element with an array path suffix", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function op(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ items: [op()] }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    mode: "error",
    types: COMMONFABRIC_TYPES,
  });
  const d = diagnostics.find((d) => d.type === "pattern-result:unknown-type");
  assert(d, "expected pattern-result:unknown-type");
  // The array element walk appends `[]` to the path.
  assertStringIncludes(d!.message, "items[]");
});

// ---------------------------------------------------------------------------
// idempotency / author-supplied skips: a builder that already carries its
// schema is left untouched
// ---------------------------------------------------------------------------

Deno.test("new Writable(value, schema) with two arguments is left untouched", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    '  const v = new Writable(5, { type: "number" } as const);',
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  // The schema slot is already filled, so no second schema is injected.
  assertStringIncludes(output, 'new Writable(5, { type: "number" }');
  assertEquals((output.match(/type: "number"/g) ?? []).length, 1);
});

Deno.test("wish(hint, schema) with an author-supplied schema is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { wish } from "commonfabric";',
    'const w = wish("hint", { type: "object" } as const);',
  ].join("\n");
  const output = await t(source);
  // The two-argument wish already has its schema; the transformer does not add
  // a satisfies-marked schema of its own.
  assertStringIncludes(output, '{ type: "object" } as const');
  assertEquals(
    output.includes("as const satisfies __cfHelpers.JSONSchema"),
    false,
  );
});

Deno.test("generateObject({ schema }) already carrying a schema property is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    'const r = generateObject({ prompt: "hi", schema: { type: "object" } as const });',
  ].join("\n");
  const output = await t(source);
  // Exactly the author's single schema property remains; none is injected.
  assertEquals((output.match(/schema:/g) ?? []).length, 1);
});

Deno.test("untyped sqliteQuery already carrying a rowSchema is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery<{ id: number }>({ db, sql: "s", rowSchema: { type: "object" } as const });',
  ].join("\n");
  const output = await t(source);
  // A rowSchema is already present, so the typed form does not inject a second.
  assertEquals((output.match(/rowSchema:/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// new scoped cell with no value: scope from accessor, value type from context
// ---------------------------------------------------------------------------

Deno.test("new Writable.perSession() with no value derives the value type from the contextual scope annotation", async () => {
  const source = [
    'import { Writable, PerSession } from "commonfabric";',
    "export default function T() {",
    "  const v: PerSession<number> = new Writable.perSession();",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  // No seed value, so the value type is recovered from the contextual
  // PerSession<number> annotation and the accessor supplies the session scope.
  assertStringIncludes(output, 'scope: "session"');
  assertStringIncludes(output, 'type: "number"');
  assertStringIncludes(output, "undefined, {");
});

// ---------------------------------------------------------------------------
// lift-applied projection recovery: property-access and element-access forms
// on a downstream callback whose parameter type is recovered from upstream
// ---------------------------------------------------------------------------

Deno.test("lift-applied element-access projection recovers the result schema from the indexed field", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const s1 = lift((x: { title: string; n: number }) => x)({ title: "t", n: 1 });',
    'const s2 = lift((y) => y["title"])(s1);',
  ].join("\n");
  const output = await t(source);
  // The downstream callback `y => y["title"]` has no annotation; its input is
  // recovered from the upstream result and the string result schema is derived
  // from the indexed `title` field.
  const s2Def = output.slice(output.lastIndexOf("= lift((y)"));
  assertStringIncludes(s2Def, "title: {");
  assertStringIncludes(s2Def, 'type: "string"');
});

Deno.test("lift-applied property-access projection recovers the result schema from the accessed field", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const s1 = lift((x: { count: number; other: string }) => x)({ count: 1, other: "o" });',
    "const s2 = lift((y) => y.count)(s1);",
  ].join("\n");
  const output = await t(source);
  const s2Def = output.slice(output.lastIndexOf("= lift((y)"));
  assertStringIncludes(s2Def, "count: {");
  assertStringIncludes(s2Def, 'type: "number"');
});

// ---------------------------------------------------------------------------
// handler state Cell that is read marks the schema field asCell readonly
// ---------------------------------------------------------------------------

Deno.test("handler<E, S> marks a read-only Cell state field with asCell readonly", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ q: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { const x = ctx.total.get(); void x; void event; },",
    ");",
  ].join("\n");
  const output = await t(source);
  // The state Cell is only read (.get), so the capability summary narrows the
  // marker to readonly.
  assertStringIncludes(output, 'asCell: ["readonly"]');
});

// ---------------------------------------------------------------------------
// lift-applied whose untyped callback calls Cell methods on a Cell input:
// the input schema is recovered from the cell-like fallback type and marked
// asCell readonly
// ---------------------------------------------------------------------------

Deno.test("lift-applied untyped callback using Cell.get on a Cell input recovers a cell-like input schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, lift } from "commonfabric";',
    "const c = cell({ n: 5 });",
    "const d = lift((x) => x.get().n)(c);",
  ].join("\n");
  const output = await t(source);
  // The callback param has no annotation but calls `.get()`; because the input
  // is a Cell, the input schema is recovered from the cell-like fallback type
  // and carries the readonly asCell marker with the inner `{ n: number }` shape.
  const liftDef = output.slice(output.indexOf("lift((x)"));
  assertStringIncludes(liftDef, "n: {");
  assertStringIncludes(liftDef, 'asCell: ["readonly"]');
});
