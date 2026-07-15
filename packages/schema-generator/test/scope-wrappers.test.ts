import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram, getTypeFromCode } from "./utils.ts";

describe("Scope wrappers", () => {
  it("prefers an exact semantic generic inner type over a matching synthetic wrapper", async () => {
    const code = `
type Box<T> = { value: T };
interface Root { captured: PerSession<Cell<Box<string>>> }
`;
    const { type: rootType, checker } = await getTypeFromCode(code, "Root");
    const captured = rootType.getProperty("captured");
    if (!captured?.valueDeclaration) {
      throw new Error("Expected Root.captured property declaration");
    }
    const type = checker.getTypeOfSymbolAtLocation(
      captured,
      captured.valueDeclaration,
    );
    const syntheticTypeNode = ts.factory.createTypeReferenceNode(
      "PerSession",
      [
        ts.factory.createTypeReferenceNode("Cell", [
          ts.factory.createTypeReferenceNode("Box", [
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ]),
        ]),
      ],
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      syntheticTypeNode,
    );

    expect(schema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      asCell: [{ kind: "cell", scope: "session" }],
    });
  });

  it("preserves a more precise matching scope-wrapper node", async () => {
    const { checker, sourceFile } = await createTestProgram(`
interface Person { name: string }
interface Root {
  semantic: PerSpace<Cell<unknown[]>>;
  emitted: PerSpace<Cell<Person[]>>;
}
`);
    let semanticType: ts.Type | undefined;
    let emittedNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== "Root") {
        return;
      }
      const rootType = checker.getTypeAtLocation(node.name);
      const semantic = rootType.getProperty("semantic");
      const emitted = rootType.getProperty("emitted");
      if (semantic?.valueDeclaration) {
        semanticType = checker.getTypeOfSymbolAtLocation(
          semantic,
          semantic.valueDeclaration,
        );
      }
      if (
        emitted?.valueDeclaration &&
        ts.isPropertySignature(emitted.valueDeclaration)
      ) {
        emittedNode = emitted.valueDeclaration.type;
      }
    });
    if (!semanticType || !emittedNode) {
      throw new Error("Expected semantic type and emitted type node");
    }

    const schema = new SchemaGenerator().generateSchema(
      semanticType,
      checker,
      emittedNode,
      undefined,
      undefined,
      sourceFile,
    );

    expect(schema).toEqual({
      type: "array",
      items: { $ref: "#/$defs/Person" },
      asCell: [{ kind: "cell", scope: "space" }],
      $defs: {
        Person: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    });
  });

  it("retains registered synthetic Default syntax inside a scoped cell", async () => {
    const { checker, sourceFile } = await createTestProgram(`
interface Default<T, V extends T = T> {}
interface ParkingSpot { spotNumber: string }
interface Root {
  captured: PerSpace<Cell<ParkingSpot[] | Default<[{ spotNumber: "1" }]>>>;
}
`);
    const rootDeclaration = sourceFile.statements.find((statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "Root"
    );
    if (!rootDeclaration || !ts.isInterfaceDeclaration(rootDeclaration)) {
      throw new Error("Expected Root declaration");
    }
    const property = rootDeclaration.members[0];
    if (!property || !ts.isPropertySignature(property) || !property.type) {
      throw new Error("Expected Root.captured type");
    }
    const authoredOuter = property.type;
    if (!ts.isTypeReferenceNode(authoredOuter)) {
      throw new Error("Expected authored PerSpace reference");
    }
    const authoredCell = authoredOuter.typeArguments?.[0];
    if (!authoredCell || !ts.isTypeReferenceNode(authoredCell)) {
      throw new Error("Expected authored Cell reference");
    }
    const authoredUnion = authoredCell.typeArguments?.[0];
    if (!authoredUnion || !ts.isUnionTypeNode(authoredUnion)) {
      throw new Error("Expected authored cell union");
    }

    const spotNode = ts.factory.createTypeReferenceNode("ParkingSpot");
    const arrayNode = ts.factory.createArrayTypeNode(spotNode);
    const defaultValueNode = ts.factory.createTupleTypeNode([
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          "spotNumber",
          undefined,
          ts.factory.createLiteralTypeNode(
            ts.factory.createStringLiteral("1"),
          ),
        ),
      ]),
    ]);
    const defaultNode = ts.factory.createTypeReferenceNode("Default", [
      defaultValueNode,
    ]);
    const unionNode = ts.factory.createUnionTypeNode([arrayNode, defaultNode]);
    const cellNode = ts.factory.createTypeReferenceNode("Cell", [unionNode]);
    const outerNode = ts.factory.createTypeReferenceNode("PerSpace", [
      cellNode,
    ]);
    const authoredArray = authoredUnion.types[0]!;
    const authoredDefault = authoredUnion.types[1]!;
    const typeRegistry = new WeakMap<ts.Node, ts.Type>([
      [outerNode, checker.getTypeFromTypeNode(authoredOuter)],
      [cellNode, checker.getTypeFromTypeNode(authoredCell)],
      [unionNode, checker.getTypeFromTypeNode(authoredUnion)],
      [arrayNode, checker.getTypeFromTypeNode(authoredArray)],
      [defaultNode, checker.getTypeFromTypeNode(authoredDefault)],
    ]);

    const schema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredOuter),
      checker,
      outerNode,
      undefined,
      undefined,
      sourceFile,
      typeRegistry,
    );

    expect(schema).toEqual({
      type: "array",
      items: { $ref: "#/$defs/ParkingSpot" },
      default: [{ spotNumber: "1" }],
      asCell: [{ kind: "cell", scope: "space" }],
      $defs: {
        ParkingSpot: {
          type: "object",
          properties: { spotNumber: { type: "string" } },
          required: ["spotNumber"],
        },
      },
    });
  });

  it("rejects nested scope wrappers without a cell boundary", async () => {
    const code = `
interface SchemaRoot {
  invalid: PerUser<PerSession<string>>;
}
`;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("Nested scope wrappers require a cell boundary between scopes.");
  });
});
