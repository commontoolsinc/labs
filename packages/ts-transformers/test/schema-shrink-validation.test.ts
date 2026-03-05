import { assertEquals, assertGreater } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONTOOLS_TYPES } from "./commontools-test-types.ts";

/**
 * Extracts JSON schema literals from transformed output.
 * Schemas appear as `{ type: "object", ... } as const satisfies __ctHelpers.JSONSchema`
 * Returns them in order of appearance.
 */
function extractSchemas(output: string): string[] {
  const schemas: string[] = [];
  const marker = "as const satisfies __ctHelpers.JSONSchema";
  let searchFrom = 0;
  while (true) {
    const markerIdx = output.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    // Walk backwards from marker to find matching opening brace
    let depth = 0;
    let start = markerIdx - 1;
    // Skip whitespace before marker
    while (start >= 0 && /\s/.test(output[start]!)) start--;
    // Now we should be at a closing brace or end of object literal
    if (output[start] !== "}") {
      searchFrom = markerIdx + marker.length;
      continue;
    }
    depth = 1;
    start--;
    while (start >= 0 && depth > 0) {
      if (output[start] === "}") depth++;
      else if (output[start] === "{") depth--;
      start--;
    }
    start++; // back to the opening brace
    const schemaText = output.slice(start, markerIdx).trim();
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
    "handler<E | undefined, T> and inline form both produce valid schemas (KNOWN DIVERGENCE)",
    async () => {
      // Known divergence: type-arg form preserves top-level anyOf union,
      // inline form shrinks to just the object (stripping undefined).
      // Both produce valid, error-free schemas — just structured differently.
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
      // Both generate schemas (state schema should match at minimum)
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
      // State schemas (second schema) should match
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "handler state schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "handler<TypeAlias | undefined, TypeAlias> and inline form both produce valid schemas (KNOWN DIVERGENCE)",
    async () => {
      // Same divergence as above: union handling differs between type-arg and inline paths.
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
      // State schemas (second schema) should match
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
    "lift<T | undefined, R> and inline form both produce valid schemas (KNOWN DIVERGENCE)",
    async () => {
      // Known divergence: type-arg form preserves top-level anyOf union,
      // inline form shrinks to just the object (stripping undefined).
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
      // Result schemas (second schema) should match
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
    "pattern<T> and inline form both produce valid schemas (KNOWN DIVERGENCE)",
    async () => {
      // Known divergence: pattern<T> produces both argument and result schemas
      // (result schema has asOpaque on each property), while inline form produces
      // only the argument schema. This needs more changes to reconcile.
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
      // Argument schemas (first schema) should match
      assertEquals(
        schemasTA[0],
        schemasInline[0],
        "pattern argument schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "pattern<TypeAlias> and inline form both produce valid schemas (KNOWN DIVERGENCE)",
    async () => {
      // Same divergence as above.
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
      // Argument schemas (first schema) should match
      assertEquals(
        schemasTA[0],
        schemasInline[0],
        "pattern argument schemas should be identical between type-arg and inline forms",
      );
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
