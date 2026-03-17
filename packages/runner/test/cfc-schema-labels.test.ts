import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  collectSchemaConfidentiality,
  schemaConfidentialityAtPath,
  schemaWithConfidentiality,
} from "../src/cfc/schema-labels.ts";

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

  it("collects CNF confidentiality from a schema tree", () => {
    expect(collectSchemaConfidentiality(schema)).toEqual([
      [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:key:alice",
      }],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ]);
  });

  it("resolves effective CNF confidentiality at a path", () => {
    expect(schemaConfidentialityAtPath(schema, ["ssn"])).toEqual([
      [{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:key:alice",
      }],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ]);
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
