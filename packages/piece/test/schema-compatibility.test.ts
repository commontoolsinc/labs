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
});
