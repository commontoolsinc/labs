import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { createTestProgram } from "../utils.ts";

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

    const { program, checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      stmt.kind === 264 && // InterfaceDeclaration
      (stmt as any).name.text === "SchemaRoot"
    ) as any;

    const circularProperty = rootInterface.members[0];
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

    const { program, checker, sourceFile } = await createTestProgram(code);

    const rootInterface = sourceFile.statements.find((stmt) =>
      stmt.kind === 264 && // InterfaceDeclaration
      (stmt as any).name.text === "SchemaRoot"
    ) as any;

    const circularProperty = rootInterface.members[0];
    const type = checker.getTypeFromTypeNode(circularProperty.type);

    const generator = new SchemaGenerator();

    expect(() => {
      generator.generateSchema(type, checker, circularProperty.type);
    }).toThrow("Circular type alias detected: A -> B -> C -> A");
  });
});
