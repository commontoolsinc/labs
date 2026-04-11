import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcLabelViewFromMetadata,
  cfcLabelViewFromSchema,
} from "../src/cfc/label-view.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";

describe("CFC label view helpers", () => {
  it("collects labels that apply to a logical value path", () => {
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["value", "body"],
            label: { classification: ["prompt-influenced"] },
          },
          {
            path: ["value", "body", "summary"],
            label: { integrity: ["summarized-by-trusted-pattern"] },
          },
          {
            path: ["other"],
            label: { classification: ["not-rendered"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["body"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { classification: ["prompt-influenced"] },
        },
        {
          path: ["summary"],
          label: { integrity: ["summarized-by-trusted-pattern"] },
        },
      ],
    });
  });

  it("falls back to schema ifc annotations before persisted metadata exists", () => {
    expect(
      cfcLabelViewFromSchema({
        type: "object",
        properties: {
          rendered: {
            type: "string",
            ifc: {
              classification: ["prompt-risk"],
              integrity: ["trusted-summary"],
              maxConfidentiality: ["internal"],
            },
          },
        },
      }),
    ).toEqual({
      version: 1,
      entries: [{
        path: ["rendered"],
        label: {
          classification: ["prompt-risk"],
          confidentiality: ["internal"],
          integrity: ["trusted-summary"],
        },
      }],
    });
  });
});
