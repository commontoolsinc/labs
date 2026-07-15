import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { combineSchema } from "../src/traverse.ts";
import type { JSONSchema } from "../src/builder/types.ts";

describe("combineSchema type handling", () => {
  const disjointCases: readonly {
    name: string;
    a: JSONSchema;
    b: JSONSchema;
  }[] = [
    {
      name: "disjoint primitive types",
      a: { type: "string" },
      b: { type: "number" },
    },
    {
      name: "a type union with no shared member is false",
      a: { type: ["string", "number"] },
      b: { type: "boolean" },
    },
    {
      name: "disjoint structural types",
      a: { type: "object" },
      b: { type: "array" },
    },
    {
      name: "undefined and object are disjoint",
      a: { type: "undefined" },
      b: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
    {
      name: "integer and string are disjoint",
      a: { type: "integer" },
      b: { type: "string" },
    },
  ];
  const directions = [
    { name: "a is the parent", combine: combineSchema },
    {
      name: "b is the parent",
      combine: (a: JSONSchema, b: JSONSchema) => combineSchema(b, a),
    },
  ] as const;

  for (const testCase of disjointCases) {
    for (const direction of directions) {
      it(`${testCase.name} when ${direction.name}`, () => {
        expect(direction.combine(testCase.a, testCase.b)).toBe(false);
      });
    }
  }

  const compatibleCases: readonly {
    name: string;
    a: JSONSchema;
    b: JSONSchema;
  }[] = [
    {
      name: "a type union can overlap one member",
      a: { type: ["string", "number"] },
      b: { type: "number" },
    },
    {
      name: "unknown can overlap another type",
      a: { type: "unknown" },
      b: { type: "string" },
    },
    {
      name: "a union containing unknown can overlap another type",
      a: { type: ["unknown", "string"] },
      b: { type: "boolean" },
    },
  ];

  for (const testCase of compatibleCases) {
    it(`${testCase.name} while retaining parent precedence`, () => {
      expect(combineSchema(testCase.a, testCase.b)).toEqual(testCase.a);
      expect(combineSchema(testCase.b, testCase.a)).toEqual(testCase.b);
    });
  }

  const numberIntegerCases = [
    {
      name: "scalar number and integer",
      a: { type: "number" },
      b: { type: "integer" },
      expectedType: "integer",
    },
    {
      name: "type arrays with only a number/integer overlap",
      a: { type: ["string", "number"] },
      b: { type: ["boolean", "integer"] },
      expectedType: "integer",
    },
    {
      name: "type arrays with exact and number/integer overlaps",
      a: { type: ["string", "number"] },
      b: { type: ["integer", "string"] },
      expectedType: ["integer", "string"],
    },
  ] as const;

  for (const testCase of numberIntegerCases) {
    it(`${testCase.name} narrows number to integer in either direction`, () => {
      expect(combineSchema(testCase.a, testCase.b)).toEqual({
        type: testCase.expectedType,
      });
      expect(combineSchema(testCase.b, testCase.a)).toEqual({
        type: testCase.expectedType,
      });
    });
  }
});

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

describe("combineSchema required handling", () => {
  const cases = [
    {
      name: "disjoint required properties",
      parentRequired: ["parentOnly"],
      linkRequired: ["linkOnly"],
      expected: ["parentOnly", "linkOnly"],
      expectedReversed: ["linkOnly", "parentOnly"],
    },
    {
      name: "overlapping required properties",
      parentRequired: ["parentOnly", "shared"],
      linkRequired: ["shared", "linkOnly"],
      expected: ["parentOnly", "shared", "linkOnly"],
      expectedReversed: ["shared", "linkOnly", "parentOnly"],
    },
    {
      name: "required properties on only one side",
      parentRequired: ["parentOnly"],
      linkRequired: undefined,
      expected: ["parentOnly"],
      expectedReversed: ["parentOnly"],
    },
  ] as const;

  for (const testCase of cases) {
    for (const reverse of [false, true]) {
      const direction = reverse ? "link is the parent" : "parent stays first";
      it(`${testCase.name} when the ${direction}`, () => {
        const parent = {
          type: "object",
          properties: {
            shared: { type: "string" },
            parentOnly: { type: "string" },
          },
          ...(testCase.parentRequired !== undefined && {
            required: testCase.parentRequired,
          }),
        } as const satisfies JSONSchema;
        const link = {
          type: "object",
          properties: {
            shared: { type: "string" },
            linkOnly: { type: "string" },
          },
          ...(testCase.linkRequired !== undefined && {
            required: testCase.linkRequired,
          }),
        } as const satisfies JSONSchema;

        const merged = (reverse
          ? combineSchema(link, parent)
          : combineSchema(parent, link)) as { required?: readonly string[] };
        const expected = reverse
          ? testCase.expectedReversed
          : testCase.expected;
        expect(merged.required).toEqual(expected);
      });
    }
  }
});

describe("combineSchema array handling", () => {
  const a = {
    type: "array",
    title: "a title",
    description: "a description",
    minItems: 1,
    items: { type: "string" },
    $defs: {
      aOnly: { type: "string" },
      shared: { const: "a" },
    },
  } as const satisfies JSONSchema;
  const b = {
    type: "array",
    title: "b title",
    description: "b description",
    maxItems: 4,
    items: { type: "string" },
    $defs: {
      bOnly: { type: "number" },
      shared: { const: "b" },
    },
  } as const satisfies JSONSchema;

  const directions = [
    {
      name: "a is the parent",
      parent: a,
      link: b,
      parentTitle: "a title",
      parentDescription: "a description",
      parentSharedDef: { const: "a" },
    },
    {
      name: "b is the parent",
      parent: b,
      link: a,
      parentTitle: "b title",
      parentDescription: "b description",
      parentSharedDef: { const: "b" },
    },
  ] as const;

  for (const direction of directions) {
    it(`keeps parent metadata and merges definitions when ${direction.name}`, () => {
      const merged = combineSchema(direction.parent, direction.link);
      expect(merged).toMatchObject({
        type: "array",
        title: direction.parentTitle,
        description: direction.parentDescription,
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        $defs: {
          aOnly: { type: "string" },
          bOnly: { type: "number" },
          shared: direction.parentSharedDef,
        },
      });
    });
  }

  const withoutItems = {
    type: "array",
    title: "without items",
  } as const satisfies JSONSchema;
  const withItems = {
    type: "array",
    title: "with items",
    items: { type: "number" },
  } as const satisfies JSONSchema;

  for (
    const direction of [
      { parent: withoutItems, link: withItems },
      { parent: withItems, link: withoutItems },
    ] as const
  ) {
    it(`uses the available items schema while ${direction.parent.title} is the parent`, () => {
      expect(combineSchema(direction.parent, direction.link)).toMatchObject({
        title: direction.parent.title,
        items: { type: "number" },
      });
    });
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
