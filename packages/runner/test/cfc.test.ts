import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom, ContextualFlowControl } from "../src/cfc.ts";
import { schemaHasIfc } from "../src/schema.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { JSONSchemaObj } from "@commonfabric/api";

describe("ContextualFlowControl.schemaAtPath", () => {
  it("rejects leading-zero array index like '01'", () => {
    const cfc = new ContextualFlowControl();

    const schema: JSONSchema = {
      type: "array",
      items: { type: "string" },
    };

    // "01" is not a valid array index (leading zero), should return false
    const result01 = cfc.schemaAtPath(schema, ["01"]);
    // "1" is a valid array index, should return the items schema
    const result1 = cfc.schemaAtPath(schema, ["1"]);

    expect(result01).toBe(false);
    expect(result1).toEqual({ type: "string" });
  });

  it("does not collide cached paths whose segments contain NUL bytes", () => {
    const cfc = new ContextualFlowControl();

    // Deep-frozen so the schemaAtPath memo engages; "a\0b" as a single
    // property name must not share a cache entry with the nested path
    // ["a", "b"].
    const schema: JSONSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({
        "a\0b": Object.freeze({ type: "number" }),
        a: Object.freeze({
          type: "object",
          properties: Object.freeze({
            b: Object.freeze({ type: "string" }),
          }),
        }),
      }),
    }) as JSONSchema;

    const flat = cfc.schemaAtPath(schema, ["a\0b"]);
    const nested = cfc.schemaAtPath(schema, ["a", "b"]);

    expect(flat).toEqual({ type: "number" });
    expect(nested).toEqual({ type: "string" });
  });

  it("considers a schema with only $defs true'", () => {
    const schema: JSONSchema = {
      $defs: { Test: { type: "array", items: { type: "string" } } },
    };
    expect(ContextualFlowControl.isTrueSchema(schema)).toBe(true);
  });

  it("considers a schema with only scope metadata true", () => {
    expect(ContextualFlowControl.isTrueSchema({ scope: "any" })).toBe(true);
  });

  it("uses nested property $defs while traversing through array item refs", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "object",
      properties: {
        argument: {
          type: "object",
          $defs: {
            Item: {
              type: "object",
              properties: {
                values: {
                  type: "array",
                  items: { type: "number" },
                },
              },
            },
          },
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/$defs/Item" },
            },
          },
        },
      },
    };

    expect(cfc.schemaAtPath(schema, ["argument", "items", "0", "values"]))
      .toEqual({
        type: "array",
        items: { type: "number" },
      });
  });

  it("drops definitions that the derived schema cannot reach", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      $defs: {
        Unused: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    };

    expect(cfc.schemaAtPath(schema, ["title"])).toEqual({
      type: "string",
    });
  });

  it("keeps the transitive definition closure for a derived schema", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Entry" },
      $defs: {
        Entry: {
          type: "object",
          properties: {
            label: { $ref: "#/$defs/Label" },
          },
        },
        Label: { type: "string" },
        Unused: { type: "number" },
      },
    };

    expect(cfc.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Entry",
      $defs: {
        Entry: {
          type: "object",
          properties: {
            label: { $ref: "#/$defs/Label" },
          },
        },
        Label: { type: "string" },
      },
    });
  });

  it("does not enumerate or read unreachable definitions", () => {
    const cfc = new ContextualFlowControl();
    const definitions = new Proxy<Record<string, JSONSchema>>(
      {
        Used: { type: "string" },
        Unused: { type: "number" },
      },
      {
        ownKeys: () => {
          throw new Error("definition map was enumerated");
        },
        get: (target, property, receiver) => {
          if (property === "Unused") {
            throw new Error("unreachable definition was read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Used" },
      $defs: definitions,
    };

    expect(cfc.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Used",
      $defs: { Used: { type: "string" } },
    });
  });

  it("keeps refs resolved from a reached definition body", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Entry" },
      $defs: {
        Entry: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Shared" },
          },
          $defs: {
            Shared: { type: "number" },
          },
        },
        Shared: { type: "string" },
        Unused: { type: "boolean" },
      },
    };

    expect(cfc.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Entry",
      $defs: {
        Entry: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Shared" },
          },
          $defs: {
            Shared: { type: "number" },
          },
        },
        Shared: { type: "string" },
      },
    });
  });

  it("keeps cyclic and JSON-pointer-escaped definition references", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/a~1b~0c" },
      $defs: {
        "a/b~c": { $ref: "#/$defs/Back" },
        Back: { $ref: "#/$defs/a~1b~0c" },
        Unused: { type: "boolean" },
      },
    };

    expect(cfc.schemaAtPath(schema, ["17"])).toEqual({
      $ref: "#/$defs/a~1b~0c",
      $defs: {
        "a/b~c": { $ref: "#/$defs/Back" },
        Back: { $ref: "#/$defs/a~1b~0c" },
      },
    });
  });

  it("does not mix nested and inherited definition scopes", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Inner",
          $defs: {
            Inner: { type: "string" },
            NestedUnused: { type: "null" },
          },
        },
      },
      $defs: {
        Inner: { type: "number" },
        OuterUnused: { type: "boolean" },
      },
    };

    expect(cfc.schemaAtPath(schema, ["nested"])).toEqual({
      $ref: "#/$defs/Inner",
      $defs: {
        Inner: { type: "string" },
      },
    });
  });
});

