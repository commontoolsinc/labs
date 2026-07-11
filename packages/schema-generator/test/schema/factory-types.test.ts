import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const FACTORY_DECLARATIONS = `
  declare const FABRIC_FACTORY_TYPE: unique symbol;
  declare const EXTRA_BRAND: unique symbol;

  type FactoryInput<T> = T;
  type FabricFactory<Args extends unknown[], Result> = {
    readonly [FABRIC_FACTORY_TYPE]: { readonly args: Args; readonly result: Result };
  };
  type PatternFactory<T, R> =
    & ((inputs: FactoryInput<T>) => Reactive<R>)
    & FabricFactory<[FactoryInput<T>], Reactive<R>>
    & { argumentSchema: object; resultSchema: object };
  type ModuleFactory<T, R> =
    & ((inputs: FactoryInput<T>) => Reactive<R>)
    & FabricFactory<[FactoryInput<T>], Reactive<R>>
    & { type: "ref" | "javascript" };
  type HandlerFactory<T, E> =
    & ((context: FactoryInput<T>) => Stream<E>)
    & FabricFactory<[FactoryInput<T>], Stream<E>>
    & { type: "ref" | "javascript"; with(inputs: FactoryInput<T>): Stream<E> };

  type PatternAlias<T, R> = PatternFactory<T, R>;
  type BrandedModule<T, R> = ModuleFactory<T, R> & {
    readonly [EXTRA_BRAND]: true;
  };
`;

describe("Schema: factory types", () => {
  it("emits the public schemas for all three factory kinds", async () => {
    const code = `${FACTORY_DECLARATIONS}
      interface SchemaRoot {
        pattern: PatternFactory<{ query: string }, { count: number }>;
        module: ModuleFactory<{ value: number }, { label: string }>;
        handler: HandlerFactory<{ prefix: string }, { value: number }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    expect(schema.properties?.pattern).toEqual({
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    });
    expect(schema.properties?.module).toEqual({
      asFactory: {
        kind: "module",
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      },
    });
    expect(schema.properties?.handler).toEqual({
      asFactory: {
        kind: "handler",
        contextSchema: {
          type: "object",
          properties: { prefix: { type: "string" } },
          required: ["prefix"],
        },
        eventSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
    });
    expect(schema.properties?.handler).not.toHaveProperty("asCell");
  });

  it("preserves aliases, extra branded intersections, containers, and unions", async () => {
    const code = `${FACTORY_DECLARATIONS}
      interface SchemaRoot {
        alias: PatternAlias<{ text: string }, { length: number }>;
        branded: BrandedModule<{ id: string }, boolean>;
        operations: Array<PatternFactory<{ id: string }, string>>;
        byName: Record<string, HandlerFactory<{ room: string }, { body: string }>>;
        selected:
          | PatternFactory<{ query: string }, string>
          | ModuleFactory<{ value: number }, number>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    expect((schema.properties?.alias as any).asFactory.kind).toBe("pattern");
    expect((schema.properties?.alias as any).asFactory.argumentSchema)
      .toEqual({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      });
    expect((schema.properties?.branded as any).asFactory.kind).toBe("module");
    expect((schema.properties?.operations as any).items.asFactory.kind).toBe(
      "pattern",
    );
    expect((schema.properties?.byName as any).additionalProperties.asFactory)
      .toEqual({
        kind: "handler",
        contextSchema: {
          type: "object",
          properties: { room: { type: "string" } },
          required: ["room"],
        },
        eventSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
      });
    expect((schema.properties?.selected as any).anyOf).toHaveLength(2);
    expect((schema.properties?.selected as any).anyOf.map(
      (entry: any) => entry.asFactory.kind,
    )).toEqual(["pattern", "module"]);
  });
});
