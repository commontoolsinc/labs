import { assert, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * Drives the SchemaGeneratorTransformer end to end through the pipeline. Each
 * test pins the emitted `toSchema<T>()` -> `{...} as const satisfies
 * __cfHelpers.JSONSchema` literal for a shape that the existing schema tests do
 * not exercise: non-finite and negative numeric literals, the write-authorized
 * identity marker, the CFC UI-contract hint on boolean and object schemas, and
 * the option-object value evaluator.
 */

async function schemaLiteral(source: string): Promise<string> {
  const out = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const match = out.match(
    /const s = [\s\S]*?satisfies __cfHelpers\.JSONSchema/,
  );
  assert(match, `no schema literal found in output:\n${out}`);
  return match[0];
}

Deno.test("numeric-literal types lower to NaN, Infinity, -Infinity and negatives", async () => {
  // NaN has no numeric-literal form (emitted as the global NaN), positive and
  // negative infinity emit the Infinity identifier with an optional unary minus,
  // and a negative literal emits a unary-minus wrapper around a positive value.
  const literal = await schemaLiteral(`/// <cts-enable />
import { toSchema } from "commonfabric";
const enum E { NaNValue = 0 / 0 }
interface C { big: 1e999; small: -1e999; neg: -7; tag: E.NaNValue; }
const s = toSchema<C>({ maximum: E.NaNValue });
export { s };
`);
  assertStringIncludes(literal, '"enum": [Infinity]');
  assertStringIncludes(literal, '"enum": [-Infinity]');
  assertStringIncludes(literal, '"enum": [-7]');
  assertStringIncludes(literal, '"enum": [NaN]');
  assertStringIncludes(literal, "maximum: NaN");
});

Deno.test("WriteAuthorizedBy attaches a writer-identity marker with file and path", async () => {
  // The second type argument `typeof saver` is a simple identifier type-query,
  // so the schema gains an `ifc.writeAuthorizedBy.__ctWriterIdentityOf` marker
  // carrying the source file and the binding path.
  const literal = await schemaLiteral(`/// <cts-enable />
import { toSchema, WriteAuthorizedBy, handler } from "commonfabric";
const saver = handler({}, {}, () => {});
const s = toSchema<WriteAuthorizedBy<{ title: string }, typeof saver>>();
export { s };
`);
  assertStringIncludes(literal, "writeAuthorizedBy");
  assertStringIncludes(literal, "__ctWriterIdentityOf");
  assertStringIncludes(literal, 'path: ["saver"]');
  assertStringIncludes(literal, 'file: "/test.tsx"');
});

Deno.test("WriteAuthorizedBy with a qualified typeof binding attaches no marker", async () => {
  // A qualified `typeof container.save` is not a plain identifier type-query, so
  // the identity extraction bails and no writer-identity marker is emitted.
  const literal = await schemaLiteral(`/// <cts-enable />
import { toSchema, WriteAuthorizedBy } from "commonfabric";
const container = { save() {} };
const s = toSchema<WriteAuthorizedBy<{ title: string }, typeof container.save>>();
export { s };
`);
  assertStringIncludes(literal, 'type: "object"');
  assert(!literal.includes("writeAuthorizedBy"));
});

Deno.test("UI-contract hint attaches to an object $UI property schema", async () => {
  // The `<UiAction>` in the UI slot records a hint that is grafted onto the
  // generated $UI property schema's `ifc.uiContract`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  assertStringIncludes(out, "uiContract");
  assertStringIncludes(out, '"UiAction"');
  assertStringIncludes(out, '"SubmitDirectCommand"');
});

Deno.test("UI-contract hint wraps a boolean-true $UI property as an ifc-only schema", async () => {
  // When the output type declares `[UI]: any`, the $UI property schema is the
  // boolean `true`; attaching the contract turns it into `{ ifc: { uiContract }}`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
type Out = { title: string; [UI]: any };
export default pattern<{ title: string }, Out>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  assertStringIncludes(out, "$UI: {");
  assertStringIncludes(out, "uiContract");
  assertStringIncludes(out, '"SubmitDirectCommand"');
});

Deno.test("UI-contract hint on a whole boolean-true schema becomes an ifc-only schema", async () => {
  // An `any` output type makes the whole generated schema the boolean `true`,
  // so the contract is attached as `{ ifc: { uiContract } }` without a `not`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }, any>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  assertStringIncludes(out, "uiContract");
  assertStringIncludes(out, '"SubmitDirectCommand"');
  assert(!out.includes("not: true"), `unexpected not:true in ${out}`);
});

Deno.test("UI-contract hint on a whole boolean-false schema negates via not:true", async () => {
  // A `never` output type makes the whole generated schema the boolean `false`,
  // so the contract is attached as `{ not: true, ifc: { uiContract } }`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }, never>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  assertStringIncludes(out, "not: true");
  assertStringIncludes(out, "uiContract");
});

Deno.test("toSchema option object evaluates literals, arrays, nested objects and constants", async () => {
  // The options bag is spread onto the emitted schema; booleans, null, arrays,
  // nested object literals and enum-constant references are all evaluated, while
  // an undefined-valued option is dropped.
  const literal = await schemaLiteral(`/// <cts-enable />
import { toSchema } from "commonfabric";
const enum E { V = 5 }
interface C { value: number; }
const s = toSchema<C>({
  flagTrue: true,
  flagFalse: false,
  nothing: null,
  undef: undefined,
  list: [1, "a", true, null],
  nested: { inner: 3, deep: { x: "y" } },
  constant: E.V,
});
export { s };
`);
  assertStringIncludes(literal, "flagTrue: true");
  assertStringIncludes(literal, "flagFalse: false");
  assertStringIncludes(literal, "nothing: null");
  assertStringIncludes(literal, 'list: [1, "a", true, null]');
  assertStringIncludes(literal, "inner: 3");
  assertStringIncludes(literal, 'x: "y"');
  assertStringIncludes(literal, "constant: 5");
  assert(!literal.includes("undef:"), "undefined option should be dropped");
});
