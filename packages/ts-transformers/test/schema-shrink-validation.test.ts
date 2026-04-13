import { assertEquals, assertGreater, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

/**
 * Extracts JSON schema literals from transformed output.
 * Schemas appear as either:
 * - `{ type: "object", ... } as const satisfies __cfHelpers.JSONSchema`
 * - `true as const satisfies __cfHelpers.JSONSchema`
 * - `false as const satisfies __cfHelpers.JSONSchema`
 * Returns them in order of appearance.
 */
function extractSchemas(output: string): string[] {
  const schemas: string[] = [];
  const marker = "as const satisfies __cfHelpers.JSONSchema";
  let searchFrom = 0;
  while (true) {
    const markerIdx = output.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    // Walk backwards from marker to find the schema literal.
    let start = markerIdx - 1;
    // Skip whitespace before marker
    while (start >= 0 && /\s/.test(output[start]!)) start--;

    let schemaText: string | undefined;
    if (output[start] === "}") {
      let depth = 1;
      start--;
      while (start >= 0 && depth > 0) {
        if (output[start] === "}") depth++;
        else if (output[start] === "{") depth--;
        start--;
      }
      start++; // back to the opening brace
      schemaText = output.slice(start, markerIdx).trim();
    } else {
      let tokenStart = start;
      while (tokenStart >= 0 && /[A-Za-z]/.test(output[tokenStart]!)) {
        tokenStart--;
      }
      tokenStart++;
      const token = output.slice(tokenStart, start + 1).trim();
      if (token === "true" || token === "false") {
        schemaText = token;
      }
    }

    if (!schemaText) {
      searchFrom = markerIdx + marker.length;
      continue;
    }

    schemas.push(schemaText);
    searchFrom = markerIdx + marker.length;
  }
  return schemas;
}

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

Deno.test("Schema Shrink Validation", async (t) => {
  await t.step(
    "errors when parameter is 'unknown' but code accesses properties",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: unknown) => {",
        "  const x = state.foo;",
        "  const y = state.bar;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected at least one schema:unknown-type-access error",
      );
      assertEquals(shrinkErrors[0]!.type, "schema:unknown-type-access");
    },
  );

  await t.step(
    "errors when declared type is missing an accessed property",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: { a: string }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected at least one schema:path-not-in-type error",
      );
      assertEquals(shrinkErrors[0]!.type, "schema:path-not-in-type");
    },
  );

  await t.step(
    "errors on interprocedural unknown-type access in lift callback",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const helper = (x: unknown) => (x as any).foo;",
        "",
        "const fn = lift((state: unknown) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access from interprocedural lift",
      );
    },
  );

  await t.step(
    "errors on interprocedural path-not-in-type via as-any cast in lift callback",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const helper = (x: { a: string }) => (x as any).b;",
        "",
        "const fn = lift((state: { a: string }) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:path-not-in-type from interprocedural as-any cast",
      );
    },
  );

  await t.step(
    "errors when unknown parameter is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: unknown) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown param passed to opaque function",
      );
    },
  );

  await t.step(
    "no error when any parameter is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: any) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for 'any' but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when unknown parameter is passed to equals in lift",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { equals, lift } from "commonfabric";',
        "",
        "const fn = lift((state: unknown) => equals(state, state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for equals(identity) but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when concrete type is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: { a: string }) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no errors for concrete type but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "errors when unknown parameter is passed to opaque function in pattern",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: unknown) => {",
        "  console.log(state);",
        "  return {};",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown param in pattern passed to opaque function",
      );
    },
  );

  await t.step(
    "errors when interface property is typed unknown in handler",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: unknown;",
        "  note?: unknown;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown-typed property in interface",
      );
    },
  );

  await t.step(
    "errors when interface property is typed unknown in pattern",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "interface State {",
        "  data?: unknown;",
        "}",
        "",
        "export default pattern((state: State) => {",
        "  const x = state.data;",
        "  return { x };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown-typed property in pattern",
      );
    },
  );

  await t.step(
    "no error when interface property is typed any (not unknown)",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: any;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for 'any'-typed property but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when interface property is typed with concrete type",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: number[];",
        "  note?: string;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for concrete-typed properties but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter type is a type alias",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "type Req = { item: string };",
        "",
        "export const h = handler<Req, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for type alias but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no diagnostic when declared type matches all accessed paths",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: { a: string; b: number }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is T | undefined",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount?: number } | undefined, {}>(",
        "  (args) => { console.log(args.amount); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for T | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is a multi-member union",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "export const h = handler<{ value?: number } | number | undefined, {}>(",
        "  (args) => { console.log(args.value); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for multi-member union but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is TypeAlias | undefined",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface Req { item: string }",
        "",
        "export const h = handler<Req | undefined, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for TypeAlias | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when lift accesses numeric index on array",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((items: number[]) => items[0]);",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for array index access but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when lift accesses .length on array type alias",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "type Items = Array<{ name: string }>;",
        "const hasItems = lift<Items, boolean>(",
        "  (items) => items && items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for .length on array type alias but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "errors when lift accesses .length on numeric index signature object",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "type Indexed = { [index: number]: string };",
        "const hasItems = lift<Indexed, boolean>(",
        "  (items) => items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        `Expected schema:path-not-in-type for numeric index signature .length access but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler without type args has SomeType | undefined param",
    async () => {
      // Reproduces pattern-ingredient-scaler: handler() without type args
      // where the callback param is SomeType | undefined and accesses a property.
      const source = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ServingsEvent { servings?: number; delta?: number }",
        "",
        "const setServings = handler(",
        "  (event: ServingsEvent | undefined, context: { desiredServings: Cell<number> }) => {",
        "    context.desiredServings.set(event?.servings ?? 1);",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for handler with SomeType | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  // =========================================================================
  // Type-arg form vs inline form: schemas must be identical
  // =========================================================================

  await t.step(
    "handler<E, T> generates same schemas as handler((e: E, t: T) => ...)",
    async () => {
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount: number }, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event.amount); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler(",
        "  (event: { amount: number }, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event.amount);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<E,T> form had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "handler schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "handler<E | undefined, T> preserves | undefined in both forms",
    async () => {
      // Both forms preserve `| undefined` in the event schema.
      // Remaining divergence: optional property encoding differs
      // (type-arg: {type:"number"}, inline: {anyOf:[{type:"number"},{type:"undefined"}]}).
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount?: number } | undefined, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event?.amount ?? 0); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler(",
        "  (event: { amount?: number } | undefined, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event?.amount ?? 0);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<E|undefined,T> had shrink errors: ${
          fmtErrors(rTA.diagnostics)
        }`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline union form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      // Both event schemas should contain "undefined" (not stripped)
      assertEquals(
        schemasTA[0]!.includes('"undefined"'),
        true,
        "type-arg event schema should preserve undefined",
      );
      assertEquals(
        schemasInline[0]!.includes('"undefined"'),
        true,
        "inline event schema should preserve undefined",
      );
      // State schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "handler state schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "handler<TypeAlias | undefined, TypeAlias> preserves | undefined in both forms",
    async () => {
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ScaleEvent { servings?: number; delta?: number }",
        "interface ScaleState { desiredServings: Cell<number> }",
        "",
        "export const h = handler<ScaleEvent | undefined, ScaleState>(",
        "  (event, ctx) => { ctx.desiredServings.set(event?.servings ?? 1); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ScaleEvent { servings?: number; delta?: number }",
        "interface ScaleState { desiredServings: Cell<number> }",
        "",
        "export const h = handler(",
        "  (event: ScaleEvent | undefined, ctx: ScaleState) => {",
        "    ctx.desiredServings.set(event?.servings ?? 1);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline alias form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      // Both event schemas should contain "undefined" (not stripped)
      assertEquals(
        schemasTA[0]!.includes('"undefined"'),
        true,
        "type-arg event schema should preserve undefined",
      );
      assertEquals(
        schemasInline[0]!.includes('"undefined"'),
        true,
        "inline event schema should preserve undefined",
      );
      // State schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "handler state schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<T, R> generates same schemas as lift((x: T): R => ...)",
    async () => {
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift<{ count: number }, string>(",
        "  (state) => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift(",
        "  (state: { count: number }): string => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<T,R> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline had shrink errors: ${fmtErrors(rInline.diagnostics)}`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "lift schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<T | undefined, R> preserves | undefined in both forms",
    async () => {
      // Both forms now preserve `| undefined` in the input schema.
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift<{ count: number } | undefined, number>(",
        "  (state) => state?.count ?? 0,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift(",
        "  (state: { count: number } | undefined): number => state?.count ?? 0,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<T|undefined,R> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline union had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      // Both input schemas should contain "undefined" (not stripped)
      assertEquals(
        schemasTA[0]!.includes('"undefined"'),
        true,
        "type-arg input schema should preserve undefined",
      );
      assertEquals(
        schemasInline[0]!.includes('"undefined"'),
        true,
        "inline input schema should preserve undefined",
      );
      // Result schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "lift result schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<TypeAlias, R> generates same schemas as lift with inline alias",
    async () => {
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift<Item, string>(",
        "  (item) => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift(",
        "  (item: Item): string => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline alias had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "lift type-alias schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "pattern<T> and inline destructured form produce identical schemas",
    async () => {
      const sourceTypeArgs = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern<{ name: string; count: number }>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern(({ name, count }: { name: string; count: number }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `pattern<T> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `pattern inline had shrink errors: ${fmtErrors(rInline.diagnostics)}`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      assertGreater(
        schemasTA.length,
        0,
        "type-arg form should produce schemas",
      );
      assertGreater(
        schemasInline.length,
        0,
        "inline form should produce schemas",
      );
      assertEquals(
        schemasTA,
        schemasInline,
        "pattern schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "pattern<TypeAlias> and inline destructured alias form produce identical schemas",
    async () => {
      const sourceTypeArgs = [
        'import { pattern } from "commonfabric";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern<Args>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        'import { pattern } from "commonfabric";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern(({ name, count }: Args) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `pattern<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `pattern inline alias had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = extractSchemas(rTA.output);
      const schemasInline = extractSchemas(rInline.output);
      assertGreater(
        schemasTA.length,
        0,
        "type-arg form should produce schemas",
      );
      assertGreater(
        schemasInline.length,
        0,
        "inline form should produce schemas",
      );
      assertEquals(
        schemasTA,
        schemasInline,
        "pattern schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "derive object-literal input preserves property schemas",
    async () => {
      const source = [
        'import { cell, derive, lift } from "commonfabric";',
        "",
        'const stage = cell<string>("initial");',
        "const attemptCount = cell<number>(0);",
        "const acceptedCount = cell<number>(0);",
        "const rejectedCount = cell<number>(0);",
        "",
        "const normalizedStage = lift((value: string) => value)(stage);",
        "const attempts = lift((count: number) => count)(attemptCount);",
        "const accepted = lift((count: number) => count)(acceptedCount);",
        "const rejected = lift((count: number) => count)(rejectedCount);",
        "",
        "const _summary = derive(",
        "  {",
        "    stage: normalizedStage,",
        "    attempts: attempts,",
        "    accepted: accepted,",
        "    rejected: rejected,",
        "  },",
        "  (snapshot) =>",
        "    `stage:${snapshot.stage} attempts:${snapshot.attempts}` +",
        "    ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`,",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      assertStringIncludes(result.output, "stage: {");
      assertStringIncludes(result.output, "attempts: {");
      assertStringIncludes(result.output, "accepted: {");
      assertStringIncludes(result.output, "rejected: {");
      assertEquals(result.output.includes("stage: true"), false);
      assertEquals(result.output.includes("attempts: true"), false);
      assertEquals(result.output.includes("accepted: true"), false);
      assertEquals(result.output.includes("rejected: true"), false);
    },
  );

  await t.step(
    "derive shrinks array items through ?? fallback aliases and for...of loops",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive } from "commonfabric";',
        "type Note = { title: string; body: string };",
        "type NotebookPiece = {",
        "  notes?: Note[];",
        "  metadata: { author: string; tags: string[] };",
        "};",
        "const pieces = {} as NotebookPiece[];",
        "const total = derive({ pieces }, ({ pieces }) => {",
        "  const items = pieces ?? [];",
        "  let count = 0;",
        "  for (const piece of items) {",
        "    count += piece.notes?.length ?? 0;",
        "  }",
        "  return count;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "notes");
      assertEquals(inputSchema.includes("metadata"), false);
      assertEquals(inputSchema.includes("author"), false);
      assertEquals(inputSchema.includes("body"), false);
    },
  );

  await t.step(
    "lift validates direct array parameters against item fields used in for...of loops",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type AssetRecord = {",
        "  id: string;",
        "  stage: string;",
        "  owner: string;",
        "  unused: { nested: string };",
        "};",
        "type StageBucket = { id: string; stage: string; owner: string };",
        "const toBuckets = lift((entries: AssetRecord[]): StageBucket[] => {",
        "  const buckets: StageBucket[] = [];",
        "  for (const entry of entries) {",
        "    buckets.push({",
        "      id: entry.id,",
        "      stage: entry.stage,",
        "      owner: entry.owner,",
        "    });",
        "  }",
        "  return buckets;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "stage");
      assertStringIncludes(inputSchema, "owner");
      assertEquals(inputSchema.includes("unused"), false);
      assertEquals(inputSchema.includes("nested"), false);
    },
  );

  await t.step(
    "lift validates array unions against item fields used after ?? fallback",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type LeadScoreSummary = {",
        "  id: string;",
        "  score: number;",
        "  unused: string;",
        "};",
        "const liftScoreByLead = lift((list: LeadScoreSummary[] | undefined) => {",
        "  const record: Record<string, number> = {};",
        "  for (const entry of list ?? []) {",
        "    record[entry.id] = entry.score;",
        "  }",
        "  return record;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "score");
    },
  );

  await t.step(
    "lift preserves inherited interface fields used after ?? fallback",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "interface LeadState {",
        "  id: string;",
        "  name: string;",
        "}",
        "interface LeadScoreSummary extends LeadState {",
        "  score: number;",
        "  unused: string;",
        "}",
        "const liftScoreByLead = lift((list: LeadScoreSummary[] | undefined) => {",
        "  const record: Record<string, number> = {};",
        "  for (const entry of list ?? []) {",
        "    record[entry.id] = entry.score;",
        "  }",
        "  return record;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "score");
      assertEquals(inputSchema.includes("name"), false);
      assertEquals(inputSchema.includes("unused"), false);
    },
  );

  await t.step(
    "lift preserves plain array callback item fields in shrunk schemas",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Route = { id: string; label: string; capacity: number; unused: string };",
        "const liftLoadMetrics = lift((input: { routeList: Route[] }) =>",
        "  input.routeList.map((route) => ({",
        "    route: route.id,",
        "    label: route.label,",
        "    capacity: route.capacity,",
        "  }))",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "label");
      assertStringIncludes(inputSchema, "capacity");
      assertEquals(inputSchema.includes("unused"), false);
    },
  );

  await t.step(
    "lift preserves tracked values stored in local Map lookups",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Component = { id: string; name: string; props: string[]; unused: string };",
        "const liftNames = lift((input: { components: Component[]; ids: string[] }) => {",
        "  const componentMap = new Map<string, Component>();",
        "  input.components.forEach((component) => componentMap.set(component.id, component));",
        "  return input.ids.map((id) => componentMap.get(id)?.name ?? id);",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "components");
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "name");
      assertEquals(inputSchema.includes("unused"), false);
    },
  );

  await t.step(
    "lift preserves tracked values stored in local arrays used by sort callbacks",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Candidate = { id: string; age: number; site: string; unused: string };",
        "type Result = { candidate: Candidate; eligible: boolean };",
        "const liftIds = lift((input: { candidates: Candidate[] }) => {",
        "  const results: Result[] = [];",
        "  for (const candidate of input.candidates) {",
        "    results.push({ candidate, eligible: candidate.age >= 18 });",
        "  }",
        "  results.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id));",
        "  return results.length;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "age");
      assertEquals(inputSchema.includes("unused"), false);
    },
  );

  await t.step(
    "lift preserves element bindings through filter-to-map chains",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ScreeningResult = {",
        "  candidate: { id: string; site: string; unused: string };",
        "  eligible: boolean;",
        "};",
        "const liftEligibleIds = lift((input: { report: ScreeningResult[] }) =>",
        "  input.report",
        "    .filter((entry) => entry.eligible)",
        "    .map((entry) => entry.candidate.id)",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "eligible");
      assertStringIncludes(inputSchema, "candidate");
      assertStringIncludes(inputSchema, "id");
      assertEquals(inputSchema.includes("unused"), false);
    },
  );

  await t.step(
    "lift preserves properties read from find() result aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type IncidentStep = {",
        "  id: string;",
        "  title: string;",
        "  owner: string;",
        '  status: "pending" | "in_progress";',
        "  expectedMinutes: number;",
        "  elapsedMinutes: number;",
        "};",
        "const liftActiveStepTitle = lift((input: { list: IncidentStep[]; active: string | null }) => {",
        "  const target = input.list.find((step) => step.id === input.active);",
        '  return target ? target.title : "idle";',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "list");
      assertStringIncludes(inputSchema, "id");
      assertStringIncludes(inputSchema, "title");
      assertStringIncludes(inputSchema, "active");
      assertEquals(inputSchema.includes("owner"), false);
    },
  );

  await t.step(
    "lift preserves direct properties read from find() results",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "};",
        "const liftPriority = lift((input: { people: ParkingPerson[] }) =>",
        '  input.people.find((person) => person.name === "Alice")?.priorityRank === 1',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "people");
      assertStringIncludes(inputSchema, "name");
      assertStringIncludes(inputSchema, "priorityRank");
      assertEquals(inputSchema.includes("defaultSpot"), false);
    },
  );

  await t.step(
    "lift keeps full receiver shape through unknown array methods",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "  active: boolean;",
        "};",
        "const liftPriority = lift((input: { people: ParkingPerson[]; other: string }) =>",
        '  input.people.filter((person) => person.active).slice(0).find((person) => person.name === "Alice")?.priorityRank === 1',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "people");
      assertStringIncludes(inputSchema, "active");
      assertStringIncludes(inputSchema, "name");
      assertStringIncludes(inputSchema, "priorityRank");
      assertStringIncludes(inputSchema, "defaultSpot");
      assertEquals(inputSchema.includes("other"), false);
    },
  );

  await t.step(
    "lift preserves full receiver shape when identity use overlaps an unknown chain",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { equals, lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  active: boolean;",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "};",
        "const samePeople = lift((input: { people: ParkingPerson[] }) =>",
        "  equals(",
        "    input.people,",
        "    input.people.filter((person) => person.active).slice(0),",
        "  )",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "people");
      assertStringIncludes(inputSchema, "active");
      assertStringIncludes(inputSchema, "name");
      assertStringIncludes(inputSchema, "priorityRank");
      assertStringIncludes(inputSchema, "defaultSpot");
    },
  );

  await t.step(
    "lift shrinks item fields through right-hand ?? fallback aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Note = { title: string; body: string };",
        "const cached = undefined as Note[] | undefined;",
        "const liftTitles = lift((input: { notes: Note[] }) => {",
        "  const items = cached ?? input.notes;",
        "  for (const item of items) {",
        "    return item.title;",
        "  }",
        '  return "";',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "notes");
      assertStringIncludes(inputSchema, "title");
      assertEquals(inputSchema.includes("body"), false);
    },
  );

  await t.step(
    "lift preserves array item properties named key",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        'type ColumnKey = "backlog" | "inProgress" | "review" | "done";',
        "interface KanbanTask { id: string; title: string; column: ColumnKey; points: number; }",
        "interface ColumnSummary {",
        "  key: ColumnKey;",
        "  title: string;",
        "  limit: number;",
        "  count: number;",
        "  overloaded: boolean;",
        "  items: KanbanTask[];",
        "}",
        "const liftOverloadedColumns = lift((summaries: ColumnSummary[]) =>",
        "  summaries",
        "    .filter((summary) => summary.overloaded)",
        "    .map((summary) => summary.key)",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "overloaded");
      assertStringIncludes(inputSchema, "key");
      assertEquals(inputSchema.includes("title"), false);
      assertEquals(inputSchema.includes("limit"), false);
    },
  );

  await t.step(
    "lift preserves chained || fallback fields in object inputs",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "const liftFirstOption = lift(",
        "  (state: { name: string; firstItem: string | undefined }) =>",
        '    state.name || state.firstItem || "default",',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "name");
      assertStringIncludes(inputSchema, "firstItem");
    },
  );

  await t.step(
    "derive preserves cell wrappers when callback uses .get() on inferred input",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, type Writable } from "commonfabric";',
        "const value = {} as Writable<number>;",
        "const doubled = derive(value, (v) => v.get() * 2);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, 'asCell: ["cell"]');
      assertEquals(inputSchema.includes("asOpaque: true"), false);
    },
  );

  await t.step(
    "derive preserves cell wrappers when expression-bodied callback is a direct .get() call",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, type Writable } from "commonfabric";',
        "const value = {} as Writable<number>;",
        "const copy = derive(value, (v) => v.get());",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, 'asCell: ["cell"]');
      assertEquals(inputSchema.includes("asOpaque: true"), false);
    },
  );

  await t.step(
    "handler preserves explicit primitive-object union event schemas through typeof narrowing",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { type Cell, handler } from "commonfabric";',
        "type AppendValueEvent = { value?: number } | number | undefined;",
        "const appendValueToList = handler(",
        "  (event: AppendValueEvent, context: { values: Cell<number[]> }) => {",
        '    const rawValue = typeof event === "number" ? event : event?.value;',
        "    if (rawValue === undefined) return;",
        "    context.values.push(rawValue);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertEquals(
        inputSchema === "true",
        false,
        "event schema should not widen to true",
      );
      assertStringIncludes(inputSchema, '"undefined"');
      assertStringIncludes(inputSchema, "value");
    },
  );

  await t.step(
    "derive shrinks known fixed-symbol access without pulling unrelated fields",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, NAME, UI } from "commonfabric";',
        "type Piece = {",
        "  [NAME]?: string;",
        "  [UI]?: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        "const piece = {} as Piece;",
        "const label = derive({ piece }, ({ piece }) => {",
        '  return `${piece[NAME] ?? ""}:${piece[UI] ?? ""}`;',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "$NAME");
      assertStringIncludes(inputSchema, "$UI");
      assertEquals(inputSchema.includes("metadata"), false);
      assertEquals(inputSchema.includes("author"), false);
    },
  );

  await t.step(
    "derive shrinks aliased fixed-symbol destructuring without pulling unrelated fields",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, NAME as CF_NAME } from "commonfabric";',
        "type Piece = {",
        "  [CF_NAME]?: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        "const piece = {} as Piece;",
        'const label = derive({ piece }, ({ piece: { [CF_NAME]: name } }) => name ?? "");',
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "$NAME");
      assertEquals(inputSchema.includes("metadata"), false);
      assertEquals(inputSchema.includes("author"), false);
    },
  );

  await t.step(
    "pattern preserves defaults for fixed-symbol destructuring aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { NAME as CF_NAME, pattern, UI } from "commonfabric";',
        "type Piece = {",
        "  [CF_NAME]?: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        'const p = pattern<Piece>(({ [CF_NAME]: name = "Untitled" }) => ({',
        "  [UI]: <div>{name}</div>,",
        "}));",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "$NAME");
      assertStringIncludes(inputSchema, '"default": "Untitled"');
    },
  );

  await t.step(
    "derive resolves local const string keys instead of fixed-key name fallbacks",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive } from "commonfabric";',
        'const UI = "title" as const;',
        "type Piece = {",
        "  title: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        "const piece = {} as Piece;",
        "const label = derive({ piece }, ({ piece }) => piece[UI]);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, "title");
      assertEquals(inputSchema.includes("$UI"), false);
      assertEquals(inputSchema.includes("metadata"), false);
    },
  );

  await t.step(
    "derive shrinks equals-only cell inputs to opaque unknown cells",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, type Writable } from "commonfabric";',
        "type Piece = Writable<{ name: string; extra: { nested: string } }>;",
        "const left = {} as Piece;",
        "const right = {} as Piece;",
        "const same = derive({ left, right }, ({ left, right }) => left.equals(right));",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, 'asCell: ["opaque"]');
      assertEquals(inputSchema.includes("name"), false);
      assertEquals(inputSchema.includes("extra"), false);
      assertEquals(inputSchema.includes("nested"), false);
    },
  );

  await t.step(
    "derive preserves nullable cell wrappers for equals-only root inputs",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, equals, type Writable } from "commonfabric";',
        "const state = {} as (Writable<number> | undefined);",
        "const same = derive(state, (state) => equals(state, state));",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = extractSchemas(result.output)[0] ?? "";
      assertStringIncludes(inputSchema, 'type: "undefined"');
      assertStringIncludes(inputSchema, 'asCell: ["opaque"]');
    },
  );

  await t.step(
    "derive keeps both array and index cells for dynamic element access",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { cell, derive } from "commonfabric";',
        'const items = cell(["apple", "banana", "cherry"]);',
        "const index = cell(1);",
        "const selected = derive({ items, index }, ({ items, index }) =>",
        "  items.get()[index.get()]",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema =
        extractSchemas(result.output).find((schema) =>
          schema.includes("items") && schema.includes("index")
        ) ?? "";
      assertStringIncludes(inputSchema, "items");
      assertStringIncludes(inputSchema, "index");
      assertStringIncludes(inputSchema, 'type: "array"');
      assertStringIncludes(inputSchema, 'type: "number"');
    },
  );

  await t.step(
    "derive wildcard usage keeps conservative full-shape input schema",
    async () => {
      const source = [
        'import { derive, type Writable } from "commonfabric";',
        "const input = {} as Writable<{ foo: string; bar: string }>;",
        "const d = derive(input, (v: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = v.key("foo").get();',
        "  Object.keys(v.get());",
        "  return foo;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      assertStringIncludes(result.output, 'asCell: ["cell"]');
      assertStringIncludes(result.output, '"foo"');
      assertStringIncludes(result.output, '"bar"');
    },
  );

  await t.step(
    "handler wildcard usage keeps conservative full-shape state schema",
    async () => {
      const source = [
        'import { handler, type Writable } from "commonfabric";',
        "const h = handler((event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = state.key("foo").get();',
        "  Object.keys(state.get());",
        "  return foo + event.id;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      assertStringIncludes(result.output, 'asCell: ["cell"]');
      assertStringIncludes(result.output, '"foo"');
      assertStringIncludes(result.output, '"bar"');
    },
  );
});

function getShrinkErrors(
  diagnostics: readonly TransformationDiagnostic[],
): TransformationDiagnostic[] {
  return diagnostics.filter(
    (d) =>
      d.severity === "error" &&
      (d.type === "schema:unknown-type-access" ||
        d.type === "schema:path-not-in-type"),
  );
}

function fmtErrors(diagnostics: readonly TransformationDiagnostic[]): string {
  return getShrinkErrors(diagnostics).map((e) => e.message).join("; ");
}
