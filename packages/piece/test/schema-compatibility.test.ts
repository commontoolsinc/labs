import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  assertPatternSchemasBackwardCompatible,
  assertSchemaSubset,
} from "../src/schema-compatibility.ts";

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
  it("accepts named Fabric projection fields through an open link target", () => {
    const source: JSONSchema = {
      type: "object",
      properties: {
        mentioned: { type: "array", items: true },
        backlinks: { type: "array", items: true },
        $FS: { type: "object" },
        explicitUndefined: { type: "undefined" },
      },
      required: ["mentioned", "backlinks", "$FS", "explicitUndefined"],
      additionalProperties: false,
    };
    const openTarget: JSONSchema = {
      type: "object",
      properties: {
        mentioned: { type: "array", items: true },
        backlinks: { type: "array", items: true },
      },
      required: ["mentioned", "backlinks"],
    };

    expect(() => assertSchemaSubset(source, openTarget)).not.toThrow();
    expect(() =>
      assertSchemaSubset(source, {
        ...openTarget,
        additionalProperties: false,
      })
    ).toThrow(/\$FS: source field is rejected/);
    expect(() =>
      assertSchemaSubset(source, {
        ...openTarget,
        patternProperties: { "^\\$FS$": { type: "string" } },
      })
    ).toThrow(/patternProperties|\$FS/);

    const finiteProjection: JSONSchema = {
      type: "object",
      properties: { $FS: { type: "object" } },
      required: ["$FS"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(finiteProjection, {
        type: "object",
        patternProperties: { "^\\$FS$": { type: "object" } },
        required: ["$FS"],
        additionalProperties: false,
      })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        {
          type: "object",
          patternProperties: { "^x": { type: "number" } },
          additionalProperties: false,
        },
        {
          type: "object",
          patternProperties: { "^y": { type: "number" } },
          additionalProperties: false,
        },
      )
    ).toThrow(/patternProperties changed/);

    const intersectedProperty: JSONSchema = {
      type: "object",
      properties: { x: { type: ["number", "string"] } },
      patternProperties: { "^x$": { type: "number" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(intersectedProperty, intersectedProperty))
      .not.toThrow();
  });

  it("reports invalid and unprovable durable-link contracts", () => {
    const invalid = { type: "not-a-fabric-type" } as unknown as JSONSchema;
    expect(() => assertSchemaSubset(invalid, true, "link")).toThrow(
      /source schema is invalid/,
    );
    expect(() => assertSchemaSubset(true, invalid, "link")).toThrow(
      /target schema is invalid/,
    );

    const namedString: JSONSchema = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).toThrow(/x.*type/);
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        patternProperties: { "^x$": { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).toThrow(/x.*type/);
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        additionalProperties: { type: "number" },
      })
    ).toThrow(/x.*type/);

    const intersectedSource: JSONSchema = {
      type: "object",
      properties: { x: { type: ["number", "string"] } },
      patternProperties: { "^x$": { type: "number" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(intersectedSource, {
        type: "object",
        properties: { x: { type: "number" } },
        patternProperties: { "^x$": { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).not.toThrow();
  });

  it("uses target defaults as link proofs only under default-stable ancestors", () => {
    const properties = {
      x: { type: "number" as const },
      y: { type: "number" as const },
    };
    const stableSource: JSONSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    const stableTarget: JSONSchema = {
      type: "object",
      properties: {
        ...properties,
        x: { type: "number", default: 0 },
      },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(stableSource, stableTarget)).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { ...stableSource, minProperties: 1 },
        { ...stableTarget, minProperties: 1 },
      )
    ).not.toThrow();

    expect(() =>
      assertSchemaSubset(
        { ...stableSource, maxProperties: 1 },
        { ...stableTarget, maxProperties: 1 },
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertSchemaSubset(
        {
          ...stableSource,
          dependentRequired: { x: ["y"] },
        },
        {
          ...stableTarget,
          dependentRequired: { x: ["y"] },
        },
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertSchemaSubset(
        { type: "array", items: stableSource, uniqueItems: true },
        { type: "array", items: stableTarget, uniqueItems: true },
      )
    ).toThrow(/not stable under default insertion/);

    const unstableChild: JSONSchema = {
      type: "object",
      properties: {
        a: { type: "number", default: 0 },
        b: { type: "number" },
      },
      maxProperties: 1,
      additionalProperties: false,
    };
    const dynamicTarget: JSONSchema = {
      type: "object",
      patternProperties: {
        "^x": unstableChild,
      },
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(dynamicTarget, dynamicTarget)).toThrow(
      /not stable under default insertion/,
    );

    const arrayTarget: JSONSchema = {
      type: "array",
      items: stableTarget,
      uniqueItems: true,
    };
    expect(() => assertSchemaSubset(arrayTarget, arrayTarget)).toThrow(
      /not stable under default insertion/,
    );

    const nestedTarget: JSONSchema = {
      type: "object",
      properties: { item: unstableChild },
      required: ["item"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(nestedTarget, nestedTarget)).toThrow(
      /not stable under default insertion/,
    );

    const plainArrayTarget: JSONSchema = {
      type: "array",
      items: unstableChild,
    };
    expect(() => assertSchemaSubset(plainArrayTarget, plainArrayTarget))
      .toThrow(/not stable under default insertion/);
  });

  it("rejects changed migration defaults below default-unstable constraints", () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {},
    };
    const boundedArgument: JSONSchema = {
      type: "object",
      properties: { y: { type: "number" } },
      maxProperties: 1,
    };
    const withOptionalDefault: JSONSchema = {
      ...boundedArgument,
      properties: {
        y: { type: "number" },
        x: { type: "number", default: 0 },
      },
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(boundedArgument, resultSchema),
        pattern(withOptionalDefault, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    const existingOptional: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      maxProperties: 1,
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(existingOptional, resultSchema),
        pattern({
          ...existingOptional,
          properties: {
            x: { type: "number", default: 0 },
            y: { type: "number" },
          },
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(boundedArgument, resultSchema),
        pattern({
          ...withOptionalDefault,
          required: ["x"],
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({
          type: "array",
          items: boundedArgument,
          uniqueItems: true,
        }, resultSchema),
        pattern({
          type: "array",
          items: withOptionalDefault,
          uniqueItems: true,
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);
  });

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

  it("rejects narrowing through nested child-local definitions", () => {
    const argumentWithLocalValue = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: { value: { $ref: "#/$defs/Value" } },
              $defs: { Value: value },
            },
          },
          $defs: { Value: { type: "number" } },
        },
        oldPattern.resultSchema,
      );

    const previous = argumentWithLocalValue({
      type: ["number", "string"],
    });
    const narrowed = argumentWithLocalValue({ type: "number" });
    const widened = argumentWithLocalValue({
      type: ["number", "string", "undefined"],
    });

    expect(() => assertPatternSchemasBackwardCompatible(previous, narrowed))
      .toThrow(/argument\.nested\.value/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .not.toThrow();
  });

  it("does not borrow an outer default for a referenced definition body", () => {
    const previous = pattern(
      { type: "object", properties: {} },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: { item: { $ref: "#/$defs/Entry" } },
        required: ["item"],
        $defs: {
          Entry: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            required: ["value"],
            $defs: { Value: { type: "string" } },
          },
          Value: { type: "number", default: 1 },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/argument\.item.*no default/);
  });

  it("keeps embedded ref roots while comparing unchanged native schemas", () => {
    const vnode = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    } as const;
    const previous = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          $UI: vnode,
          value: { type: "number" },
        },
        required: ["$UI", "value"],
      },
    );
    const candidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          $UI: vnode,
          value: { type: "number" },
          extra: { type: "string" },
        },
        required: ["$UI", "value"],
      },
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

  it("checks changed definitions below unchanged inline containers", () => {
    const withNestedRef = (type: "number" | "string") =>
      pattern(
        {
          type: "object",
          properties: {
            container: {
              type: "object",
              properties: { value: { $ref: "#/$defs/Value" } },
            },
          },
          $defs: { Value: { type } },
        },
        oldPattern.resultSchema,
      );

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withNestedRef("number"),
        withNestedRef("string"),
      )
    ).toThrow(/argument\.container\.value/);
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

  it("rejects required defaults that violate scalar constraints", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          retries: { type: "number", minimum: 10, default: 0 },
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

  it("does not treat prototype properties as prior result fields", () => {
    const previous = pattern(oldPattern.argumentSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const candidate = pattern(oldPattern.argumentSchema, {
      type: "object",
      properties: { toString: { type: "number" as const } },
      required: ["toString"],
      additionalProperties: false,
    });

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/result\.toString/);
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
      .toThrow(/cannot resolve schema reference/);

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

  it("compares Fabric enum and const values canonically", () => {
    const first = new FabricBytes(new Uint8Array([1]));
    const second = new FabricBytes(new Uint8Array([2]));
    const common = new FabricBytes(new Uint8Array([3]));
    const argumentWith = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
        oldPattern.resultSchema,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWith({ enum: [first, common] } as unknown as JSONSchema),
        argumentWith({ enum: [second, common] } as unknown as JSONSchema),
      )
    ).toThrow(/enum\/const/);

    const resultWith = (value: JSONSchema) =>
      pattern(
        oldPattern.argumentSchema,
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        resultWith({ const: first } as unknown as JSONSchema),
        resultWith({ const: second } as unknown as JSONSchema),
      )
    ).toThrow(/enum\/const/);
  });

  it("intersects sibling const and enum constraints", () => {
    const argumentPrevious = pattern(
      {
        type: "object",
        properties: { value: { const: 1 } },
      },
      oldPattern.resultSchema,
    );
    const argumentImpossible = pattern(
      {
        type: "object",
        properties: { value: { const: 1, enum: [2] } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentImpossible,
      )
    ).toThrow(/argument\.value/);

    const resultPrevious = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { const: 1, enum: [2] } },
      },
    );
    const resultCandidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { const: 1 } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultPrevious, resultCandidate)
    ).toThrow(/result\.value/);
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

  it("checks referenced definitions inside unchanged complex constraints", () => {
    const withComplexRef = (
      valueType: "number" | "string",
      description: string,
    ) =>
      pattern(
        {
          type: "object",
          properties: {
            value: {
              allOf: [{ $ref: "#/$defs/Value" }],
            },
          },
          $defs: { Value: { type: valueType } },
          description,
        },
        oldPattern.resultSchema,
      );

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withComplexRef("number", "previous"),
        withComplexRef("string", "candidate"),
      )
    ).toThrow(/argument\.value: allOf changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withComplexRef("number", "previous"),
        withComplexRef("number", "candidate"),
      )
    ).not.toThrow();
  });

  it("does not interpret literal data named $ref as a schema reference", () => {
    const literalRef = { $ref: "#not-a-schema-reference" };
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "object",
            default: literalRef,
            enum: [literalRef],
          },
        },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "object",
            default: literalRef,
            enum: [literalRef],
          },
          added: { type: "string" },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
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

    const tuple = (first: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: {
            value: {
              type: "array",
              prefixItems: [first],
              items: { type: "number" },
            },
          },
        },
        oldPattern.resultSchema,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        tuple({ type: "string" }),
        tuple({ type: "number" }),
      )
    ).toThrow(/prefixItems changed/);
  });

  it("treats undefined as a supported schema type", () => {
    const argumentPrevious = pattern(
      {
        type: "object",
        properties: { value: { type: "undefined" } },
      },
      oldPattern.resultSchema,
    );
    const argumentWidened = pattern(
      {
        type: "object",
        properties: { value: { type: ["string", "undefined"] } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentWidened,
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWidened,
        argumentPrevious,
      )
    ).toThrow(/argument\.value/);

    const argumentAnyOf = pattern(
      {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "undefined" }, { type: "string" }],
          },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(argumentPrevious, argumentAnyOf)
    ).not.toThrow();

    const argumentWidenedWithNumericConstraint = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: ["undefined", "number"],
            minimum: 0,
          },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentWidenedWithNumericConstraint,
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number" },
        { type: ["undefined", "number"], minimum: 0 },
      )
    ).toThrow();
    for (
      const target of [
        {
          type: ["undefined", "string"],
          pattern: "^ok$",
        },
        {
          type: ["undefined", "array"],
          items: { type: "string" },
          contains: { const: "ok" },
        },
        {
          type: ["undefined", "object"],
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
          propertyNames: { pattern: "^value$" },
        },
      ] satisfies JSONSchema[]
    ) {
      expect(() => assertSchemaSubset({ type: "undefined" }, target)).not
        .toThrow();
    }
    for (
      const target of [
        {
          type: ["undefined", "string"],
          contentEncoding: "base64",
        },
        {
          type: ["undefined", "string"],
          contentMediaType: "application/json",
        },
        {
          type: ["undefined", "string"],
          contentSchema: { type: "string" },
        },
      ] satisfies JSONSchema[]
    ) {
      expect(validateSchemaValue(target, undefined, target)).toMatch(
        /content validation is not supported/,
      );
      expect(() => assertSchemaSubset({ type: "undefined" }, target)).toThrow();
    }
    expect(() =>
      assertSchemaSubset(
        { type: "array", items: { type: "number" } },
        {
          type: ["undefined", "array"],
          items: { type: "string" },
        },
      )
    ).toThrow();
    expect(() =>
      assertSchemaSubset(
        {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        {
          type: ["undefined", "object"],
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
      )
    ).toThrow();

    const requiredUndefinedDefault = pattern(
      {
        type: "object",
        properties: {
          value: { type: "undefined", default: undefined },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object", properties: {} }, oldPattern.resultSchema),
        requiredUndefinedDefault,
      )
    ).not.toThrow();

    const resultPrevious = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { type: ["string", "undefined"] } },
      },
    );
    const resultNarrowed = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { type: "undefined" } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultPrevious, resultNarrowed)
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultNarrowed, resultPrevious)
    ).toThrow(/result\.value/);

    const resultAnyOf = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "undefined" }],
          },
        },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultAnyOf, resultNarrowed)
    ).not.toThrow();
  });

  it("does not use field-evolution allowances as conjunct proofs", () => {
    const candidateProperty = {
      type: "undefined",
      default: undefined,
    } as const;
    const priorContracts: JSONSchema[] = [
      { type: "object", required: ["x"] },
      { type: "object", allOf: [{ required: ["x"] }] },
      {
        type: "object",
        oneOf: [{ required: ["x"] }, { required: ["other"] }],
      },
      {
        type: "object",
        if: { required: ["flag"] },
        then: { required: ["x"] },
      },
      {
        type: "object",
        dependentSchemas: { flag: { required: ["x"] } },
      },
      {
        $ref: "#/$defs/Contract",
        $defs: {
          Contract: { type: "object", allOf: [{ required: ["x"] }] },
        },
      },
    ];

    for (const previousArgument of priorContracts) {
      const candidateArgument = {
        ...(previousArgument as Exclude<JSONSchema, boolean>),
        properties: { x: candidateProperty },
        required: ["x"],
      } as JSONSchema;
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(previousArgument, oldPattern.resultSchema),
          pattern(candidateArgument, oldPattern.resultSchema),
        )
      ).toThrow(/argument/);
    }

    const previousAnyOf: JSONSchema = {
      type: "object",
      anyOf: [
        {
          properties: {
            kind: { const: "a" },
            x: {
              type: ["number", "undefined"],
              asCell: ["cell"],
              scope: "user",
            },
          },
          required: ["kind", "x"],
        },
        {
          properties: { kind: { const: "b" } },
          required: ["kind"],
        },
      ],
    };
    const incompatibleAnyOf: JSONSchema = {
      ...previousAnyOf,
      properties: {
        x: {
          ...candidateProperty,
          asCell: ["stream"],
          scope: "session",
        },
      },
      required: ["x"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(previousAnyOf, oldPattern.resultSchema),
        pattern(incompatibleAnyOf, oldPattern.resultSchema),
      )
    ).toThrow(/argument/);
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

  it("checks new argument fields against prior additionalProperties", () => {
    const argumentSchema = (
      additionalProperties: JSONSchema,
      addedProperty?: JSONSchema,
    ): JSONSchema => ({
      type: "object",
      properties: {
        value: { type: "number" },
        ...(addedProperty === undefined ? {} : { label: addedProperty }),
      },
      additionalProperties,
    });
    const previousOpen = pattern(
      argumentSchema(true),
      oldPattern.resultSchema,
    );
    const candidateOpen = pattern(
      argumentSchema(true, { type: "string" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousOpen, candidateOpen)
    ).not.toThrow();

    const previousTyped = pattern(
      argumentSchema({ type: "number" }),
      oldPattern.resultSchema,
    );
    const incompatibleTyped = pattern(
      argumentSchema({ type: "number" }, { type: "string" }),
      oldPattern.resultSchema,
    );
    const compatibleTyped = pattern(
      argumentSchema({ type: "number" }, { type: "number" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, incompatibleTyped)
    ).toThrow(/argument\.label/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, compatibleTyped)
    ).not.toThrow();

    const previousClosed = pattern(
      argumentSchema(false),
      oldPattern.resultSchema,
    );
    const candidateClosed = pattern(
      argumentSchema(false, { type: "string" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousClosed, candidateClosed)
    ).not.toThrow();
  });

  it("checks new result fields against prior additionalProperties", () => {
    const resultSchema = (
      additionalProperties: JSONSchema,
      addedProperty?: JSONSchema,
    ): JSONSchema => ({
      type: "object",
      properties: {
        value: { type: "number" },
        ...(addedProperty === undefined ? {} : { label: addedProperty }),
      },
      additionalProperties,
    });
    const previousClosed = pattern(
      oldPattern.argumentSchema,
      resultSchema(false),
    );
    const candidateClosed = pattern(
      oldPattern.argumentSchema,
      resultSchema(false, { type: "string" }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousClosed, candidateClosed)
    ).toThrow(/result\.label: new result field is rejected/);

    const previousTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }),
    );
    const incompatibleTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }, { type: "string" }),
    );
    const compatibleTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }, { type: "number" }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, incompatibleTyped)
    ).toThrow(/result\.label/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, compatibleTyped)
    ).not.toThrow();
  });

  it("checks new named fields against prior patternProperties", () => {
    const previousArgument = pattern(
      {
        type: "object",
        patternProperties: { "^x": { type: "string" } },
      },
      oldPattern.resultSchema,
    );
    const candidateArgument = pattern(
      {
        type: "object",
        properties: { xMode: { type: "number" } },
        patternProperties: { "^x": { type: "string" } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        previousArgument,
        candidateArgument,
      )
    ).toThrow(/argument\.xMode/);

    const previousResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        patternProperties: { "^x": { type: "string" } },
      },
    );
    const candidateResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { xMode: { type: "number" } },
        patternProperties: { "^x": { type: "string" } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousResult, candidateResult)
    ).toThrow(/result\.xMode/);
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

    for (
      const [source, target] of [
        [{ type: "string" }, { type: "string", minLength: 1 }],
        [{ type: "array" }, { type: "array", minItems: 1 }],
        [{ type: "object" }, { type: "object", minProperties: 1 }],
        [{ type: "string" }, { type: "string", maxLength: 1 }],
        [{ type: "array" }, { type: "array", maxItems: 1 }],
        [{ type: "object" }, { type: "object", maxProperties: 1 }],
      ] as const
    ) {
      expectRejected(source, target);
    }

    expect(() =>
      assertSchemaSubset(
        { type: "string", minLength: 2, maxLength: 4 },
        { type: "string", minLength: 1, maxLength: 5 },
      )
    ).not.toThrow();
  });

  it("compares effective inclusive and exclusive numeric bounds", () => {
    expect(() =>
      assertSchemaSubset(
        { type: "number", exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", exclusiveMaximum: 10 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0, exclusiveMinimum: -1 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 10, exclusiveMaximum: 11 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: -1, exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 11, exclusiveMaximum: 10 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0, exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();

    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0 },
        { type: "number", exclusiveMinimum: 0 },
      )
    ).toThrow(/more restrictive/);
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 10 },
        { type: "number", exclusiveMaximum: 10 },
      )
    ).toThrow(/more restrictive/);
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

  it("rejects malformed schemas before comparing variance", () => {
    const argumentWith = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: { value, format: { type: "string" } },
          required: ["value"],
        },
        oldPattern.resultSchema,
      );
    const resultWith = (value: JSONSchema) =>
      pattern(
        oldPattern.argumentSchema,
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      );

    const malformedCases: Array<[Pattern, Pattern]> = [
      [
        argumentWith({ type: [] } as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        resultWith({ type: ["number", "bogus"] } as JSONSchema),
        resultWith({ type: "number" }),
      ],
      [
        resultWith({ type: "number", minimum: 0 }),
        resultWith({ type: "number", minimum: Number.NaN }),
      ],
      [
        argumentWith({ type: "number" }),
        argumentWith({ type: "number", multipleOf: 0 }),
      ],
      [
        argumentWith({ type: "string" }),
        argumentWith({ $ref: "" } as JSONSchema),
      ],
      [
        argumentWith({ type: [, "number"] } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "object",
          required: [, "value"],
        } as unknown as JSONSchema),
        argumentWith({ type: "object" }),
      ],
      [
        argumentWith({
          dependentRequired: { value: [, "other"] },
        } as unknown as JSONSchema),
        argumentWith({ type: "object" }),
      ],
      [
        argumentWith({ enum: [,] } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "number",
          asCell: ["bogus"],
        } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "number",
          asCell: [{ kind: "cell", scope: "bogus" }],
        } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        resultWith(
          { type: "undefined", scope: "bogus" } as unknown as JSONSchema,
        ),
        resultWith({ type: "undefined" }),
      ],
    ];
    for (const [previous, candidate] of malformedCases) {
      expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
        .toThrow(/invalid schema/i);
    }
  });
});
