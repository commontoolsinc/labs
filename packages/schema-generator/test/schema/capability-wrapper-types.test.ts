import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
} from "../utils.ts";

function findInterfaceMemberTypeNode(
  sourceFile: ts.SourceFile,
  interfaceName: string,
  memberName: string,
): ts.TypeNode {
  let found: ts.TypeNode | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === interfaceName
    ) {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          member.type &&
          ts.isIdentifier(member.name) &&
          member.name.text === memberName
        ) {
          found = member.type;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`Member ${interfaceName}.${memberName} not found`);
  }
  return found;
}

describe("Schema: Capability wrapper types", () => {
  it("handles ReadonlyCell, WriteonlyCell, and OpaqueCell", async () => {
    const code = `
      interface X {
        ro: ReadonlyCell<{ foo: string }>;
        wo: WriteonlyCell<{ bar: number }>;
        op: OpaqueCell<{ baz: boolean }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));

    const ro = result.properties?.ro as Record<string, any>;
    const wo = result.properties?.wo as Record<string, any>;
    const op = result.properties?.op as Record<string, any>;

    expect(ro).toBeDefined();
    expect(ro.properties?.foo?.type).toBe("string");
    expect(ro.asCell).toEqual(["readonly"]);

    expect(wo).toBeDefined();
    expect(wo.properties?.bar?.type).toBe("number");
    expect(wo.asCell).toEqual(["writeonly"]);

    expect(op).toBeDefined();
    expect(op.properties?.baz?.type).toBe("boolean");
    expect(op.asCell).toEqual(["opaque"]);
    expect(op).not.toHaveProperty("asOpaque");
  });

  it("resolves alias chains for capability wrappers", async () => {
    const code = `
      type RO<T> = ReadonlyCell<T>;
      type WO<T> = WriteonlyCell<T>;
      type OP<T> = OpaqueCell<T>;

      interface X {
        ro: RO<{ id: string }>;
        wo: WO<{ count: number }>;
        op: OP<{ enabled: boolean }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));

    const ro = result.properties?.ro as Record<string, any>;
    const wo = result.properties?.wo as Record<string, any>;
    const op = result.properties?.op as Record<string, any>;

    expect(ro.properties?.id?.type).toBe("string");
    expect(ro.asCell).toEqual(["readonly"]);

    expect(wo.properties?.count?.type).toBe("number");
    expect(wo.asCell).toEqual(["writeonly"]);

    expect(op.properties?.enabled?.type).toBe("boolean");
    expect(op.asCell).toEqual(["opaque"]);
    expect(op).not.toHaveProperty("asOpaque");
  });

  it("Writable<unknown> produces { type: 'unknown', asCell: ['cell'] }", async () => {
    const code = `
      interface X {
        value: Writable<unknown>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const value = result.properties?.value as Record<string, any>;
    expect(value).toEqual({ type: "unknown", asCell: ["cell"] });
  });

  it("Reactive<T> erases to T without wrapper metadata", async () => {
    const code = `
      interface X {
        value: Reactive<{ foo: string }>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const value = result.properties?.value as Record<string, any>;

    expect(value.properties?.foo?.type).toBe("string");
    expect(value).not.toHaveProperty("asCell");
    expect(value).not.toHaveProperty("asOpaque");
  });

  it("Array<Writable<unknown>> produces { type: 'array', items: { type: 'unknown', asCell: ['cell'] } }", async () => {
    const code = `
      interface X {
        items: Array<Writable<unknown>>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const items = result.properties?.items as Record<string, any>;
    expect(items.type).toBe("array");
    expect(items.items).toEqual({ type: "unknown", asCell: ["cell"] });
  });

  it("array item hints preserve the outer cell wrapper without marking plain items as cells", async () => {
    const code = `
      interface X {
        items: Writable<{ name: string }[]>;
      }
    `;
    const { checker, sourceFile } = await createTestProgram(code);
    const symbol = checker.getSymbolsInScope(
      sourceFile,
      ts.SymbolFlags.Interface,
    ).find((candidate) => candidate.name === "X");
    if (!symbol) throw new Error("Interface X not found");

    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const itemsTypeNode = findInterfaceMemberTypeNode(
      sourceFile,
      "X",
      "items",
    );
    const schemaHints = new WeakMap<ts.Node, { items?: unknown }>();
    schemaHints.set(itemsTypeNode, { items: false });

    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(
      gen.generateSchema(type, checker, undefined, undefined, schemaHints),
    );
    const items = result.properties?.items as Record<string, any>;

    expect(items).toEqual({
      type: "array",
      items: { type: "unknown" },
      asCell: ["cell"],
    });
  });

  it("array item hints preserve item-level cell wrappers when the element is a cell", async () => {
    const code = `
      interface X {
        items: Writable<Array<Cell<{ name: string }>>>;
      }
    `;
    const { checker, sourceFile } = await createTestProgram(code);
    const symbol = checker.getSymbolsInScope(
      sourceFile,
      ts.SymbolFlags.Interface,
    ).find((candidate) => candidate.name === "X");
    if (!symbol) throw new Error("Interface X not found");

    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const itemsTypeNode = findInterfaceMemberTypeNode(
      sourceFile,
      "X",
      "items",
    );
    const schemaHints = new WeakMap<ts.Node, { items?: unknown }>();
    schemaHints.set(itemsTypeNode, { items: false });

    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(
      gen.generateSchema(type, checker, undefined, undefined, schemaHints),
    );
    const items = result.properties?.items as Record<string, any>;

    expect(items).toEqual({
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
      asCell: ["cell"],
    });
  });

  it("uses semantic wrapper kind when a non-synthetic type node disagrees", async () => {
    const code = `
      interface X {
        authored: Cell<string>;
        narrowed: ReadonlyCell<string>;
      }
    `;
    const { checker, sourceFile } = await createTestProgram(code);
    const symbol = checker.getSymbolsInScope(
      sourceFile,
      ts.SymbolFlags.Interface,
    ).find((candidate) => candidate.name === "X");
    if (!symbol) throw new Error("Interface X not found");

    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const narrowed = type.getProperty("narrowed");
    if (!narrowed) throw new Error("Property X.narrowed not found");
    const narrowedType = checker.getTypeOfSymbolAtLocation(
      narrowed,
      sourceFile,
    );
    const authoredNode = findInterfaceMemberTypeNode(
      sourceFile,
      "X",
      "authored",
    );

    const gen = createSchemaTransformerV2();
    const result = gen.generateSchema(
      narrowedType,
      checker,
      authoredNode,
    ) as Record<string, any>;

    expect(result).toEqual({ type: "string", asCell: ["readonly"] });
  });

  it("allows registered synthetic wrapper nodes to override semantic wrapper kind", async () => {
    const code = `
      interface X {
        authored: Cell<string>;
      }
    `;
    const { checker, sourceFile } = await createTestProgram(code);
    const symbol = checker.getSymbolsInScope(
      sourceFile,
      ts.SymbolFlags.Interface,
    ).find((candidate) => candidate.name === "X");
    if (!symbol) throw new Error("Interface X not found");

    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const authored = type.getProperty("authored");
    if (!authored) throw new Error("Property X.authored not found");
    const authoredType = checker.getTypeOfSymbolAtLocation(
      authored,
      sourceFile,
    );
    const syntheticNode = ts.factory.createTypeReferenceNode(
      ts.factory.createQualifiedName(
        ts.factory.createIdentifier("__cfHelpers"),
        ts.factory.createIdentifier("WriteonlyCell"),
      ),
      [ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)],
    );
    const typeRegistry = new WeakMap<ts.Node, ts.Type>();
    typeRegistry.set(syntheticNode, authoredType);

    const gen = createSchemaTransformerV2();
    const result = gen.generateSchemaFromSyntheticTypeNode(
      syntheticNode,
      checker,
      typeRegistry,
    ) as Record<string, any>;

    expect(result).toEqual({ type: "string", asCell: ["writeonly"] });
  });
});
