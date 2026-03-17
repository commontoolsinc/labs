import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  collectSchemaConfidentiality,
  schemaConfidentialityAtPath,
  schemaWithConfidentiality,
} from "../src/cfc/schema-labels.ts";
import { normalizeConfidentialityLabel } from "../src/cfc/label-algebra.ts";

describe("CFC schema label helpers", () => {
  const schema = {
    type: "object",
    ifc: {
      classification: [[
        {
          type: "https://commonfabric.org/cfc/atom/User",
          subject: "did:key:alice",
        },
      ]],
    },
    properties: {
      ssn: {
        type: "string",
        ifc: {
          classification: [[
            "https://commonfabric.org/cfc/atom/EmailSecret",
          ]],
        },
      },
    },
  } as const satisfies JSONSchema;
  const expectedClassification = normalizeConfidentialityLabel([
    [{
      type: "https://commonfabric.org/cfc/atom/User",
      subject: "did:key:alice",
    }],
    ["https://commonfabric.org/cfc/atom/EmailSecret"],
  ]);

  it("collects CNF confidentiality from a schema tree", () => {
    expect(
      normalizeConfidentialityLabel(collectSchemaConfidentiality(schema)),
    ).toEqual(expectedClassification);
  });

  it("resolves effective CNF confidentiality at a path", () => {
    expect(
      normalizeConfidentialityLabel(
        schemaConfidentialityAtPath(schema, ["ssn"]),
      ),
    ).toEqual(expectedClassification);
  });

  it("writes joined CNF confidentiality back to a schema object", () => {
    expect(
      schemaWithConfidentiality(
        { type: "number" },
        [[
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:alice",
          },
        ]],
      ),
    ).toEqual({
      type: "number",
      ifc: {
        classification: [[
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:alice",
          },
        ]],
      },
    });
  });
});
