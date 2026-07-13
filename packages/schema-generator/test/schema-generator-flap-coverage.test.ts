import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, createTestProgram, getTypeFromCode } from "./utils.ts";

// The branches exercised here otherwise run only when a pattern compiles
// "cold" through the transformer. When the compile cache is warm those code
// paths are skipped, so the lines are recorded as covered in some CI runs and
// uncovered in others. These unit tests drive the same branches directly with
// hand-built type declarations so they are covered on every run.

describe("SchemaGenerator flap coverage", () => {
  it("resolves the element type of an array type alias to the concrete element schema", async () => {
    // type-utils.ts getArrayElementInfo: when a property's TypeNode is a
    // reference to a type alias whose right-hand side is `Element[]`, the
    // element type is read from the alias body. `Element` is a concrete type
    // (not a type parameter), so its resolved type is used and the array's
    // items schema is the element type's schema.
    const code = `
interface Element { id: number; label: string; }
type ElementList = Element[];
interface Root { items: ElementList; }
`;
    const { type, checker, typeNode } = await getTypeFromCode(code, "Root");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(
      generator.generateSchema(type, checker, typeNode),
    );

    const props = schema.properties as Record<string, unknown>;
    const itemsSchema = props.items as Record<string, unknown>;
    expect(itemsSchema.type).toBe("array");
    // The element type resolves to the concrete `Element` object, hoisted into
    // $defs and referenced by the array's items.
    expect(itemsSchema.items).toEqual({ $ref: "#/$defs/Element" });

    const defs = (schema as Record<string, unknown>).$defs as Record<
      string,
      unknown
    >;
    expect(defs.Element).toEqual({
      type: "object",
      properties: {
        id: { type: "number" },
        label: { type: "string" },
      },
      required: ["id", "label"],
    });
  });

  it("uses a type parameter's default type when it has no base constraint", async () => {
    // schema-generator.ts formatType: for a bare type parameter with no base
    // constraint but a declared default, the schema is generated from the
    // default type. Here the parameter `T` defaults to `Preset`, so the alias
    // `type WithDefault<T = Preset> = T` formats to `Preset`'s schema.
    const code = `
interface Preset { name: string; count: number; }
type WithDefault<T = Preset> = T;
`;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "WithDefault",
    );
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(
      generator.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      name: { type: "string" },
      count: { type: "number" },
    });
    expect(schema.required).toEqual(["name", "count"]);
  });

  it("treats a deferred conditional type as an unconstrained schema", async () => {
    // schema-generator.ts formatType: a conditional type whose condition
    // depends on an unresolved type parameter stays deferred (its flags carry
    // ts.TypeFlags.Conditional). The generator cannot know the concrete branch
    // at compile time, so the property's schema is the empty (accept-anything)
    // schema `{}`.
    const code = `
type Narrow<T> = T extends string ? number : boolean;
interface Root<T> { field: Narrow<T>; }
`;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));

    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props.field).toEqual({});
    expect(schema.required).toEqual(["field"]);
  });

  it("maps synthetic boolean literal type nodes to boolean const schemas", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: the node-based path maps a
    // `true` literal type node to { type: "boolean", const: true } and a
    // `false` literal type node to { type: "boolean", const: false }.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();

    const trueNode = ts.factory.createLiteralTypeNode(ts.factory.createTrue());
    const falseNode = ts.factory.createLiteralTypeNode(
      ts.factory.createFalse(),
    );

    expect(
      generator.generateSchemaFromSyntheticTypeNode(trueNode, checker),
    ).toEqual({ type: "boolean", const: true });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(falseNode, checker),
    ).toEqual({ type: "boolean", const: false });
  });

  it("resolves a non-keyword type node through the checker when node-based analysis is forced", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: for a real TypeNode kind
    // that none of the earlier node branches or the keyword switch handles, the
    // node is resolved to a Type via the checker; when that Type is not `any`
    // it is formatted through formatChildType. A `keyof` type operator node is
    // one such kind. Pairing it with the `any` Type forces the node-based path,
    // mirroring the transformer's lift-revisit which feeds `any` as the paired
    // Type alongside a concrete node.
    const { checker, sourceFile } = await createTestProgram(
      "interface Options { alpha: string; beta: number; } type Keys = keyof Options;",
    );
    let keyofNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Keys") {
        keyofNode = node.type;
      }
    });
    expect(keyofNode).toBeDefined();

    const generator = new SchemaGenerator();
    const anyType = checker.getAnyType();
    const schema = generator.generateSchema(anyType, checker, keyofNode);

    // `keyof Options` resolves to the union of its literal keys.
    expect(schema).toEqual({ enum: ["alpha", "beta"] });
  });

  it("resolves an indexed-access type node through the checker when node-based analysis is forced", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: same non-keyword resolution
    // branch, driven by an indexed-access type node `Options["alpha"]`. The
    // checker resolves it to the concrete property type, which formats to that
    // property's schema.
    const { checker, sourceFile } = await createTestProgram(
      'interface Options { alpha: string; beta: number; } type Picked = Options["alpha"];',
    );
    let indexedNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Picked") {
        indexedNode = node.type;
      }
    });
    expect(indexedNode).toBeDefined();

    const generator = new SchemaGenerator();
    const anyType = checker.getAnyType();
    const schema = generator.generateSchema(anyType, checker, indexedNode);

    expect(schema).toEqual({ type: "string" });
  });
});
