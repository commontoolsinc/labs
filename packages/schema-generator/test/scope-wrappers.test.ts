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

  it("does not let incomplete inferred writer metadata shadow the destination schema", async () => {
    const { checker, sourceFile } = await createTestProgram(`
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
type RepresentsCurrentUser<T> = Cfc<T, {
  addIntegrity: readonly [{
    kind: "represents-principal";
    subject: { readonly __ctCurrentPrincipal: true };
  }];
}>;
type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };
type OwnerProtected<T, Binding> = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>
>;
type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<WriteAuthorizedBy<T, Binding>, {
  uiContract: {
    helper: "UiAction";
    action: Action;
    trustedPattern: Pattern;
    requiredEventIntegrity: Integrity;
  };
}>;
type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<T, Binding, Action, Pattern, [Pattern]>;
declare const writer: { readonly invoke: true };
declare const decoy: "unrelated";
interface Root {
  captured: Cell<OwnerProtected<string[], typeof writer>>;
  trusted: Cell<TrustedActionWrite<
    string[],
    typeof writer,
    "Save",
    "Surface"
  >>;
  nested: Cell<{
    protected: TrustedActionWrite<
      string[],
      typeof writer,
      "Save",
      "Surface"
    >;
    sibling: WriteAuthorizedBy<string, typeof writer>;
  }>;
  decoyType: typeof decoy;
}
`);
    const rootDeclaration = sourceFile.statements.find((statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "Root"
    );
    if (!rootDeclaration || !ts.isInterfaceDeclaration(rootDeclaration)) {
      throw new Error("Expected Root declaration");
    }
    const property = rootDeclaration.members.find((member) =>
      ts.isPropertySignature(member) && ts.isIdentifier(member.name) &&
      member.name.text === "captured"
    );
    if (!property || !ts.isPropertySignature(property) || !property.type) {
      throw new Error("Expected Root.captured type");
    }
    const authoredCell = property.type;
    if (!ts.isTypeReferenceNode(authoredCell)) {
      throw new Error("Expected authored Cell reference");
    }
    const authoredInner = authoredCell.typeArguments?.[0];
    if (!authoredInner || !ts.isTypeReferenceNode(authoredInner)) {
      throw new Error("Expected authored Cell inner type");
    }
    const authoredBinding = authoredInner.typeArguments?.[1];
    if (!authoredBinding || !ts.isTypeQueryNode(authoredBinding)) {
      throw new Error("Expected authored writer type query");
    }

    const syntheticInner = ts.factory.createTypeReferenceNode(
      "OwnerProtected",
      [
        ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            [ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword)],
            "invoke",
            undefined,
            ts.factory.createLiteralTypeNode(ts.factory.createTrue()),
          ),
        ]),
      ],
    );
    const syntheticCell = ts.factory.createTypeReferenceNode("Cell", [
      syntheticInner,
    ]);
    const typeRegistry = new WeakMap<ts.Node, ts.Type>([
      [syntheticCell, checker.getTypeFromTypeNode(authoredCell)],
      [syntheticInner, checker.getTypeFromTypeNode(authoredInner)],
    ]);

    const schema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredCell),
      checker,
      syntheticCell,
      undefined,
      undefined,
      sourceFile,
      typeRegistry,
    );

    expect(schema).toEqual({
      ifc: {
        ownerPrincipal: { __ctCurrentPrincipal: true },
        addIntegrity: [{
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        }],
      },
      asCell: ["cell"],
    });

    const decoyProperty = rootDeclaration.members.find((member) =>
      ts.isPropertySignature(member) && ts.isIdentifier(member.name) &&
      member.name.text === "decoyType"
    );
    if (
      !decoyProperty || !ts.isPropertySignature(decoyProperty) ||
      !decoyProperty.type || !ts.isTypeQueryNode(decoyProperty.type)
    ) {
      throw new Error("Expected authored decoy type query");
    }
    const decoyInner = ts.factory.createTypeReferenceNode(
      "OwnerProtected",
      [
        ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            [ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword)],
            "invoke",
            undefined,
            ts.factory.createLiteralTypeNode(ts.factory.createTrue()),
          ),
          ts.factory.createPropertySignature(
            undefined,
            "decoy",
            undefined,
            decoyProperty.type,
          ),
        ]),
      ],
    );
    const decoyCell = ts.factory.createTypeReferenceNode("Cell", [decoyInner]);
    const decoyRegistry = new WeakMap<ts.Node, ts.Type>([
      [decoyCell, checker.getTypeFromTypeNode(authoredCell)],
      [decoyInner, checker.getTypeFromTypeNode(authoredInner)],
    ]);

    const decoySchema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredCell),
      checker,
      decoyCell,
      undefined,
      undefined,
      sourceFile,
      decoyRegistry,
    );

    expect(decoySchema).toEqual(schema);

    const identityInner = ts.factory.createTypeReferenceNode(
      "OwnerProtected",
      [
        ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        authoredBinding,
      ],
    );
    const identityCell = ts.factory.createTypeReferenceNode("Cell", [
      identityInner,
    ]);
    const identityRegistry = new WeakMap<ts.Node, ts.Type>([
      [identityCell, checker.getTypeFromTypeNode(authoredCell)],
      [identityInner, checker.getTypeFromTypeNode(authoredInner)],
    ]);

    const identitySchema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredCell),
      checker,
      identityCell,
      undefined,
      undefined,
      sourceFile,
      identityRegistry,
    );

    expect(identitySchema).toEqual({
      type: "array",
      items: { type: "string" },
      ifc: {
        ownerPrincipal: { __ctCurrentPrincipal: true },
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "test.ts",
            path: ["writer"],
          },
        },
        addIntegrity: [{
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        }],
      },
      asCell: ["cell"],
    });

    const trustedProperty = rootDeclaration.members.find((member) =>
      ts.isPropertySignature(member) && ts.isIdentifier(member.name) &&
      member.name.text === "trusted"
    );
    if (
      !trustedProperty || !ts.isPropertySignature(trustedProperty) ||
      !trustedProperty.type || !ts.isTypeReferenceNode(trustedProperty.type)
    ) {
      throw new Error("Expected authored trusted action cell");
    }
    const authoredTrustedCell = trustedProperty.type;
    const authoredTrustedInner = authoredTrustedCell.typeArguments?.[0];
    if (!authoredTrustedInner) {
      throw new Error("Expected authored trusted action inner type");
    }
    const syntheticTrustedInner = ts.factory.createTypeReferenceNode(
      "TrustedActionWrite",
      [
        ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            [ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword)],
            "invoke",
            undefined,
            ts.factory.createLiteralTypeNode(ts.factory.createTrue()),
          ),
        ]),
        ts.factory.createLiteralTypeNode(
          ts.factory.createStringLiteral("Save"),
        ),
        ts.factory.createLiteralTypeNode(
          ts.factory.createStringLiteral("Surface"),
        ),
      ],
    );
    const syntheticTrustedCell = ts.factory.createTypeReferenceNode("Cell", [
      syntheticTrustedInner,
    ]);
    const trustedRegistry = new WeakMap<ts.Node, ts.Type>([
      [
        syntheticTrustedCell,
        checker.getTypeFromTypeNode(authoredTrustedCell),
      ],
      [
        syntheticTrustedInner,
        checker.getTypeFromTypeNode(authoredTrustedInner),
      ],
    ]);

    const trustedSchema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredTrustedCell),
      checker,
      syntheticTrustedCell,
      undefined,
      undefined,
      sourceFile,
      trustedRegistry,
    );

    expect(trustedSchema).toEqual({
      ifc: {
        uiContract: {
          helper: "UiAction",
          action: "Save",
          trustedPattern: "Surface",
          requiredEventIntegrity: ["Surface"],
        },
      },
      asCell: ["cell"],
    });

    const nestedProperty = rootDeclaration.members.find((member) =>
      ts.isPropertySignature(member) && ts.isIdentifier(member.name) &&
      member.name.text === "nested"
    );
    if (
      !nestedProperty || !ts.isPropertySignature(nestedProperty) ||
      !nestedProperty.type || !ts.isTypeReferenceNode(nestedProperty.type)
    ) {
      throw new Error("Expected authored nested writer cell");
    }
    const authoredNestedCell = nestedProperty.type;
    const authoredNestedInner = authoredNestedCell.typeArguments?.[0];
    if (!authoredNestedInner) {
      throw new Error("Expected authored nested writer inner type");
    }
    const helperTypeName = (name: string) =>
      ts.factory.createQualifiedName(
        ts.factory.createIdentifier("__cfHelpers"),
        ts.factory.createIdentifier(name),
      );
    const nestedProtected = ts.factory.createTypeReferenceNode(
      helperTypeName("TrustedActionWrite"),
      [
        ts.factory.createArrayTypeNode(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            [ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword)],
            "invoke",
            undefined,
            ts.factory.createLiteralTypeNode(ts.factory.createTrue()),
          ),
        ]),
        ts.factory.createLiteralTypeNode(
          ts.factory.createStringLiteral("Save"),
        ),
        ts.factory.createLiteralTypeNode(
          ts.factory.createStringLiteral("Surface"),
        ),
      ],
    );
    const nestedSibling = ts.factory.createTypeReferenceNode(
      helperTypeName("WriteAuthorizedBy"),
      [
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        authoredBinding,
      ],
    );
    const syntheticNestedInner = ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        "protected",
        undefined,
        nestedProtected,
      ),
      ts.factory.createPropertySignature(
        undefined,
        "sibling",
        undefined,
        nestedSibling,
      ),
    ]);
    const syntheticNestedCell = ts.factory.createTypeReferenceNode("Cell", [
      syntheticNestedInner,
    ]);
    const nestedRegistry = new WeakMap<ts.Node, ts.Type>([
      [syntheticNestedCell, checker.getTypeFromTypeNode(authoredNestedCell)],
      [syntheticNestedInner, checker.getTypeFromTypeNode(authoredNestedInner)],
    ]);

    const nestedSchema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(authoredNestedCell),
      checker,
      syntheticNestedCell,
      undefined,
      undefined,
      sourceFile,
      nestedRegistry,
    );

    expect(nestedSchema).toEqual({ asCell: ["cell"] });
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
