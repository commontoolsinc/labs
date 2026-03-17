import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import { applyArgumentIfcToResult } from "../src/builder/node-utils.ts";

describe("builder IFC propagation", () => {
  it("preserves CNF confidentiality labels when applying argument IFC to results", () => {
    const argumentSchema = {
      type: "object",
      ifc: {
        classification: [[
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:alice",
          },
        ]],
      },
    } as const satisfies JSONSchema;
    const resultSchema = {
      type: "object",
      ifc: {
        classification: [[
          "https://commonfabric.org/cfc/atom/EmailSecret",
        ]],
      },
    } as const satisfies JSONSchema;

    expect(applyArgumentIfcToResult(argumentSchema, resultSchema)).toEqual({
      type: "object",
      ifc: {
        classification: [
          [{
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:alice",
          }],
          ["https://commonfabric.org/cfc/atom/EmailSecret"],
        ],
      },
    });
  });
});
