import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { assertPatternSchemasBackwardCompatible } from "../src/schema-compatibility.ts";

function pattern(
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Pattern {
  return {
    argumentSchema,
    resultSchema,
    derivedInternalCells: [],
    result: {},
    nodes: [],
  };
}

const oldPattern = pattern(
  {
    type: "object",
    properties: {
      value: { type: "number" },
      format: { type: "string" },
    },
    required: ["value"],
  },
  {
    type: "object",
    properties: {
      doubled: { type: "number" },
      status: { type: "string" },
    },
    required: ["doubled"],
  },
);

describe("piece schema compatibility", () => {
  it("accepts optional and defaulted fields plus wider argument unions", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }, { type: "string" }] },
          format: { type: "string" },
          label: { type: ["string", "undefined"] },
          retries: { type: "number", default: 0 },
          options: {
            type: "object",
            properties: { attempts: { type: "number", default: 1 } },
            required: ["attempts"],
          },
        },
        required: ["value", "retries", "options"],
      },
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: ["string", "undefined"] },
        },
        required: ["doubled"],
      },
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .not.toThrow();
  });

  it("accepts compatible changes through local schema references", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "number" } },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: {
          Value: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
  });

  it("checks changed definitions behind unchanged local references", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "number" } },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "string" } },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/argument\.value/);
  });

  it("resolves chained references and preserves reference siblings", () => {
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: 0 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { type: "number" },
        },
      },
      oldPattern.resultSchema,
    );
    const compatible = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: -10 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
      oldPattern.resultSchema,
    );
    const incompatible = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: 10 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { type: "number" },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, compatible))
      .not.toThrow();
    expect(() => assertPatternSchemasBackwardCompatible(previous, incompatible))
      .toThrow(/argument\.value/);
  });

  it("checks constraints alongside anyOf branches", () => {
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }], minimum: 0 },
        },
      },
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }], maximum: 10 },
        },
      },
    );
    const argumentNarrowed = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }], minimum: 10 },
        },
      },
      previous.resultSchema,
    );
    const resultWidened = pattern(
      previous.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }], maximum: 20 },
        },
      },
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, argumentNarrowed)
    ).toThrow(/argument\.value/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, resultWidened)
    ).toThrow(/result\.doubled/);
  });

  it("rejects an incompatible argument type change", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "string" },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(/argument\.value/);
  });

  it("rejects a new required argument without a default", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          retries: { type: "number" },
        },
        required: ["value", "retries"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(
        /argument\.retries: newly required argument field has no default/,
      );
  });

  it("rejects a required object whose defaults are incomplete", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          options: {
            type: "object",
            properties: {
              attempts: { type: "number", default: 1 },
              name: { type: "string" },
            },
            required: ["attempts", "name"],
          },
        },
        required: ["value", "options"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(
        /argument\.options: newly required argument field has no default/,
      );
  });

  it("rejects widening an existing result field", () => {
    const candidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }, { type: "string" }] },
          status: { type: "string" },
        },
        required: ["doubled"],
      },
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(/result\.doubled/);
  });

  it("rejects removing existing argument or result fields", () => {
    const missingArgument = pattern(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, missingArgument)
    ).toThrow(/argument\.format: existing argument field was removed/);

    const missingResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { doubled: { type: "number" } },
        required: ["doubled"],
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, missingResult)
    )
      .toThrow(/result\.status: existing result field was removed/);
  });

  it("handles boolean schemas conservatively", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(false, oldPattern.resultSchema),
        pattern({ type: "string" }, oldPattern.resultSchema),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(oldPattern.argumentSchema, oldPattern.resultSchema),
        pattern(true, oldPattern.resultSchema),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, oldPattern.resultSchema),
        pattern(false, oldPattern.resultSchema),
      )
    ).toThrow(/candidate schema rejects values accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, oldPattern.resultSchema),
        pattern({ type: "string" }, oldPattern.resultSchema),
      )
    ).toThrow(/unconstrained schema is no longer accepted/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "string" }, oldPattern.resultSchema),
        pattern(false, oldPattern.resultSchema),
      )
    ).toThrow(/candidate schema rejects values accepted previously/);
  });

  it("rejects unresolved references and terminates on recursive references", () => {
    const unresolved = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Missing" },
          format: { type: "string" },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, unresolved))
      .toThrow(/cannot resolve a local schema reference/);

    const previousRecursive = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            description: "previous",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      oldPattern.resultSchema,
    );
    const candidateRecursive = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            description: "candidate",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      oldPattern.resultSchema,
    );
    assertPatternSchemasBackwardCompatible(
      previousRecursive,
      candidateRecursive,
    );
  });

  it("checks enum and const restrictions", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a", "b"] } },
      },
      oldPattern.resultSchema,
    );
    const introducedEnum = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a"] } },
      },
      oldPattern.resultSchema,
    );
    const widenedEnum = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a", "b", "c"] } },
      },
      oldPattern.resultSchema,
    );
    const introducedConst = pattern(
      {
        type: "object",
        properties: { value: { const: "a" } },
      },
      oldPattern.resultSchema,
    );
    const unconstrained = pattern(
      {
        type: "object",
        properties: { value: { type: "string" } },
      },
      oldPattern.resultSchema,
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, introducedEnum)
    ).toThrow(/enum\/const no longer accepts every previous value/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widenedEnum))
      .not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(unconstrained, introducedConst)
    ).toThrow(/enum\/const became more restrictive/);
  });

  it("checks semantic extensions and unsupported complex constraints", () => {
    const semanticChange = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number", readOnly: true },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    const complexChange = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number", allOf: [{ minimum: 0 }] },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, semanticChange)
    ).toThrow(/readOnly changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, complexChange)
    ).toThrow(
      /allOf changed in a way compatibility checking cannot prove safe/,
    );
  });

  it("checks arrays and widened type arrays", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { type: "array", items: { type: "number" } } },
      },
      oldPattern.resultSchema,
    );
    const incompatible = pattern(
      {
        type: "object",
        properties: { value: { type: "array", items: { type: "string" } } },
      },
      oldPattern.resultSchema,
    );
    const widened = pattern(
      {
        type: "object",
        properties: {
          value: { type: ["array", "string"], items: { type: "number" } },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, incompatible))
      .toThrow(/argument\.value\[\]/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .not.toThrow();
  });

  it("preserves required result guarantees and defaults new required results", () => {
    const optionalized = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: oldPattern.resultSchema &&
            typeof oldPattern.resultSchema === "object"
          ? oldPattern.resultSchema.properties
          : {},
      },
    );
    const newRequiredWithoutDefault = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: "string" },
        },
        required: ["doubled", "summary"],
      },
    );
    const newRequiredWithDefault = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: "string", default: "ready" },
        },
        required: ["doubled", "summary"],
      },
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, optionalized)
    ).toThrow(/result\.doubled: result field is no longer required/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        oldPattern,
        newRequiredWithoutDefault,
      )
    ).toThrow(/result\.summary: newly required result field has no default/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, newRequiredWithDefault)
    ).not.toThrow();
  });

  it("checks every additionalProperties compatibility direction", () => {
    const schema = (additionalProperties: JSONSchema | undefined) => ({
      type: "object" as const,
      properties: { value: { type: "number" as const } },
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    });

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(undefined), oldPattern.resultSchema),
        pattern(schema(false), oldPattern.resultSchema),
      )
    ).toThrow(/additional properties accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
        pattern(schema(false), oldPattern.resultSchema),
      )
    ).toThrow(/additional properties accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(undefined), oldPattern.resultSchema),
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
      )
    ).toThrow(/additional properties are now constrained/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
        pattern(schema({ type: "string" }), oldPattern.resultSchema),
      )
    ).toThrow(/argument\.\*/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(false), oldPattern.resultSchema),
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
      )
    ).not.toThrow();
  });

  it("checks scalar constraints that cannot be safely changed", () => {
    const previous = (value: JSONSchema) =>
      pattern(
        { type: "object", properties: { value } },
        oldPattern.resultSchema,
      );
    const expectRejected = (source: JSONSchema, target: JSONSchema) =>
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          previous(source),
          previous(target),
        )
      ).toThrow(/argument\.value/);

    expectRejected({ type: "array" }, { type: "array", uniqueItems: true });
    expectRejected({ type: "string" }, { type: "string", pattern: "^x" });
    expectRejected({ type: "string" }, { type: "string", format: "email" });
    expectRejected({ type: "number" }, { type: "number", multipleOf: 2 });
  });

  it("rejects malformed required fields and unknown keyword changes", () => {
    const missingRequiredSchema = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
        },
        required: ["value", "missing"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, missingRequiredSchema)
    ).toThrow(
      /argument\.missing: newly required argument field has no default/,
    );

    const unknownKeyword = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "number",
            customConstraint: true,
          } as JSONSchema,
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, unknownKeyword)
    ).toThrow(/customConstraint changed/);
  });
});
