import { assertEquals, assertGreater } from "@std/assert";
import { transformSource, validateSource } from "./utils.ts";
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
    "shrinks captured pattern instance outputs to accessed fields",
    async () => {
      const source = [
        "/// <cts-enable />",
        "import {",
        "  computed,",
        "  Default,",
        "  NAME,",
        "  pattern,",
        "  Stream,",
        "  UI,",
        "  type VNode,",
        "  Writable,",
        '} from "commontools";',
        "",
        "interface CounterInput {",
        "  value?: Writable<Default<number, 0>>;",
        "}",
        "",
        "interface CounterOutput {",
        "  [NAME]: string;",
        "  [UI]: VNode;",
        "  value: number;",
        "  increment: Stream<void>;",
        "  decrement: Stream<void>;",
        "}",
        "",
        "const Counter = pattern<CounterInput, CounterOutput>(({ value }) => ({",
        '  [NAME]: "Counter",',
        "  [UI]: <div>{value}</div>,",
        "  value,",
        "  increment: {} as any,",
        "  decrement: {} as any,",
        "}));",
        "",
        "export default pattern(() => {",
        "  const counter = Counter({});",
        "  const ok = computed(() => counter.value === 0);",
        "  return { ok };",
        "});",
      ].join("\n");

      const output = await transformSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const normalized = output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'counter: { type: "object", properties: { value:',
        ),
        true,
      );
      assertEquals(
        normalized.includes(
          'counter: { type: "object", properties: { value: true }, required: ["value"] }',
        ) ||
          normalized.includes(
            'counter: { type: "object", properties: { value: { type: "number" } }, required: ["value"] }',
          ),
        true,
      );
      assertEquals(
        normalized.includes(
          'counter: { type: "object", properties: { value: { type: "number" }, increment:',
        ),
        false,
      );
    },
  );

  await t.step(
    "preserves cell wrappers when shrinking computed state captures",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, NAME, pattern, UI, Writable } from "commontools";',
        "",
        "interface Input {",
        "  value: Writable<Default<number, 0>>;",
        "}",
        "",
        "export default pattern<Input>((state) => {",
        "  const prev = computed(() => state.value.get() - 1);",
        "  return {",
        '    [NAME]: "Counter",',
        "    [UI]: <div>{prev}</div>,",
        "    prev,",
        "  };",
        "});",
      ].join("\n");

      const output = await transformSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const normalized = output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'state: { type: "object", properties: { value: { type: "number", "default": 0, asCell: true } }, required: ["value"] }',
        ),
        true,
      );
      assertEquals(
        normalized.includes(
          'state: { type: "object", properties: { value: true }, required: ["value"] }',
        ),
        false,
      );
    },
  );

  await t.step(
    "computed preserves typed outer wrappers in zero-parameter closures",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, pattern } from "commontools";',
        "",
        "interface MyInput {",
        "  value: number;",
        "}",
        "",
        "export default pattern((input: MyInput) => {",
        "  return {",
        "    result: computed(() => input.value * 2),",
        "  };",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const normalized = result.output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'input: { type: "object", properties: { value: { type: "number" } }, required: ["value"] }',
        ),
        true,
        `expected computed input wrapper to retain value:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("input: true"),
        false,
        `did not expect computed input wrapper to collapse to true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "preserves cell wrappers for array items in computed for-of loops",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, pattern, wish, Writable } from "commontools";',
        "",
        "interface Piece {",
        "  summary?: string;",
        "}",
        "",
        "export default pattern(() => {",
        "  const mentionable = wish<Default<Writable<Piece>[], []>>({",
        '    query: "#mentionable",',
        "  }).result;",
        "  const summaries = computed(() => {",
        "    const result: string[] = [];",
        "    for (const piece of mentionable ?? []) {",
        "      const value = piece.get();",
        "      if (value.summary) result.push(value.summary);",
        "    }",
        "    return result;",
        "  });",
        "  return { summaries };",
        "});",
      ].join("\n");

      const output = await transformSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const normalized = output.replace(/\s+/g, " ");

      assertEquals(
        /mentionable:\s*{\s*(?:type:\s*"array"[\s\S]*items:\s*{\s*(?:type:\s*"object"[\s\S]*summary:\s*{\s*type:\s*"string"|(?:\$ref:\s*"#\/\$defs\/Piece",\s*asCell:\s*true))|anyOf:\s*\[\{\s*type:\s*"array"[\s\S]*items:\s*{\s*(?:type:\s*"object"[\s\S]*summary:\s*{\s*type:\s*"string"|(?:\$ref:\s*"#\/\$defs\/Piece",\s*asCell:\s*true))[\s\S]*\},\s*\{\s*type:\s*"undefined"\s*\}\])/
          .test(
            normalized,
          ),
        true,
        `expected mentionable schema to preserve cell-backed array items:\n${output}`,
      );
      assertEquals(
        normalized.includes(
          "mentionable: true",
        ),
        false,
      );
    },
  );

  await t.step(
    "JSX derives preserve narrowed outer wrappers for element access",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { pattern, UI } from "commontools";',
        "",
        "interface State {",
        "  items: string[];",
        "  index: number;",
        "  matrix: number[][];",
        "  row: number;",
        "  col: number;",
        "}",
        "",
        "export default pattern<State>((state) => {",
        "  return {",
        "    [UI]: (",
        "      <div>",
        "        <p>Item: {state.items[state.index]}</p>",
        "        <p>Last: {state.items[state.items.length - 1]}</p>",
        "        <p>Matrix: {state.matrix[state.row]![state.col]}</p>",
        "      </div>",
        "    ),",
        "  };",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const normalized = result.output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'state: { type: "object", properties: { items: { type: "array", items: { type: "string" } }, index: { type: "number" } }, required: ["items", "index"] }',
        ),
        true,
        `expected first element-access derive to keep state.items and state.index:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'state: { type: "object", properties: { matrix: { type: "array", items: { type: "array", items: { type: "number" } } }, row: { type: "number" }, col: { type: "number" } }, required: ["matrix", "row", "col"] }',
        ),
        true,
        `expected matrix element-access derive to keep matrix/row/col:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("state: true"),
        false,
        `did not expect JSX derive wrappers to collapse to true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "pattern instance nested array index access preserves nested array item schemas",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, pattern } from "commontools";',
        "",
        "type SquareState = 'empty' | 'miss' | 'hit';",
        "",
        "interface PlayerState {",
        "  shots: SquareState[][];",
        "}",
        "",
        "interface GameState {",
        "  player1: PlayerState;",
        "  player2: PlayerState;",
        "  currentTurn: number;",
        "}",
        "",
        "interface Output {",
        "  game: GameState;",
        "}",
        "",
        "const BattleshipLike = pattern<{}, Output>(() => ({",
        "  game: {",
        "    player1: { shots: [['empty']] },",
        "    player2: { shots: [['miss']] },",
        "    currentTurn: 1,",
        "  },",
        "}));",
        "",
        "export default pattern(() => {",
        "  const game = BattleshipLike({});",
        "  const miss = computed(() => game.game.player2.shots[0][0] === 'miss');",
        "  const hit = computed(() => game.game.player1.shots[0][0] === 'hit');",
        "  return { miss, hit };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'shots: { type: "array", items: { type: "array", items: { $ref: "#/$defs/SquareState" } } }',
        ) ||
          normalized.includes(
            'shots: { type: "array", items: { type: "array", items: { enum: ["empty", "miss", "hit"] } } }',
          ) ||
          normalized.includes(
            'shots: { type: "array", items: { type: "array", items: { type: "string" } } }',
          ),
        true,
        `expected nested shots access to preserve array-of-array shape:\n${result.output}`,
      );
      assertEquals(
        normalized.includes('"0": { type: "string" }'),
        false,
        `did not expect nested array index access to collapse inner arrays into object members:\n${result.output}`,
      );
    },
  );

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
    "handler string properties used via .length still emit string schemas",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { handler } from "commontools";',
        "",
        "export const setLabel = handler(",
        "  (event: { text?: string } | undefined) => {",
        "    return typeof event?.text === 'string' && event.text.length > 0",
        "      ? event.text",
        "      : null;",
        "  },",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const eventSchema = schemas[0]!;

      assertEquals(
        /text:\s*{[\s\S]*type:\s*"string"/.test(eventSchema),
        true,
        `expected event.text to remain a string schema:\n${eventSchema}`,
      );
      assertEquals(
        /text:\s*{[\s\S]*length:\s*{[\s\S]*type:\s*"number"/.test(eventSchema),
        false,
        `did not expect event.text to shrink to a length object:\n${eventSchema}`,
      );
    },
  );

  await t.step(
    "lift preserves array item fields through guarded map-join callbacks",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface OutlineEntry {",
        "  label: string;",
        "  endMinute: number;",
        "}",
        "",
        "const outline = lift((entries: OutlineEntry[] | undefined): string => {",
        "  if (!entries || entries.length === 0) return '(empty outline)';",
        "  return entries.map((entry) => entry.label).join(' -> ');",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*label:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected guarded map-join to retain entry.label in item schema:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{\s*type:\s*"unknown"\s*}/.test(inputSchema),
        false,
        `did not expect guarded map-join to collapse items to unknown:\n${inputSchema}`,
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
    "computed captures use root array and string values for intrinsic .length reads",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { action, computed, Default, NAME, pattern, Stream, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  items: Item[];",
        "  filteredItems: Item[];",
        "  label: string;",
        "  itemCount: number;",
        "  addItem: Stream<void>;",
        "}",
        "",
        "const ProxyLengthRepro = pattern<Input, Output>(({ items }) => {",
        "  const addItem = action(() => {",
        "    items.push({ name: `Item ${items.get().length + 1}` });",
        "  });",
        "  const filteredItems = computed(() =>",
        '    items.get().filter((item) => item.name !== "")',
        "  );",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Proxy Length Repro", items, filteredItems, label, itemCount, addItem };',
        "});",
        "",
        "export default pattern(() => {",
        "  const subject = ProxyLengthRepro({ items: [] });",
        "  const directLength = computed(() => subject.items.length === 0);",
        "  const computedLength = computed(() => subject.filteredItems.length === 0);",
        "  const labelLength = computed(() => subject.label.length === 8);",
        "  return { directLength, computedLength, labelLength };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes("{ subject: { items: subject.items } }"),
        true,
        `expected direct array length capture to pass the array root:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "{ subject: { filteredItems: subject.filteredItems } }",
        ),
        true,
        `expected computed array length capture to pass the array root:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("{ subject: { label: subject.label } }"),
        true,
        `expected string length capture to pass the string root:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "{ subject: { items: { length: subject.items.length } } }",
        ),
        false,
        `did not expect direct array length capture to materialize a nested length object:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "{ subject: { filteredItems: { length: subject.filteredItems.length } } }",
        ),
        false,
        `did not expect computed array length capture to materialize a nested length object:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "{ subject: { label: { length: subject.label.length } } }",
        ),
        false,
        `did not expect string length capture to materialize a nested length object:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed .get().length on Default array cells emits a single array-cell schema",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, NAME, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  label: string;",
        "  itemCount: number;",
        "}",
        "",
        "export default pattern<Input, Output>(({ items }) => {",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Default Length Repro", label, itemCount };',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'const label = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { type: "unknown" }, asCell: true } }, required: ["items"] }',
        ),
        true,
        `expected label .get().length capture to use a single array-cell schema:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const itemCount = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { type: "unknown" }, asCell: true } }, required: ["items"] }',
        ),
        true,
        `expected itemCount .get().length capture to use a single array-cell schema:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const label = __ctHelpers.derive({ type: "object", properties: { items: { anyOf:',
        ),
        false,
        `did not expect label .get().length capture to keep Default-array anyOf wrappers:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const itemCount = __ctHelpers.derive({ type: "object", properties: { items: { anyOf:',
        ),
        false,
        `did not expect itemCount .get().length capture to keep Default-array anyOf wrappers:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed .get().length plus .set() on Default array cells still shrinks to a single array-cell schema",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, pattern, Writable } from "commontools";',
        "",
        "interface Department {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  departments: Writable<Default<Department[], []>>;",
        "}",
        "",
        "export default pattern<Input>(({ departments }) => {",
        "  const init = computed(() => {",
        "    const current = departments.get();",
        "    if (current.length === 0) {",
        "      queueMicrotask(() => {",
        '        departments.set([{ name: "Bakery" }]);',
        "      });",
        "    }",
        "    return true;",
        "  });",
        "  return { init };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'const init = __ctHelpers.derive({ type: "object", properties: { departments: { type: "array", items: { type: "unknown" }, asCell: true } }, required: ["departments"] }',
        ),
        true,
        `expected .get().length + .set() capture to use a single array-cell schema:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const init = __ctHelpers.derive({ type: "object", properties: { departments: { anyOf:',
        ),
        false,
        `did not expect .get().length + .set() capture to keep Default-array anyOf wrappers:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed preserves cell wrappers when filtering items from a captured cell array",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "export default pattern<Input>(({ items }) => {",
        "  const filteredItems = computed(() =>",
        '    items.get().filter((item) => item.name !== "")',
        "  );",
        "  return { filteredItems };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'items: { type: "array", items: { $ref: "#/$defs/Item" }, "default": [], asCell: true }',
        ) ||
          normalized.includes(
            'items: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, "default": [], asCell: true }',
          ),
        true,
        `expected filteredItems input schema to preserve items as a cell array:\n${result.output}`,
      );
      assertEquals(
        normalized.includes('items: { type: "unknown" }'),
        false,
        `did not expect filteredItems input schema to collapse items to unknown:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed .get().filter(...).length keeps array cell shape and predicate fields",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  done: boolean;",
        "  title: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "export default pattern<Input>(({ items }) => {",
        "  const doneCount = computed(() =>",
        "    items.get().filter((item) => item.done).length",
        "  );",
        "  return { doneCount };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'const doneCount = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] }, "default": [], asCell: true } }, required: ["items"] }',
        ) ||
          normalized.includes(
            'const doneCount = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] }, asCell: true } }, required: ["items"] }',
          ) ||
          normalized.includes(
            'const doneCount = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { $ref: "#/$defs/Item" }, "default": [], asCell: true } }, required: ["items"] }',
          ) ||
          normalized.includes(
            'const doneCount = __ctHelpers.derive({ type: "object", properties: { items: { type: "array", items: { $ref: "#/$defs/Item" }, asCell: true } }, required: ["items"] }',
          ),
        true,
        `expected filter(...).length to keep items as an array cell with done retained:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'items: { type: "object", properties: { length: { type: "number" } }, required: ["length"], asCell: true }',
        ),
        false,
        `did not expect filter(...).length to collapse items to a cell-backed length object:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed preserves array cell item fields through filter-slice-map preview chains",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  done: boolean;",
        "  title: string;",
        "  aisle: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "export default pattern<Input>(({ items }) => {",
        "  const preview = computed(() => {",
        "    const remaining = items.get().filter((item) => !item.done);",
        "    const names = remaining.slice(0, 10).map((item) => item.title);",
        "    return names.join(\", \") +",
        "      (remaining.length > 10 ? ` (+${remaining.length - 10} more)` : \"\");",
        "  });",
        "  return { preview };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'items: { type: "array", items: { type: "object", properties: { done: { type: "boolean" }, title: { type: "string" } }, required: ["done", "title"] }, "default": [], asCell: true }',
        ) ||
          normalized.includes(
            'items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, done: { type: "boolean" } }, required: ["title", "done"] }, "default": [], asCell: true }',
          ) ||
          normalized.includes(
            'items: { type: "array", items: { $ref: "#/$defs/Item" }, "default": [], asCell: true }',
          ),
        true,
        `expected preview chain to keep array item done/title fields:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'items: { type: "object", properties: { length: { type: "number" } }, required: ["length"], asCell: true }',
        ),
        false,
        `did not expect preview chain to collapse items to a cell-backed length object:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed shrinks captured pattern instance scalar outputs to concrete string and number members",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, NAME, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  label: string;",
        "  itemCount: number;",
        "}",
        "",
        "const ProxyScalarRepro = pattern<Input, Output>(({ items }) => {",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Proxy Scalar Repro", label, itemCount };',
        "});",
        "",
        "export default pattern(() => {",
        "  const subject = ProxyScalarRepro({ items: [] });",
        "  const labelNotEmpty = computed(() => subject.label !== '');",
        "  const labelLength = computed(() => subject.label.length === 8);",
        "  const countIsZero = computed(() => subject.itemCount === 0);",
        "  return { labelNotEmpty, labelLength, countIsZero };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'subject: { type: "object", properties: { label: { type: "string" } }, required: ["label"] }',
        ),
        true,
        `expected captured scalar label output to shrink to a string member:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'subject: { type: "object", properties: { itemCount: { type: "number" } }, required: ["itemCount"] }',
        ),
        true,
        `expected captured scalar itemCount output to shrink to a number member:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          '} as const satisfies __ctHelpers.JSONSchema, { subject: { label: subject.label } }, ({ subject }) => subject.label !== ""',
        ) ||
          normalized.includes(
            "} as const satisfies __ctHelpers.JSONSchema, { subject: { label: subject.label } }, ({ subject }) => subject.label !== ''",
          ),
        true,
        `expected label capture to pass the scalar root value:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "} as const satisfies __ctHelpers.JSONSchema, { subject: { itemCount: subject.itemCount } }, ({ subject }) => subject.itemCount === 0",
        ),
        true,
        `expected itemCount capture to pass the scalar root value:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("subject: true"),
        false,
        `did not expect scalar captured outputs to fall back to subject: true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed keeps scalar pattern instance outputs narrowed even after sibling array output captures",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, Default, NAME, pattern, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  items: Item[];",
        "  filteredItems: Item[];",
        "  label: string;",
        "  itemCount: number;",
        "}",
        "",
        "const MixedProxyRepro = pattern<Input, Output>(({ items }) => {",
        "  const filteredItems = computed(() =>",
        '    items.get().filter((item) => item.name !== "")',
        "  );",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Mixed Proxy Repro", items, filteredItems, label, itemCount };',
        "});",
        "",
        "export default pattern(() => {",
        "  const subject = MixedProxyRepro({ items: [] });",
        "  const itemsLength = computed(() => subject.items.length === 0);",
        "  const filteredLength = computed(() => subject.filteredItems.length === 0);",
        "  const labelNotEmpty = computed(() => subject.label !== '');",
        "  const labelLength = computed(() => subject.label.length === 8);",
        "  const countIsZero = computed(() => subject.itemCount === 0);",
        "  return { itemsLength, filteredLength, labelNotEmpty, labelLength, countIsZero };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'subject: { type: "object", properties: { label: { type: "string" } }, required: ["label"] }',
        ),
        true,
        `expected mixed-output label capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'subject: { type: "object", properties: { itemCount: { type: "number" } }, required: ["itemCount"] }',
        ),
        true,
        `expected mixed-output itemCount capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "} as const satisfies __ctHelpers.JSONSchema, { subject: { label: subject.label } }, ({ subject }) => subject.label !== ''",
        ) ||
          normalized.includes(
            '} as const satisfies __ctHelpers.JSONSchema, { subject: { label: subject.label } }, ({ subject }) => subject.label !== ""',
          ),
        true,
        `expected mixed-output label capture to pass the scalar root value:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          "} as const satisfies __ctHelpers.JSONSchema, { subject: { itemCount: subject.itemCount } }, ({ subject }) => subject.itemCount === 0",
        ),
        true,
        `expected mixed-output itemCount capture to pass the scalar root value:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("subject: true"),
        false,
        `did not expect mixed-output scalar captures to fall back to subject: true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed keeps scalar pattern instance outputs narrowed after sibling spread captures and action captures",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { action, computed, Default, NAME, pattern, Stream, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  items: Item[];",
        "  filteredItems: Item[];",
        "  label: string;",
        "  itemCount: number;",
        "  addItem: Stream<void>;",
        "}",
        "",
        "const SpreadProxyRepro = pattern<Input, Output>(({ items }) => {",
        "  const addItem = action(() => {",
        "    items.push({ name: `Item ${items.get().length + 1}` });",
        "  });",
        "  const filteredItems = computed(() =>",
        '    items.get().filter((item) => item.name !== "")',
        "  );",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Spread Proxy Repro", items, filteredItems, label, itemCount, addItem };',
        "});",
        "",
        "export default pattern(() => {",
        "  const subject = SpreadProxyRepro({ items: [] });",
        "  const actionAdd = action(() => {",
        "    subject.addItem.send();",
        "  });",
        "  const itemsSpreadLength = computed(() => [...subject.items].length === 0);",
        "  const filteredLength = computed(() => subject.filteredItems.length === 0);",
        "  const filteredSpreadLength = computed(() => [...subject.filteredItems].length === 0);",
        "  const labelNotEmpty = computed(() => subject.label !== '');",
        "  const labelLength = computed(() => subject.label.length === 8);",
        "  const countIsZero = computed(() => subject.itemCount === 0);",
        "  return {",
        "    actionAdd,",
        "    itemsSpreadLength,",
        "    filteredLength,",
        "    filteredSpreadLength,",
        "    labelNotEmpty,",
        "    labelLength,",
        "    countIsZero,",
        "  };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'const labelNotEmpty = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }, required: ["subject"] }',
        ),
        true,
        `expected spread/action label capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const countIsZero = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { itemCount: { type: "number" } }, required: ["itemCount"] } }, required: ["subject"] }',
        ),
        true,
        `expected spread/action itemCount capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const labelNotEmpty = __ctHelpers.derive({ type: "object", properties: { subject: true }',
        ),
        false,
        `did not expect spread/action label capture to fall back to subject: true:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const countIsZero = __ctHelpers.derive({ type: "object", properties: { subject: true }',
        ),
        false,
        `did not expect spread/action itemCount capture to fall back to subject: true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed keeps scalar pattern instance outputs narrowed with repeated before and after assertions",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { action, computed, Default, NAME, pattern, Stream, Writable } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "}",
        "",
        "interface Input {",
        "  items: Writable<Default<Item[], []>>;",
        "}",
        "",
        "interface Output {",
        "  [NAME]: string;",
        "  items: Item[];",
        "  filteredItems: Item[];",
        "  label: string;",
        "  itemCount: number;",
        "  addItem: Stream<void>;",
        "}",
        "",
        "const RepeatedProxyRepro = pattern<Input, Output>(({ items }) => {",
        "  const addItem = action(() => {",
        "    items.push({ name: `Item ${items.get().length + 1}` });",
        "  });",
        "  const filteredItems = computed(() =>",
        '    items.get().filter((item) => item.name !== "")',
        "  );",
        "  const label = computed(() => `Total: ${items.get().length}`);",
        "  const itemCount = computed(() => items.get().length);",
        '  return { [NAME]: "Repeated Proxy Repro", items, filteredItems, label, itemCount, addItem };',
        "});",
        "",
        "export default pattern(() => {",
        "  const subject = RepeatedProxyRepro({ items: [] });",
        "  const actionAdd = action(() => {",
        "    subject.addItem.send();",
        "  });",
        "  const itemsLength = computed(() => subject.items.length === 0);",
        "  const itemsSpreadLength = computed(() => [...subject.items].length === 0);",
        "  const filteredLength = computed(() => subject.filteredItems.length === 0);",
        "  const filteredSpreadLength = computed(() => [...subject.filteredItems].length === 0);",
        "  const labelLength = computed(() => subject.label.length === 8);",
        "  const labelNotEmpty = computed(() => subject.label !== '');",
        "  const countIsZero = computed(() => subject.itemCount === 0);",
        "  const itemsLengthAfter = computed(() => subject.items.length === 1);",
        "  const itemsSpreadLengthAfter = computed(() => [...subject.items].length === 1);",
        "  const filteredLengthAfter = computed(() => subject.filteredItems.length === 1);",
        "  const filteredSpreadLengthAfter = computed(() => [...subject.filteredItems].length === 1);",
        "  const labelLengthAfter = computed(() => subject.label.length === 8);",
        "  const labelAfter = computed(() => subject.label === 'Total: 1');",
        "  const countAfter = computed(() => subject.itemCount === 1);",
        "  return {",
        "    actionAdd,",
        "    itemsLength,",
        "    itemsSpreadLength,",
        "    filteredLength,",
        "    filteredSpreadLength,",
        "    labelLength,",
        "    labelNotEmpty,",
        "    countIsZero,",
        "    itemsLengthAfter,",
        "    itemsSpreadLengthAfter,",
        "    filteredLengthAfter,",
        "    filteredSpreadLengthAfter,",
        "    labelLengthAfter,",
        "    labelAfter,",
        "    countAfter,",
        "  };",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );

      const normalized = result.output.replace(/\s+/g, " ");
      assertEquals(
        normalized.includes(
          'const labelNotEmpty = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }, required: ["subject"] }',
        ),
        true,
        `expected repeated labelNotEmpty capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const countIsZero = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { itemCount: { type: "number" } }, required: ["itemCount"] } }, required: ["subject"] }',
        ),
        true,
        `expected repeated countIsZero capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const labelAfter = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }, required: ["subject"] }',
        ),
        true,
        `expected repeated labelAfter capture to stay narrowed:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'const countAfter = __ctHelpers.derive({ type: "object", properties: { subject: { type: "object", properties: { itemCount: { type: "number" } }, required: ["itemCount"] } }, required: ["subject"] }',
        ),
        true,
        `expected repeated countAfter capture to stay narrowed:\n${result.output}`,
      );
    },
  );

  await t.step(
    "no error when lift accesses item properties on a direct array parameter",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Item {",
        "  id: string;",
        "  stage: string;",
        "}",
        "",
        "const summarize = lift((entries: Item[]) => {",
        "  const active = entries.filter((entry) => entry.stage !== 'retired')",
        "    .map((entry) => entry.id);",
        "  for (const entry of entries) {",
        "    console.log(entry.stage);",
        "  }",
        "  return active;",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      const errors = getShrinkErrors(diagnostics);
      assertEquals(
        errors.length,
        0,
        `Expected no array-item shrink errors but got: ${
          errors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "lift preserves item schemas for readonly array parameters",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Candidate {",
        "  id: string;",
        "  score: number;",
        "}",
        "",
        "const eligibleIds = lift((list: readonly Candidate[]) =>",
        "  list.map((candidate) => candidate.id)",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /type:\s*"array"/.test(inputSchema),
        true,
        `expected readonly array input to remain array-shaped:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*id:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected readonly array input to retain candidate.id:\n${inputSchema}`,
      );
      assertEquals(
        inputSchema.trim() === "true",
        false,
        `did not expect readonly array input to collapse to boolean true:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "lift preserves inherited interface members when narrowing array items",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface LeadState {",
        "  id: string;",
        "  name: string;",
        "  base: number;",
        "  signals: Record<string, number>;",
        "}",
        "",
        "interface LeadSignalBreakdown {",
        "  signal: string;",
        "  label: string;",
        "  count: number;",
        "  weight: number;",
        "  contribution: number;",
        "}",
        "",
        "interface LeadScoreSummary extends LeadState {",
        "  score: number;",
        "  signalBreakdown: LeadSignalBreakdown[];",
        "}",
        "",
        "const scoreByLead = lift((list: LeadScoreSummary[] | undefined) => {",
        "  const record: Record<string, number> = {};",
        "  for (const entry of list ?? []) {",
        "    record[entry.id] = entry.score;",
        "  }",
        "  return record;",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*id:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected inherited id field in narrowed item schema:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*score:\s*{\s*type:\s*"number"/.test(inputSchema),
        true,
        `expected direct score field in narrowed item schema:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "lift preserves item fields through filter-map chains",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Candidate {",
        "  id: string;",
        "  eligible: boolean;",
        "}",
        "",
        "const eligibleIds = lift((list: Candidate[]) =>",
        "  list.filter((entry) => entry.eligible).map((entry) => entry.id)",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*eligible:\s*{\s*type:\s*"boolean"/.test(inputSchema),
        true,
        `expected filter predicate to retain entry.eligible:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*id:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected chained map to retain entry.id:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "lift preserves array item key fields through filter-map chains",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Row {",
        "  key: string;",
        "  active: boolean;",
        "}",
        "",
        "const activeKeys = lift((rows: Row[]) =>",
        "  rows.filter((row) => row.active).map((row) => row.key)",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*active:\s*{\s*type:\s*"boolean"/.test(inputSchema),
        true,
        `expected filter predicate to retain row.active:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*key:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected chained map to retain row.key:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "lift preserves array item key fields through find-result property access",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Row {",
        "  key: string;",
        "  label: string;",
        "}",
        "",
        "const activeLabel = lift((input: { active: string; rows: Row[] }) =>",
        "  input.rows.find((row) => row.key === input.active)?.label ?? 'All'",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /rows:\s*{[\s\S]*items:\s*{[\s\S]*key:\s*{\s*type:\s*"string"/.test(
          inputSchema,
        ),
        true,
        `expected find predicate to retain row.key:\n${inputSchema}`,
      );
      assertEquals(
        /rows:\s*{[\s\S]*items:\s*{[\s\S]*label:\s*{\s*type:\s*"string"/.test(
          inputSchema,
        ),
        true,
        `expected find result access to retain row.label:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "interprocedural lift preserves item fields through local array aggregates",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Candidate {",
        "  id: string;",
        "  age: number;",
        "}",
        "",
        "interface Result {",
        "  candidate: Candidate;",
        "  eligible: boolean;",
        "}",
        "",
        "const buildReport = (candidates: readonly Candidate[]): Result[] => {",
        "  const results: Result[] = [];",
        "  for (const candidate of candidates) {",
        "    results.push({ candidate, eligible: candidate.age >= 18 });",
        "  }",
        "  results.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));",
        "  return results;",
        "};",
        "",
        "const report = lift((candidates: Candidate[]) => buildReport(candidates));",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*age:\s*{\s*type:\s*"number"/.test(inputSchema),
        true,
        `expected aggregate builder to retain candidate.age:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*id:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected aggregate builder to retain candidate.id:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "interprocedural lift preserves item fields through local map aggregates",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commontools";',
        "",
        "interface Grade {",
        "  studentId: string;",
        "  score: number;",
        "}",
        "",
        "const totalScore = (entries: readonly Grade[]): number => {",
        "  const byStudent = new Map<string, Grade>();",
        "  for (const entry of entries) {",
        "    byStudent.set(entry.studentId, entry);",
        "  }",
        "  let total = 0;",
        "  for (const studentId of ['alpha']) {",
        "    const grade = byStudent.get(studentId);",
        "    total += grade?.score ?? 0;",
        "  }",
        "  return total;",
        "};",
        "",
        "const summarize = lift((entries: Grade[]) => totalScore(entries));",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 1, "expected input and result schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /items:\s*{[\s\S]*studentId:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected map aggregate to retain grade.studentId:\n${inputSchema}`,
      );
      assertEquals(
        /items:\s*{[\s\S]*score:\s*{\s*type:\s*"number"/.test(inputSchema),
        true,
        `expected map aggregate to retain grade.score:\n${inputSchema}`,
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

  await t.step(
    "derive for-of callbacks shrink array item schemas to the accessed item surface",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { derive, pattern } from "commontools";',
        "",
        "interface Item {",
        "  name: string;",
        "  category: string;",
        "  price: number;",
        "}",
        "",
        "export default pattern<{ items: Item[] }>(({ items }) => {",
        "  const names = derive({ items }, ({ items }) => {",
        "    const result: string[] = [];",
        "    for (const item of items) {",
        "      result.push(item.name);",
        "    }",
        "    return result;",
        "  });",
        "  return { names };",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `derive for-of shrink had errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /name:\s*{\s*type:\s*"string"/.test(inputSchema),
        true,
        `expected shrunk item schema to keep name only:\n${inputSchema}`,
      );
      assertEquals(
        /category:\s*{\s*type:\s*"string"/.test(inputSchema),
        false,
        `did not expect full item schema to keep category:\n${inputSchema}`,
      );
      assertEquals(
        /price:\s*{\s*type:\s*"number"/.test(inputSchema),
        false,
        `did not expect full item schema to keep price:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "computed nested for-of callbacks shrink captured array/object schemas to the accessed surface",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, pattern } from "commontools";',
        "",
        "interface NotebookPiece {",
        "  title?: string;",
        "  notes?: NotePiece[];",
        "  isNotebook?: boolean;",
        "}",
        "",
        "interface NotePiece {",
        "  title?: string;",
        "  content?: string;",
        "}",
        "",
        "export default pattern<{ notebooks: NotebookPiece[]; query: string }>(",
        "  ({ notebooks, query }) => {",
        "    const matchingNotes = computed(() => {",
        "      const result: NotePiece[] = [];",
        "      for (const nb of notebooks) {",
        "        for (const note of nb?.notes ?? []) {",
        "          if (note?.title?.includes(query)) {",
        "            result.push(note);",
        "          }",
        "        }",
        "      }",
        "      return result;",
        "    });",
        "    return { matchingNotes };",
        "  },",
        ");",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `computed for-of shrink had errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const inputSchema = schemas[0]!;

      assertEquals(
        /notes:\s*{/.test(inputSchema),
        true,
        `expected shrunk notebook schema to keep notes:\n${inputSchema}`,
      );
      assertEquals(
        /notes:\s*{[\s\S]*items:\s*{[\s\S]*title:\s*{[\s\S]*type:\s*"string"/
          .test(inputSchema),
        true,
        `expected shrunk note schema to keep title:\n${inputSchema}`,
      );
      assertEquals(
        /isNotebook:\s*{\s*type:\s*"boolean"/.test(inputSchema),
        false,
        `did not expect notebook shrink to keep isNotebook:\n${inputSchema}`,
      );
      assertEquals(
        /content:\s*{\s*type:\s*"string"/.test(inputSchema),
        false,
        `did not expect note shrink to keep content:\n${inputSchema}`,
      );
    },
  );

  await t.step(
    "action captures preserve explicit undefined for Partial cell members",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { Cell, pattern, action } from "commontools";',
        "",
        "interface BaseState {",
        "  a: Cell<string>;",
        "  b: Cell<number>;",
        "}",
        "",
        "type PartState = Partial<BaseState>;",
        "",
        "export default pattern<PartState>(({ a, b }) => {",
        "  return {",
        "    readA: action(() => console.log(a)),",
        "    readB: action(() => console.log(b)),",
        "  };",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const normalized = result.output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'handler(false as const satisfies __ctHelpers.JSONSchema, { type: "object", properties: { a: { anyOf: [{ type: "undefined" }, { type: "string", asCell: true }] } } } as const satisfies __ctHelpers.JSONSchema',
        ),
        true,
        `expected action capture for a to preserve explicit undefined:\n${result.output}`,
      );
      assertEquals(
        normalized.includes(
          'handler(false as const satisfies __ctHelpers.JSONSchema, { type: "object", properties: { b: { anyOf: [{ type: "undefined" }, { type: "number", asCell: true }] } } } as const satisfies __ctHelpers.JSONSchema',
        ),
        true,
        `expected action capture for b to preserve explicit undefined:\n${result.output}`,
      );
    },
  );

  await t.step(
    "derive captures preserve explicit undefined inside narrowed object wrappers",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { Writable, derive, pattern } from "commontools";',
        "",
        "interface Config {",
        "  required: number;",
        "  unionUndefined: number | undefined;",
        "}",
        "",
        "export default pattern((config: Config) => {",
        "  const value = Writable.of(10);",
        "  const result = derive(value, (v) =>",
        "    v.get() + config.required + (config.unionUndefined ?? 0)",
        "  );",
        "  return result;",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const normalized = result.output.replace(/\s+/g, " ");

      assertEquals(
        normalized.includes(
          'config: { type: "object", properties: { required: { type: "number" }, unionUndefined: { type: ["number", "undefined"] } }, required: ["required", "unionUndefined"] }',
        ) ||
          normalized.includes(
            'config: { type: "object", properties: { required: { type: "number" }, unionUndefined: { anyOf: [{ type: "number" }, { type: "undefined" }] } }, required: ["required", "unionUndefined"] }',
          ),
        true,
        `expected derive capture schema to preserve config.required and config.unionUndefined:\n${result.output}`,
      );
      assertEquals(
        normalized.includes("config: true"),
        false,
        `did not expect derive capture wrapper to collapse to true:\n${result.output}`,
      );
    },
  );

  await t.step(
    "computed preserves record value item schemas through aliased fallback record access",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, pattern } from "commontools";',
        "",
        "interface Suggestion {",
        "  tag: string;",
        "  count: number;",
        "  source: string;",
        "}",
        "",
        "interface AggregatorOutput {",
        "  suggestions: Record<string, Suggestion[]>;",
        "}",
        "",
        "const Aggregator = pattern<Record<string, never>, AggregatorOutput>(() => ({",
        "  suggestions: {} as Record<string, Suggestion[]>,",
        "}));",
        "",
        "export default pattern(() => {",
        "  const aggregator = Aggregator({});",
        "  const ok = computed(() => {",
        "    const suggs = (aggregator.suggestions || {}) as Record<string, Suggestion[]>;",
        '    const alpha = (suggs["scope-a"] || []).find((item) => item.tag === "alpha");',
        "    return alpha?.count === 5;",
        "  });",
        "  return { ok };",
        "});",
      ].join("\n");
      const result = await validateSource(source, {
        types: COMMONTOOLS_TYPES,
      });
      assertEquals(
        getShrinkErrors(result.diagnostics).length,
        0,
        `expected no shrink errors: ${fmtErrors(result.diagnostics)}`,
      );
      const schemas = extractSchemas(result.output);
      assertGreater(schemas.length, 0, "expected transformed schemas");
      const inputSchema = schemas.find((schema) =>
        schema.includes("aggregator:") && schema.includes("suggestions:")
      );
      assertEquals(
        !!inputSchema,
        true,
        `expected a computed input schema for aggregator.suggestions:\n${result.output}`,
      );
      const normalizedInputSchema = inputSchema!.replace(/\s+/g, " ");

      assertEquals(
        normalizedInputSchema.includes(
          'suggestions: { type: "object", properties: { "scope-a": { type: "array", items: { type: "object", properties: { tag: { type: "string" }',
        ),
        true,
        `expected aliased fallback record access to preserve scope-a item tag schema:\n${inputSchema}`,
      );
      assertEquals(
        normalizedInputSchema.includes(
          'count: { type: "number" }',
        ),
        true,
        `expected aliased fallback record access to preserve scope-a item count schema:\n${inputSchema}`,
      );
      assertEquals(
        normalizedInputSchema.includes(
          'suggestions: { type: "object", properties: {} }',
        ),
        false,
        `did not expect record shrink to erase additionalProperties/item schemas:\n${inputSchema}`,
      );
      assertEquals(
        normalizedInputSchema.includes(
          'source: { type: "string" }',
        ),
        false,
        `did not expect unused suggestion.source to be retained:\n${inputSchema}`,
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
