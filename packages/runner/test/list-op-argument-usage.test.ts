import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import { inferListOpArgumentUsage } from "../src/builtins/list-op-argument-usage.ts";

function usage(argumentSchema: JSONSchema | undefined) {
  return inferListOpArgumentUsage({ argumentSchema } as Pattern);
}

const allArguments = {
  usesElement: true,
  usesIndex: true,
  usesArray: true,
  usesParams: true,
};
const noArguments = {
  usesElement: false,
  usesIndex: false,
  usesArray: false,
  usesParams: false,
};

describe("list operation argument usage", () => {
  it("omits unused arguments from a transformed element-only callback", () => {
    expect(usage({
      type: "object",
      properties: { element: { $ref: "#/$defs/Bubble" } },
      required: ["element"],
      $defs: {
        Bubble: {
          type: "object",
          properties: { text: { type: "string" }, me: { type: "boolean" } },
          required: ["text", "me"],
        },
      },
    })).toEqual({ ...noArguments, usesElement: true });
  });

  it("preserves legacy and unrestricted callback inputs", () => {
    for (
      const schema of [
        undefined,
        true,
        {},
        { type: "object" },
        { type: "object", properties: {}, additionalProperties: true },
        { type: "object", additionalProperties: { type: "number" } },
      ] as const
    ) {
      expect(usage(schema)).toEqual(allArguments);
    }
  });

  it("selects explicitly declared index, array, and captured parameters", () => {
    expect(usage({
      type: "object",
      properties: {
        element: false,
        index: { type: "number" },
        array: { type: "array", items: true },
        params: { type: "object" },
      },
    })).toEqual({ ...allArguments, usesElement: false });
  });

  it("excludes closed, empty, and opaque callback projections", () => {
    for (
      const schema of [
        false,
        { type: "object", properties: {} },
        { type: "object", additionalProperties: false },
        { type: "unknown" },
      ] as const
    ) {
      expect(usage(schema)).toEqual(noArguments);
    }
  });

  it("resolves root references before selecting callback arguments", () => {
    expect(usage({
      $defs: {
        callback: {
          type: "object",
          properties: { array: { type: "array", items: true } },
        },
      },
      $ref: "#/$defs/callback",
    })).toEqual({ ...noArguments, usesArray: true });
  });

  it("includes declared inputs across alternatives and structural projections", () => {
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      expect(usage({
        properties: { params: { type: "object" } },
        [keyword]: [
          { properties: { element: { type: "string" } } },
          { properties: { index: { type: "number" } } },
        ],
      })).toEqual({ ...allArguments, usesArray: false });
    }
    expect(usage({ allOf: [true, false] })).toEqual(noArguments);
  });
});
