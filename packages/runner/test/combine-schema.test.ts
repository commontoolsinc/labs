import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { combineSchema } from "../src/traverse.ts";
import type { JSONSchema } from "../src/builder/types.ts";

describe("combineSchema false handling", () => {
  const falseSchemas = [
    { name: "boolean false", schema: false },
    { name: "object false schema", schema: { not: true } },
  ] as const satisfies readonly { name: string; schema: JSONSchema }[];
  const constrainedSchema = { type: "number" } as const satisfies JSONSchema;
  const directions = [
    {
      name: "false schema is the parent",
      combine: (falseSchema: JSONSchema) =>
        combineSchema(falseSchema, constrainedSchema),
    },
    {
      name: "false schema is the link",
      combine: (falseSchema: JSONSchema) =>
        combineSchema(constrainedSchema, falseSchema),
    },
  ] as const;

  for (const testCase of falseSchemas) {
    for (const direction of directions) {
      it(`${testCase.name} absorbs the other schema when the ${direction.name}`, () => {
        expect(direction.combine(testCase.schema)).toEqual(testCase.schema);
      });
    }
  }
});

// combineSchema builds the pseudo-intersection of the schema a doc was
// entered with and a schema found on a link inside it. For object schemas,
// keys defined on only ONE side intersect against the other side's
// additionalProperties — where JSON Schema's "absent additionalProperties"
// means UNCONSTRAINED, not `false`. The regression pinned here: absent
// additionalProperties alongside defined properties used to be coerced to
// `false`, silently blocking the other side's keys exactly as if the
// author had written an explicitly closed object.

describe("combineSchema additionalProperties handling", () => {
  const schemaWithOneSidedProperty = {
    type: "object",
    properties: {
      shared: { type: "string" },
      oneSided: { type: "number", asCell: ["cell"] },
    },
  } as const satisfies JSONSchema;

  const additionalPropertiesCases: readonly {
    name: string;
    additionalProperties: JSONSchema | undefined;
    expectedOneSidedProperty: JSONSchema;
  }[] = [
    {
      name: "absent additionalProperties is unconstrained",
      additionalProperties: undefined,
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
    {
      name: "additionalProperties true is unconstrained",
      additionalProperties: true,
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
    {
      name: "additionalProperties false blocks the key",
      additionalProperties: false,
      expectedOneSidedProperty: false,
    },
    {
      name: "an additionalProperties schema intersects with the key",
      additionalProperties: { type: "number" },
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
  ];

  const directions = [
    {
      name: "schema with the one-sided key is the parent",
      combine: (otherSchema: JSONSchema) =>
        combineSchema(schemaWithOneSidedProperty, otherSchema),
    },
    {
      name: "schema with the one-sided key is the link",
      combine: (otherSchema: JSONSchema) =>
        combineSchema(otherSchema, schemaWithOneSidedProperty),
    },
  ] as const;

  for (const testCase of additionalPropertiesCases) {
    for (const direction of directions) {
      it(`${testCase.name} when the ${direction.name}`, () => {
        const otherSchema = {
          type: "object",
          properties: { shared: { type: "string" } },
          ...(testCase.additionalProperties !== undefined && {
            additionalProperties: testCase.additionalProperties,
          }),
        } satisfies JSONSchema;

        const merged = direction.combine(otherSchema) as {
          properties: Record<string, unknown>;
        };

        expect(merged.properties.shared).toEqual({ type: "string" });
        expect(merged.properties.oneSided).toEqual(
          testCase.expectedOneSidedProperty,
        );
      });
    }
  }

  for (const direction of directions) {
    it(`a property-less side stays permissive when the ${direction.name}`, () => {
      const anything = { type: "object" } as const satisfies JSONSchema;
      const merged = direction.combine(anything) as {
        properties: Record<string, unknown>;
      };

      expect(merged.properties).toEqual(
        schemaWithOneSidedProperty.properties,
      );
    });
  }
});
