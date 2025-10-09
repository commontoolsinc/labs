import ts from "typescript";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { createTestProgram } from "../utils.ts";
import { assert } from "@std/assert";

describe("Circular alias error handling", () => {
  it("should throw descriptive error for circular Default aliases", async () => {
    const code = `
      type Default<T, V extends T = T> = T;
      type A<T, V> = B<T, V>;
      type B<T, V> = A<T, V>;
      interface SchemaRoot {
        circularAlias: A<string, "test">;
      }
    `;

    const { checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      ts.isInterfaceDeclaration(stmt) && stmt.name.text === "SchemaRoot"
    ) as ts.InterfaceDeclaration | undefined;
    assert(rootInterface, "Found SchemaRoot");

    const circularProperty = rootInterface.members[0];
    assert(circularProperty, "Found circular prop");
    assert(ts.isPropertySignature(circularProperty), "Is property signature.");
    assert(circularProperty.type, "Prop has type node.");
    const type = checker.getTypeFromTypeNode(circularProperty.type);

    const generator = new SchemaGenerator();

    expect(() => {
      generator.generateSchema(type, checker, circularProperty.type);
    }).toThrow("Circular type alias detected: A -> B -> A");
  });

  it("should handle longer circular chains", async () => {
    const code = `
      type Default<T, V extends T = T> = T;
      type A<T, V> = B<T, V>;
      type B<T, V> = C<T, V>;
      type C<T, V> = A<T, V>;
      interface SchemaRoot {
        circularAlias: A<string, "test">;
      }
    `;

    const { checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      ts.isInterfaceDeclaration(stmt) && stmt.name.text === "SchemaRoot"
    ) as ts.InterfaceDeclaration | undefined;
    assert(rootInterface, "Found SchemaRoot");

    const circularProperty = rootInterface.members[0];
    assert(circularProperty, "Found circular prop");
    assert(ts.isPropertySignature(circularProperty), "Is property signature.");
    assert(circularProperty.type, "Prop has type node.");
    const type = checker.getTypeFromTypeNode(circularProperty.type);

    const generator = new SchemaGenerator();

    expect(() => {
      generator.generateSchema(type, checker, circularProperty.type);
    }).toThrow("Circular type alias detected: A -> B -> C -> A");
  });
});
