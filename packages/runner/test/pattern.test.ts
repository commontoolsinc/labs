import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Frame,
  isModule,
  isPattern,
  type JSONSchema,
  type Module,
  type Pattern,
} from "../src/builder/types.ts";
import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Identity } from "@commontools/identity";

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
      opaqueRefs: new Set(),
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
      const x = opaqueRef<number>(1);
      x.for("x");
      return { double: double({ x }) };
    });
    expect(isPattern(doublePattern)).toBe(true);
    expect(doublePattern.nodes.length).toBe(1);
    expect(doublePattern.nodes[0].inputs).toMatchObject({
      x: { $alias: { path: ["internal", "x"] } },
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
      double: { $alias: { path: ["internal", "double"] } },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({ $alias: { path: ["argument", "x"] } });
    expect(nodes[0].outputs).toEqual({
      $alias: { path: ["internal", "__#0"] },
    });
    expect(nodes[1].inputs).toEqual({
      $alias: { path: ["internal", "__#0"] },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { path: ["internal", "double"] },
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
      inputSchema,
      outputSchema,
      (x: number) => x * 2,
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
      double: { $alias: { path: ["internal", "__#1", "doubled"] } },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      x: { $alias: { path: ["argument", "x"] } },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { path: ["internal", "__#0"] },
    });
    expect(nodes[1].inputs).toEqual({
      x: { $alias: { path: ["internal", "__#0", "doubled"] } },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { path: ["internal", "__#1"] },
    });

    const json = JSON.stringify(doublePattern);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    expect(parsed.nodes[0].module.implementation).toContain("=>");
  });

  it("pattern with map node serializes correctly", () => {
    const doubleArray = pattern<{ values: { x: number }[] }>(
      ({ values }) => {
        const doubled = values.map(({ x }) => {
          const double = lift<number>((x) => x * 2);
          return { doubled: double(x) };
        });
        return { doubled };
      },
    );

    expect(doubleArray.nodes.length).toBe(1);
    const module = doubleArray.nodes[0].module as Module;
    expect(module.type).toBe("ref");
    expect(module.implementation).toBe("map");

    const node = doubleArray.nodes[0];
    expect(node.inputs).toMatchObject({
      list: { $alias: { path: ["argument", "values"] } },
    });

    const inputs = doubleArray.nodes[0].inputs as unknown as { op: Pattern };
    expect(isPattern(inputs.op)).toBe(true);

    const innerModule = inputs.op.nodes[0].module as Module;
    expect(innerModule.type).toBe("javascript");
    expect(typeof innerModule.implementation).toBe("function");
  });

  it("pattern with ifc property has correct classification tracking", () => {
    const ArgumentSchema = {
      description: "Double a number",
      type: "object",
      properties: {
        x: {
          type: "integer",
          default: 1,
          ifc: { classification: ["confidential"] },
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

    const double = lift<JSONSchema, JSONSchema>(
      ArgumentSchema,
      ResultSchema,
      ({ x }) => ({
        double: x * 2,
      }),
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
          path: ["internal", "__#1", "double"],
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
          path: ["argument", "x"],
          schema: ArgumentSchema.properties?.x,
        },
      },
    });
    // I don't like that we don't know the other properties of our output here
    expect(nodes[0].outputs).toMatchObject({
      $alias: {
        path: ["internal", "__#0"],
        schema: { ifc: ArgumentSchema.properties.x.ifc },
      },
    });
    expect(nodes[1].inputs).toMatchObject({
      x: {
        $alias: {
          path: ["internal", "__#0", "double"],
          schema: {
            ifc: ArgumentSchema.properties.x.ifc,
          },
        },
      },
    });
    expect(nodes[1].outputs).toMatchObject({
      $alias: {
        path: ["internal", "__#1"],
        schema: {
          ifc: ArgumentSchema.properties.x.ifc,
        },
      },
    });
  });

  it("pattern with mixed ifc properties has correct classification in the schema of the ssn result", () => {
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

    const capitalize = lift<JSONSchema, JSONSchema>(
      ArgumentSchema,
      ResultSchema,
      ({ word }) => ({
        capitalized: word.charAt(0).toUpperCase() + word.slice(1),
      }),
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
          ifc: { classification: ["confidential"] },
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
      path: ["internal", "__#0"],
      schema: { ifc: { classification: ["confidential"] } },
    });
    expect(result).toMatchObject({
      capitalized: {
        $alias: {
          path: ["internal", "__#0", "capitalized"],
          schema: { ifc: { classification: ["confidential"] } },
        },
      },
    });
    expect(resultSchema).toMatchObject({
      ...ResultSchema,
      ...{ ifc: { classification: ["confidential"] } },
    });

    // Perhaps I should handle a similar pattern that only accesses the name
    // in such a way that it does not end up classified. For now, I've decided
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