describe("ContextualFlowControl atom joins", () => {
  it("preserves arbitrary confidentiality atoms instead of collapsing through fixed lattice levels", () => {
    const cfc = new ContextualFlowControl();
    const caveatAtom = cfcAtom.caveat("prompt-influence", "of:prompt-source");
    const provenanceAtom = cfcAtom.resource(
      "SourceProvenance",
      "did:example:source",
    );
    const schema: JSONSchema = {
      type: "object",
      ifc: { confidentiality: [caveatAtom] },
      properties: {
        body: {
          type: "string",
          ifc: { confidentiality: [provenanceAtom] },
        },
      },
    };

    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, schema);

    expect(cfc.lub(joined)).toEqual([caveatAtom, provenanceAtom]);
    expect(cfc.schemaAtPath(schema, ["body"])).toMatchObject({
      type: "string",
      ifc: {
        confidentiality: [caveatAtom, provenanceAtom],
      },
    });
  });
});

describe("schemaHasIfc", () => {
  it("resolves nested $defs while scanning child schemas", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Nested",
          $defs: {
            Nested: {
              type: "object",
              properties: {
                value: {
                  $ref: "#/$defs/SecretValue",
                },
              },
            },
            SecretValue: {
              type: "string",
              ifc: {
                confidentiality: [cfcAtom.resource("NestedSecret")],
              },
            },
          },
        },
      },
    };

    expect(schemaHasIfc(schema)).toBe(true);
  });
});

describe("ContextualFlowControl.isFalseSchema", () => {
  it("treats false as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema(false)).toBe(true);
  });

  it("does not treat true as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema(true)).toBe(false);
  });

  it("does not treat a normal object schema as false", () => {
    expect(ContextualFlowControl.isFalseSchema({ type: "string" })).toBe(false);
  });

  it("treats {not: true} as a false schema (negation of true matches nothing)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: true })).toBe(true);
  });

  it("treats {not: {}} as a false schema ({} is a true schema, so its negation is false)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: {} })).toBe(true);
  });

  it("does not treat {not: false} as a false schema (negation of false matches everything)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: false })).toBe(false);
  });

  it("does not treat {not: {type: 'string'}} as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: { type: "string" } }))
      .toBe(false);
  });
});

describe("ContextualFlowControl.resolveSchemaRefsOrThrow", () => {
  it("resolves a local $ref successfully", () => {
    const schema: JSONSchemaObj = {
      $defs: { Foo: { type: "string" } as JSONSchema },
      $ref: "#/$defs/Foo",
    };
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toMatchObject({ type: "string" });
  });

  it("resolves embedded external $ref (vnode.json)", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    };
    // Should not throw — vnode.json is registered in embeddedSchemas
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toBeDefined();
  });

  it("throws with actionable message for unknown external $ref", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/unknown.json",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/embeddedSchemas/);
  });

  it("throws with schema details for unresolvable local $ref", () => {
    const schema: JSONSchemaObj = {
      $defs: {},
      $ref: "#/$defs/Missing",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("rejects local $refs outside root $defs", () => {
    const schema: JSONSchemaObj = {
      properties: {
        name: { type: "string" },
      },
      $ref: "#/properties/name",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("rejects local $refs into nested paths under root $defs", () => {
    const schema: JSONSchemaObj = {
      $defs: {
        Foo: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      $ref: "#/$defs/Foo/properties/name",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });
});
