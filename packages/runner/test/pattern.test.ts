import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type FactoryInput,
  type Frame,
  isModule,
  isPattern,
  type JSONSchema,
  type Module,
  type Pattern,
} from "../src/builder/types.ts";
import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("pattern", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
  });

  it("creates a pattern", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift(({ x }) => x * 2);
      return { double: double({ x }) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates a pattern, with simple function", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(x) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates a pattern, with an inner opaque ref", () => {
    const double = lift(({ x }) => x * 2);
    const doublePattern = pattern<{ x: number }>(() => {
      const x = reactive<number>(1);
      (x as any).for("x");
      return { double: double({ x }) };
    });
    expect(isPattern(doublePattern)).toBe(true);
    expect(doublePattern.nodes.length).toBe(1);
    expect(doublePattern.nodes[0].inputs).toMatchObject({
      x: {
        $alias: {
          partialCause: "x",
          path: [],
          scope: "space",
        },
      },
    });
    expect(doublePattern.derivedInternalCells).toEqual([
      {
        partialCause: "double",
      },
      {
        partialCause: "x",
        schema: { default: 1 },
      },
    ]);
  });

  it("derives numeric partial causes for anonymous internal roots", () => {
    const increment = lift((x: number) => x + 1);
    const double = lift((x: number) => x * 2);
    const testPattern = pattern<{ x: number }>(({ x }) => {
      const intermediate = increment(x);
      return { doubled: double(intermediate) };
    });

    expect(testPattern.derivedInternalCells).toEqual([
      {
        partialCause: { $generated: 0 },
      },
      {
        partialCause: "doubled",
      },
    ]);
    expect(testPattern.nodes[0].outputs).toMatchObject({
      $alias: { partialCause: { $generated: 0 }, path: [] },
    });
  });

  it("uniquifies repeated stable internal paths with schemas", () => {
    const isPositive = lift(
      (value: number) => value > 0,
      { type: "number" } as const satisfies JSONSchema,
      { type: "boolean" } as const satisfies JSONSchema,
    );

    const testPattern = pattern(() => {
      const first = (isPositive(1) as any).for("isSelected", true);
      const second = (isPositive(2) as any).for("isSelected", true);
      return { first, second };
    });

    const firstPath = (testPattern.result as any).first.$alias.path;
    const secondPath = (testPattern.result as any).second.$alias.path;
    expect((testPattern.result as any).first.$alias.partialCause).toBe(
      "isSelected",
    );
    expect((testPattern.result as any).second.$alias.partialCause).toEqual({
      name: "isSelected",
      $generated: 0,
    });
    expect(firstPath).toEqual([]);
    expect(secondPath).toEqual([]);
    expect(testPattern.derivedInternalCells).toEqual([
      {
        partialCause: "isSelected",
        schema: { type: "boolean" },
      },
      {
        partialCause: {
          name: "isSelected",
          $generated: 0,
        },
        schema: { type: "boolean" },
      },
    ]);
  });

  it("rejects a reserved $generated key in user-supplied causes at build time", () => {
    const isPositive = lift((value: number) => value > 0);

    // A user cause carrying `$generated` would mimic the anonymous-cause
    // namespace — the build throws at the `.for()` call.
    expect(() =>
      pattern(() => {
        const sneaky = (isPositive(1) as any).for({ $generated: 0 });
        return { sneaky };
      })
    ).toThrow('top-level key "$generated" is reserved');

    expect(() =>
      pattern(() => {
        const sneaky = (isPositive(1) as any).for({
          $kind: "stream",
          $generated: 0,
        });
        return { sneaky };
      })
    ).toThrow("is reserved");
  });

  it("accepts record causes without a top-level $generated key", () => {
    const isPositive = lift((value: number) => value > 0);

    const testPattern = pattern(() => {
      // Nested `$generated` can't collide with the flat generated causes, and
      // only `$generated` is reserved — other `$`-keys stay legal.
      const nested = (isPositive(1) as any).for({ outer: { $generated: 0 } });
      const sigilish = (isPositive(2) as any).for({ $kind: "stream" });
      return { nested, sigilish };
    });

    // Both records flow through as partial causes unchanged.
    expect((testPattern.result as any).nested.$alias.partialCause).toEqual({
      outer: { $generated: 0 },
    });
    expect((testPattern.result as any).sigilish.$alias.partialCause).toEqual({
      $kind: "stream",
    });
  });

  it("complex pattern has correct schema and nodes", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(double(x)) };
    });
    const { argumentSchema, result, nodes } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toBe(true);
    expect(result).toEqual({
      double: {
        $alias: {
          partialCause: "double",
          path: [],
          scope: "space",
        },
      },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      $alias: { cell: "argument", path: ["x"], scope: "space" },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].inputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: {
        partialCause: "double",
        path: [],
        scope: "space",
      },
    });
  });

  it("supports JSON Schema with descriptions", () => {
    const schema = {
      type: "object",
      properties: {
        x: { type: "number" },
      },
      description: "A number",
    } as const satisfies JSONSchema;

    const testPattern = pattern<{ x: number }>(({ x }) => ({ x }), schema);
    expect(isPattern(testPattern)).toBe(true);
    expect(testPattern.argumentSchema).toMatchObject({
      description: "A number",
      type: "object",
      properties: {
        x: { type: "number" },
      },
    });
  });

  it("works with JSON Schema in lifted functions", () => {
    const inputSchema = {
      type: "number",
      description: "A number",
    } as const satisfies JSONSchema;

    const outputSchema = {
      type: "number",
      description: "Doubled",
    } as const satisfies JSONSchema;

    const double = lift(
      (x: number) => x * 2,
      inputSchema,
      outputSchema,
    );

    const patternInputSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
      },
    } as const satisfies JSONSchema;

    const testPattern = pattern<{ x: number }>(({ x }) => ({
      doubled: double(x),
    }), patternInputSchema);

    const module = testPattern.nodes[0].module as Module;
    expect(module.argumentSchema).toMatchObject({
      description: "A number",
      type: "number",
    });
    expect(module.resultSchema).toMatchObject({
      description: "Doubled",
      type: "number",
    });
  });

  it("complex pattern with path aliases has correct schema, nodes, and serialization", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<{ x: number }>(({ x }) => ({ doubled: x * 2 }));
      const result = double({ x });
      const result2 = double({ x: result.doubled });
      return { double: result2.doubled };
    });
    const { argumentSchema, result, nodes } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toBe(true);
    expect(result).toEqual({
      double: {
        $alias: {
          partialCause: { $generated: 1 },
          path: ["doubled"],
          scope: "space",
        },
      },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      x: { $alias: { cell: "argument", path: ["x"], scope: "space" } },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].inputs).toEqual({
      x: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["doubled"],
          scope: "space",
        },
      },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { partialCause: { $generated: 1 }, path: [], scope: "space" },
    });

    const json = JSON.stringify(doublePattern);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    // A test-built (never verified-evaluated) module has no provenance, so
    // the writer keeps the stringified body as the executable fallback. The
    // legacy `implementationRef` is runtime-only since the flip (PR E1) —
    // never serialized.
    expect(typeof parsed.nodes[0].module.implementation).toBe("string");
    expect("implementationRef" in parsed.nodes[0].module).toBe(false);
  });

  it("pattern with map node serializes correctly", () => {
    const doubleArray = pattern<{ values: { x: number }[] }>(
      ({ values }) => {
        const doubled = (values as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            ((({ x }: any) => {
              const double = lift<number>((x) => x * 2);
              return { doubled: double(x) };
            }) as any)(element, index, array)
          ),
          {},
        );
        return { doubled };
      },
    );

    expect(doubleArray.nodes.length).toBe(1);
    const module = doubleArray.nodes[0].module as Module;
    expect(module.type).toBe("ref");
    expect(module.implementation).toBe("map");

    const node = doubleArray.nodes[0];
    expect(node.inputs).toMatchObject({
      list: { $alias: { cell: "argument", path: ["values"] } },
    });

    const inputs = doubleArray.nodes[0].inputs as unknown as { op: Pattern };
    expect(isPattern(inputs.op)).toBe(true);

    const innerModule = inputs.op.nodes[0].module as Module;
    expect(innerModule.type).toBe("javascript");
    expect(typeof innerModule.implementation).toBe("function");
  });

  it("pattern with ifc property has correct confidentiality tracking", () => {
    const ArgumentSchema = {
      description: "Double a number",
      type: "object",
      properties: {
        x: {
          type: "integer",
          default: 1,
          ifc: { confidentiality: ["confidential"] },
        },
      },
      required: ["x"],
    } as const satisfies JSONSchema;
    const ResultSchema = {
      description: "Doubled number",
      type: "object",
      properties: {
        double: {
          type: "integer",
          default: 1,
        },
      },
      required: ["double"],
    } as const satisfies JSONSchema;

    const double = lift(
      ({ x }: { x: number }) => ({
        double: x * 2,
      }),
      ArgumentSchema,
      ResultSchema,
    );

    const doublePattern = pattern<{ x: number }, { double: number }>(
      ({ x }) => {
        const result = double({ x });
        const result2 = double({ x: result.double });
        return { double: result2.double };
      },
      ArgumentSchema,
      ResultSchema,
    );
    const { result, nodes, argumentSchema } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toMatchObject(ArgumentSchema);

    // It would be nice if we also had the {"type": "integer"} for the schema
    // The lifted function knows this in the result schema
    expect(result).toMatchObject({
      double: {
        $alias: {
          partialCause: { $generated: 1 },
          path: ["double"],
          schema: {
            ifc: ArgumentSchema.properties.x.ifc,
          },
        },
      },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toMatchObject({
      x: {
        $alias: {
          cell: "argument",
          path: ["x"],
          schema: ArgumentSchema.properties?.x,
        },
      },
    });
    // I don't like that we don't know the other properties of our output here
    expect(nodes[0].outputs).toMatchObject({
      $alias: {
        partialCause: { $generated: 0 },
        path: [],
        schema: { ifc: ArgumentSchema.properties.x.ifc },
      },
    });
    expect(nodes[1].inputs).toMatchObject({
      x: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["double"],
          schema: {
            ifc: ArgumentSchema.properties.x.ifc,
          },
        },
      },
    });
    expect(nodes[1].outputs).toMatchObject({
      $alias: {
        partialCause: { $generated: 1 },
        path: [],
        schema: {
          ifc: ArgumentSchema.properties.x.ifc,
        },
      },
    });
  });

  it("pattern with mixed ifc properties has correct confidentiality in the schema of the ssn result", () => {
    const ArgumentSchema = {
      description: "Capitalize a word",
      type: "object",
      properties: {
        word: {
          type: "string",
          default: "hello",
        },
      },
      required: ["word"],
    } as const satisfies JSONSchema;
    const ResultSchema = {
      description: "Capitalized word",
      type: "object",
      properties: {
        capitalized: {
          type: "string",
          default: "Hello",
        },
      },
      required: ["capitalized"],
    } as const satisfies JSONSchema;

    // Input typed loosely (the original used the schema-first overload whose
    // input was JSONSchema); this lift is applied below with `{ ssn }`.
    const capitalize = lift(
      ({ word }: any) => ({
        capitalized: word.charAt(0).toUpperCase() + word.slice(1),
      }),
      ArgumentSchema,
      ResultSchema,
    );

    const UserSchema = {
      description: "Capitalize a word",
      type: "object",
      properties: {
        name: {
          type: "string",
          default: "hello",
        },
        ssn: {
          type: "string",
          default: "123-45-6789",
          ifc: { confidentiality: ["confidential"] },
        },
      },
      required: ["word"],
    } as const satisfies JSONSchema;

    const capitalizeSsnPattern = pattern<
      { ssn: string },
      { capitalized: string }
    >(
      ({ ssn }) => {
        const result = capitalize({ ssn });
        return { capitalized: result.capitalized };
      },
      UserSchema,
      ResultSchema,
    );

    const { result, nodes, argumentSchema, resultSchema } =
      capitalizeSsnPattern;
    expect(isPattern(capitalizeSsnPattern)).toBe(true);
    expect(argumentSchema).toMatchObject(UserSchema);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].outputs).toHaveProperty("$alias");
    const nodeOutputAlias = (nodes[0].outputs as any)["$alias"];
    expect(nodeOutputAlias).toMatchObject({
      partialCause: { $generated: 0 },
      path: [],
      schema: { ifc: { confidentiality: ["confidential"] } },
    });
    expect(result).toMatchObject({
      capitalized: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["capitalized"],
          schema: { ifc: { confidentiality: ["confidential"] } },
        },
      },
    });
    expect(resultSchema).toMatchObject({
      ...ResultSchema,
      ...{ ifc: { confidentiality: ["confidential"] } },
    });

    // Perhaps I should handle a similar pattern that only accesses the name
    // in such a way that it does not end up confidential. For now, I've decided
    // not to do this, since I'm not confident enough that code can't get out.
  });

  it("creates a pattern with function-only syntax (no schema)", () => {
    const doublePattern = pattern((input: { x: any }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(input.x) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates nodes correctly with function-only syntax", () => {
    const doublePattern = pattern((input: { x: any }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(double(input.x)) };
    });

    const { nodes } = doublePattern;
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
  });

  it("supports never schemas", () => {
    const neverPattern = pattern(
      () => {
      },
      false,
      false,
    );
    expect(isPattern(neverPattern)).toBe(true);
  });
});
