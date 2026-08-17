import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchemaObj } from "@commonfabric/api";
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

  it("throws for a scope wrapper that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper around a cell that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<Cell<string>> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper unioned with a value type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | null;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope inside a cell that is a union member", async () => {
    // `Cell<PerSession<T>>` puts the scope on the sibling key next to a string
    // `asCell` entry, so the branch carries `{asCell: ["cell"], scope: ...}`.
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: Cell<PerSession<string>> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("emits a scope beside a string asCell entry outside a union", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: Cell<PerSession<string>>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: "string",
      scope: "session",
      asCell: ["cell"],
    });
  });

  it("emits a top-level scope for an optional scoped property", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft?: PerUser<string>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: "string",
      scope: "user",
    });
  });

  it("emits a top-level scope when the union is inside the wrapper", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string | undefined>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: ["string", "undefined"],
      scope: "user",
    });
  });

  it("emits a scoped property nested in an object that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  holder: { draft: PerUser<string> } | undefined;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    const branches =
      ((schema as JSONSchemaObj).properties?.holder as JSONSchemaObj).anyOf as
        | JSONSchemaObj[]
        | undefined;
    // The scope sits at the top level of `draft`'s own schema, which is where
    // the write path reads it, so nesting under a union branch is fine.
    expect(
      branches?.some((branch) =>
        (branch.properties?.draft as JSONSchemaObj | undefined)?.scope ===
          "user"
      ),
    ).toBe(true);
  });
});
