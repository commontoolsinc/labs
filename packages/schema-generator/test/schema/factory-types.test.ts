import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { detectTrustedFactoryType } from "../../src/formatters/factory-formatter.ts";
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
  it("does not grant factory semantics to a user type merely named PatternFactory", async () => {
    const code = `
      type PatternFactory<T, R> = (input: T) => R;
      type SchemaRoot = PatternFactory<{ value: number }, string>;
    `;
    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    expect(detectTrustedFactoryType(type, checker)).toBeUndefined();
  });

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

  it("terminates when a factory result recursively contains the factory", async () => {
    const code = `${FACTORY_DECLARATIONS}
      interface RecursiveResult {
        self: ModuleFactory<{ value: string }, RecursiveResult>;
      }

      interface SchemaRoot {
        factory: ModuleFactory<{ value: string }, RecursiveResult>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(type, checker),
    );

    const resultSchema = (schema.properties?.factory as any).asFactory
      .resultSchema;
    expect(resultSchema.$ref).toBe("#/$defs/RecursiveResult");
    expect(
      resultSchema.$defs.RecursiveResult.properties.self.asFactory.resultSchema,
    ).toEqual({ $ref: "#/$defs/RecursiveResult" });
  });

  it("uses compiler-owned exact contracts for factories inside readonly tuples", async () => {
    const code = `${FACTORY_DECLARATIONS}
      type SchemaRoot = readonly [PatternFactory<{ stale: string }, any>];
    `;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const tuple = typeNode && ts.isTypeOperatorNode(typeNode)
      ? typeNode.type
      : typeNode;
    if (!tuple || !ts.isTupleTypeNode(tuple)) {
      throw new Error("Expected readonly tuple type node");
    }
    const factoryNode = tuple.elements[0]!;
    const inputTypeNode = ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        "current",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ),
    ]);
    const outputTypeNode = ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        "result",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
      ),
    ]);
    const schemaHints = new WeakMap<ts.Node, {
      factoryContracts?: readonly {
        kind: "pattern";
        inputTypeNode: ts.TypeNode;
        outputTypeNode: ts.TypeNode;
      }[];
    }>();
    schemaHints.set(factoryNode, {
      factoryContracts: [{ kind: "pattern", inputTypeNode, outputTypeNode }],
    });

    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints,
      ),
    );
    expect((schema.items as any).asFactory).toEqual({
      kind: "pattern",
      argumentSchema: {
        type: "object",
        properties: { current: { type: "number" } },
        required: ["current"],
      },
      resultSchema: {
        type: "object",
        properties: { result: { type: "boolean" } },
        required: ["result"],
      },
    });
  });

  it("emits every compiler-owned contract sharing one semantic factory type", async () => {
    const code = `${FACTORY_DECLARATIONS}
      type SchemaRoot = PatternFactory<{ stale: string }, any>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const objectType = (name: string, value: ts.KeywordTypeSyntaxKind) =>
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          name,
          undefined,
          ts.factory.createKeywordTypeNode(value),
        ),
      ]);
    const inputTypeNode = objectType("value", ts.SyntaxKind.StringKeyword);
    const schemaHints = new WeakMap<ts.Node, unknown>();
    schemaHints.set(typeNode!, {
      factoryContracts: [
        {
          kind: "pattern",
          inputTypeNode,
          outputTypeNode: objectType("text", ts.SyntaxKind.StringKeyword),
        },
        {
          kind: "pattern",
          inputTypeNode,
          outputTypeNode: objectType("size", ts.SyntaxKind.NumberKeyword),
        },
      ],
    });

    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints as never,
      ),
    );
    expect(schema.anyOf).toEqual([
      {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
      {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            properties: { size: { type: "number" } },
            required: ["size"],
          },
        },
      },
    ]);
  });

  it("preserves exact compiler-owned schema values beyond TypeScript types", async () => {
    const code = `${FACTORY_DECLARATIONS}
      type SchemaRoot = PatternFactory<{ stale: string }, any>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const unknownNode = ts.factory.createKeywordTypeNode(
      ts.SyntaxKind.UnknownKeyword,
    );
    const schemaHints = new WeakMap<ts.Node, unknown>();
    schemaHints.set(typeNode!, {
      factoryContracts: [{
        kind: "pattern",
        inputTypeNode: unknownNode,
        inputSchema: {
          type: "string",
          description: "authored metadata",
          minLength: 3,
        },
        outputTypeNode: unknownNode,
        outputSchema: false,
      }],
    });

    const schema = asObjectSchema(
      createSchemaTransformerV2().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints as never,
      ),
    );
    expect(schema.asFactory).toEqual({
      kind: "pattern",
      argumentSchema: {
        type: "string",
        description: "authored metadata",
        minLength: 3,
      },
      resultSchema: false,
    });
  });
});
