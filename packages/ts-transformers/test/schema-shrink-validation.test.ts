import { assertEquals, assertGreater, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

/**
 * Extracts JSON schema literals from transformed output.
 * Schemas appear as either:
 * - `{ type: "object", ... } as const satisfies __ctHelpers.JSONSchema`
 * - `true as const satisfies __ctHelpers.JSONSchema`
 * - `false as const satisfies __ctHelpers.JSONSchema`
 * Returns them in order of appearance.
 */
function extractSchemas(output: string): string[] {
  const schemas: string[] = [];
  const marker = "as const satisfies __ctHelpers.JSONSchema";
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern((state: unknown) => {",
        "  const x = state.foo;",
        "  const y = state.bar;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern((state: { a: string }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const helper = (x: unknown) => (x as any).foo;",
        "",
        "const fn = lift((state: unknown) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const helper = (x: { a: string }) => (x as any).b;",
        "",
        "const fn = lift((state: { a: string }) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift((state: unknown) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift((state: any) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
    "no error when concrete type is passed to opaque function in lift",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift((state: { a: string }) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern((state: unknown) => {",
        "  console.log(state);",
        "  return {};",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
        "",
        "type Req = { item: string };",
        "",
        "export const h = handler<Req, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern((state: { a: string; b: number }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
        "",
        "export const h = handler<{ amount?: number } | undefined, {}>(",
        "  (args) => { console.log(args.amount); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
        "",
        "export const h = handler<{ value?: number } | number | undefined, {}>(",
        "  (args) => { console.log(args.value); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { handler } from "commontools";',
        "",
        "interface Req { item: string }",
        "",
        "export const h = handler<Req | undefined, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift((items: number[]) => items[0]);",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "type Items = Array<{ name: string }>;",
        "const hasItems = lift<Items, boolean>(",
        "  (items) => items && items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "type Indexed = { [index: number]: string };",
        "const hasItems = lift<Indexed, boolean>(",
        "  (items) => items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
        "",
        "export const h = handler<{ amount: number }, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event.amount); },",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
        "",
        "export const h = handler(",
        "  (event: { amount: number }, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event.amount);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
        "",
        "export const h = handler<{ amount?: number } | undefined, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event?.amount ?? 0); },",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
        "",
        "export const h = handler(",
        "  (event: { amount?: number } | undefined, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event?.amount ?? 0);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
        "",
        "interface ScaleEvent { servings?: number; delta?: number }",
        "interface ScaleState { desiredServings: Cell<number> }",
        "",
        "export const h = handler<ScaleEvent | undefined, ScaleState>(",
        "  (event, ctx) => { ctx.desiredServings.set(event?.servings ?? 1); },",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { type Cell, handler } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift<{ count: number }, string>(",
        "  (state) => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift(",
        "  (state: { count: number }): string => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift<{ count: number } | undefined, number>(",
        "  (state) => state?.count ?? 0,",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "const fn = lift(",
        "  (state: { count: number } | undefined): number => state?.count ?? 0,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift<Item, string>(",
        "  (item) => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift(",
        "  (item: Item): string => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern<{ name: string; count: number }>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "export default pattern(({ name, count }: { name: string; count: number }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern<Args>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        "/// <cts-enable />",
        'import { pattern } from "commontools";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern(({ name, count }: Args) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONTOOLS_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONTOOLS_TYPES,
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
        "/// <cts-enable />",
        'import { cell, derive, lift } from "commontools";',
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
        types: COMMONTOOLS_TYPES,
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
    "derive wildcard usage keeps conservative full-shape input schema",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, type Writable } from "commontools";',
        "const input = {} as Writable<{ foo: string; bar: string }>;",
        "const d = derive(input, (v: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = v.key("foo").get();',
        "  Object.keys(v.get());",
        "  return foo;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      assertStringIncludes(result.output, "asCell: true");
      assertStringIncludes(result.output, '"foo"');
      assertStringIncludes(result.output, '"bar"');
    },
  );

  await t.step(
    "handler wildcard usage keeps conservative full-shape state schema",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commontools";',
        "const h = handler((event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = state.key("foo").get();',
        "  Object.keys(state.get());",
        "  return foo + event.id;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      assertStringIncludes(result.output, "asCell: true");
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
