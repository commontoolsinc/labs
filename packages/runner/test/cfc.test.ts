import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import { cfcAtom, ContextualFlowControl } from "../src/cfc.ts";
import { schemaHasIfc } from "../src/schema.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { JSONSchemaObj } from "@commonfabric/api";
import {
  findCfcSchemaRefs,
  pruneCfcSchemaDefinitions,
  resolveCfcSchemaRef,
  selectReferencedCfcSchemaDefs,
} from "../src/cfc/schema-refs.ts";

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

  it("does not treat inherited property names as declared properties", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "object",
      properties: {
        actual: { type: "number" },
      },
    };

    expect(cfc.schemaAtPath(schema, ["toString"])).toBe(true);
    expect(cfc.schemaAtPath({
      type: "object",
      properties: Object.fromEntries([
        ["toString", { type: "string" }],
      ]) as Record<string, JSONSchema>,
    }, ["toString"])).toEqual({ type: "string" });
  });

  it("classifies frozen root refs and unions without mixing path results", () => {
    const cfc = new ContextualFlowControl();
    const schema = deepFreeze({
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          anyOf: [
            {
              type: "array",
              prefixItems: [{ type: "number" }],
              items: { type: "string" },
            },
            {
              type: "object",
              properties: {
                "0": { type: "boolean" },
                named: { type: "null" },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    } as JSONSchemaObj);

    expect(cfc.schemaAtPath(schema, ["0"])).toEqual({
      anyOf: [{ type: "number" }, { type: "boolean" }],
    });
    const homogeneous = cfc.schemaAtPath(schema, ["1"]);
    expect(homogeneous).toEqual({ type: "string" });
    expect(cfc.schemaAtPath(schema, ["1"])).toBe(homogeneous);
    expect(cfc.schemaAtPath(schema, ["2000"])).toBe(homogeneous);
    expect(cfc.schemaAtPath(schema, ["named"])).toEqual({ type: "null" });
    expect(cfc.schemaAtPath(schema, ["missing"])).toBe(false);
  });

  it("classifies combined unions with boolean branches", () => {
    const cfc = new ContextualFlowControl();
    const schema = deepFreeze({
      anyOf: [{
        type: "array",
        items: { type: "string" },
      }],
      oneOf: [true],
    } as JSONSchemaObj);

    expect(cfc.schemaAtPath(schema, ["0"])).toBe(true);
  });

  it("falls back when composition branches contain an indirect ref cycle", () => {
    const cfc = new ContextualFlowControl();
    const schema = deepFreeze({
      $ref: "#/$defs/A",
      $defs: {
        A: {
          anyOf: [true, { $ref: "#/$defs/B" }],
        },
        B: {
          oneOf: [{ $ref: "#/$defs/A" }],
        },
      },
    } as JSONSchemaObj);

    expect(cfc.schemaAtPath(schema, ["value"])).toBe(true);
  });

  it("falls back when a union classifier cannot resolve a ref", () => {
    const cfc = new ContextualFlowControl();
    const schema = deepFreeze({
      anyOf: [{ $ref: "#/$defs/Missing" }],
      $defs: { Present: { type: "string" } },
    } as JSONSchemaObj);

    expect(() => cfc.schemaAtPath(schema, ["value"]))
      .toThrow(/Failed to resolve \$ref/);
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

describe("CFC schema reference discovery", () => {
  it("visits every supported subschema keyword but not dormant definitions", () => {
    const ref = (name: string): JSONSchema => ({ $ref: `urn:${name}` });
    const names = [
      "not",
      "if",
      "then",
      "else",
      "items",
      "contains",
      "additionalProperties",
      "propertyNames",
      "contentSchema",
      "allOf",
      "anyOf",
      "oneOf",
      "prefixItems",
      "dependentSchemas",
      "properties",
      "patternProperties",
    ];
    const schema: JSONSchema = {
      not: ref("not"),
      if: ref("if"),
      then: ref("then"),
      else: ref("else"),
      items: ref("items"),
      contains: ref("contains"),
      additionalProperties: ref("additionalProperties"),
      propertyNames: ref("propertyNames"),
      contentSchema: ref("contentSchema"),
      allOf: [ref("allOf")],
      anyOf: [ref("anyOf")],
      oneOf: [ref("oneOf")],
      prefixItems: [ref("prefixItems")],
      dependentSchemas: { value: ref("dependentSchemas") },
      properties: { value: ref("properties") },
      patternProperties: { ".*": ref("patternProperties") },
      $defs: { Dormant: ref("dormant") },
    };
    const refs = new Set<string>();

    findCfcSchemaRefs(schema, refs);

    expect([...refs].toSorted()).toEqual(
      names.map((name) => `urn:${name}`).toSorted(),
    );
  });

  it("selects no definitions for boolean schemas or unresolved local refs", () => {
    const definitions = { Present: { type: "string" } } as const;

    expect(selectReferencedCfcSchemaDefs(true, definitions)).toBeUndefined();
    expect(
      selectReferencedCfcSchemaDefs(
        { $ref: "#/$defs/Missing" },
        definitions,
      ),
    ).toBeUndefined();
  });

  it("does not resolve inherited Object prototype names as definitions", () => {
    const fullSchema: JSONSchema = {
      $defs: { Present: { type: "string" } },
    };

    for (const name of ["toString", "constructor", "__proto__"]) {
      const ref = `#/$defs/${name}`;
      expect(
        selectReferencedCfcSchemaDefs({ $ref: ref }, fullSchema.$defs),
      ).toBeUndefined();
      expect(resolveCfcSchemaRef(fullSchema, ref)).toBeUndefined();
    }
  });

  it("retains own definitions that shadow Object prototype names", () => {
    const definitions = Object.fromEntries([
      ["toString", { type: "string" }],
      ["constructor", { type: "number" }],
    ]) as Record<string, JSONSchema>;
    const schema: JSONSchema = {
      anyOf: Object.keys(definitions).map((name) => ({
        $ref: `#/$defs/${name}`,
      })),
      $defs: definitions,
    };

    expect(selectReferencedCfcSchemaDefs(schema)).toEqual(definitions);
    for (const [name, definition] of Object.entries(definitions)) {
      expect(resolveCfcSchemaRef(schema, `#/$defs/${name}`)).toEqual(
        definition,
      );
    }
  });

  it("preserves nested definition scope boundaries while pruning", () => {
    const cfc = new ContextualFlowControl();
    const schema: JSONSchema = {
      type: "object",
      properties: {
        other: { $ref: "#/$defs/Outer" },
        child: {
          $ref: "#/$defs/Outer",
          $defs: { Unused: { type: "boolean" } },
        },
      },
      $defs: { Outer: { type: "string" } },
    };

    const pruned = pruneCfcSchemaDefinitions(schema);

    expect(pruned).toEqual({
      type: "object",
      properties: {
        other: { $ref: "#/$defs/Outer" },
        child: { $ref: "#/$defs/Outer", $defs: {} },
      },
      $defs: { Outer: { type: "string" } },
    });
    expect(cfc.schemaAtPath(pruned, ["child"])).toEqual(
      cfc.schemaAtPath(schema, ["child"]),
    );
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

  it("rejects anchor $refs", () => {
    const schema: JSONSchemaObj = {
      $ref: "#named-anchor",
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
