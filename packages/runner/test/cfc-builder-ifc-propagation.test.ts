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

  it("does not auto-propagate argument confidentiality onto result schemas that declare declassify rules", () => {
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
      type: "number",
      ifc: {
        integrity: [[
          {
            type: "https://commonfabric.org/cfc/atom/InjectionSafe",
            stage: "value",
            detectorProfile: "pi-screen-v3",
          },
        ]],
        declassify: {
          confidentialityPre: [[
            {
              type: "https://commonfabric.org/cfc/atom/Caveat",
              kind: "PROMPT_INJECTION_RISK_UNSCREENED",
              source: "ref:report-1",
            },
          ]],
          removeMatchedClauses: true,
          releaseCondition: true,
        },
      },
    } as const satisfies JSONSchema;

    expect(applyArgumentIfcToResult(argumentSchema, resultSchema)).toEqual(
      resultSchema,
    );
  });
});
