import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

describe("Scope wrappers", () => {
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
