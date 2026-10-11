import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../../src/cfc/schema-merge.ts";
import { droppedStoredClaim } from "../../src/cfc/claim-preservation.ts";
import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";

const writer = (moduleIdentity: string, binding = "admitPanel") => ({
  __ctWriterIdentityOf: {
    file: "/loom/admission.tsx",
    path: [binding],
    moduleIdentity,
  },
});

const panels = (
  moduleIdentity: string,
  kinds = ["url", "piece"],
  binding = "admitPanel",
  keyword: "anyOf" | "oneOf" = "anyOf",
): JSONSchema => ({
  type: "object",
  properties: {
    panels: {
      type: "array",
      items: {
        [keyword]: kinds.map((kind) => ({
          type: "object",
          properties: {
            kind: { type: "string", enum: [kind] },
            addedBy: { $ref: "#/$defs/Adder" },
          },
          required: ["kind"],
        })),
      },
    },
  },
  $defs: {
    Adder: {
      type: "string",
      ifc: { writeAuthorizedBy: writer(moduleIdentity, binding) },
    },
  },
});

const constrainedMember = (
  moduleIdentity: string,
  constraint: JSONSchema,
): JSONSchema => ({
  anyOf: [{
    type: "object",
    properties: { value: constraint, addedBy: { $ref: "#/$defs/Adder" } },
  }, { type: "undefined" }],
  $defs: {
    Adder: {
      type: "string",
      ifc: { writeAuthorizedBy: writer(moduleIdentity) },
    },
  },
});

describe("schema-merge-unions", () => {
  const unorderedConstraints: [string, JSONSchema, JSONSchema][] = [
    ["required", { required: ["a", "b"] }, { required: ["b", "a"] }],
    ["type", { type: ["string", "number"] }, { type: ["number", "string"] }],
    ["enum", { enum: [[1, 2], [2, 1]] }, { enum: [[2, 1], [1, 2]] }],
    ["dependentRequired", { dependentRequired: { a: ["b", "c"] } }, {
      dependentRequired: { a: ["c", "b"] },
    }],
    ...(["allOf", "anyOf", "oneOf"] as const).map((
      keyword,
    ): [string, JSONSchema, JSONSchema] => [
      keyword,
      {
        [keyword]: [{ type: "number", minimum: 0 }, {
          type: "number",
          maximum: 10,
        }],
      },
      {
        [keyword]: [{ type: "number", maximum: 10 }, {
          type: "number",
          minimum: 0,
        }],
      },
    ]),
  ];
  for (const [keyword, before, after] of unorderedConstraints) {
    it(`pairs branches whose ${keyword} members are reordered`, () => {
      const stored = constrainedMember("stored", before);
      const candidate = constrainedMember("next", after);
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        ),
      )
        .toEqual([writer("stored")]);
    });
  }

  for (
    const [keyword, before, after] of [
      ["default", { default: [1, 2] }, { default: [2, 1] }],
      ["enum literal", { enum: [[1, 2]] }, { enum: [[2, 1]] }],
      [
        "prefixItems",
        { prefixItems: [{ type: "string" }, { type: "number" }] },
        {
          prefixItems: [{ type: "number" }, { type: "string" }],
        },
      ],
      ["asCell", { asCell: ["cell", "stream"] }, {
        asCell: ["stream", "cell"],
      }],
    ] as const
  ) {
    it(`refuses reordered ${keyword} sequences`, () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(
          constrainedMember("stored", before),
          constrainedMember("next", after),
        )
      )
        .toThrow(/union branches/);
    });
  }

  it("refuses changing oneOf branch multiplicity", () => {
    const branch = { type: "string" } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(
        constrainedMember("stored", { oneOf: [branch] }),
        constrainedMember("next", { oneOf: [branch, branch] }),
      )
    ).toThrow(/union branches/);
  });

  it("refuses an added policy-free branch that overlaps stored values", () => {
    const schema = (moduleIdentity: string) =>
      ({
        anyOf: [{
          type: "object",
          properties: { addedBy: { $ref: "#/$defs/Adder" } },
        }],
        $defs: {
          Adder: {
            type: "string",
            ifc: { writeAuthorizedBy: writer(moduleIdentity) },
          },
        },
      }) as const;
    const stored = schema("stored");
    const candidate = schema("next");
    const extra = { type: "object" } as const;
    // The stored-claim guard sees the preserved arm; it does not prove the
    // additional arm disjoint from values that arm already accepts.
    expect(
      droppedStoredClaim(stored, {
        ...stored,
        anyOf: [...stored.anyOf, extra],
      }),
    ).toBeUndefined();
    expect(() =>
      mergeCfcSchemaEnvelopes(stored, {
        ...candidate,
        anyOf: [...candidate.anyOf, extra],
      })
    )
      .toThrow(/union branches/);
  });

  for (const keyword of ["anyOf", "oneOf"] as const) {
    it(`retains the stored writer through a reordered ${keyword} and repeated setup`, () => {
      const stored = panels("stored", ["url", "piece"], "admitPanel", keyword);
      const candidate = panels(
        "successor",
        ["piece", "url"],
        "admitPanel",
        keyword,
      );
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        ),
      ).toEqual([writer("stored"), writer("stored")]);
      const repeated = mergeCfcSchemaEnvelopes(merged, candidate);
      expect(droppedStoredClaim(stored, repeated)).toBeUndefined();
    });
  }

  it("keeps candidate policy references beneath stored links through repeated setup", () => {
    const stored = panels("stored");
    const candidate = panels("successor");
    const options = {
      beneathStoredLink: (path: readonly string[]) => path.length > 2,
    };
    const merged = mergeCfcSchemaEnvelopes(stored, candidate, options);
    expect(
      cfcSchemaEntries(merged).map((entry) =>
        (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
      ),
    ).toEqual([writer("successor"), writer("successor")]);
    expect(() => mergeCfcSchemaEnvelopes(merged, candidate, options)).not
      .toThrow();
  });

  it("refuses changing a referenced writer binding inside a union", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        panels("stored"),
        panels("next", undefined, "removePanel"),
      )
    )
      .toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("refuses unmatched policy-bearing branches", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        panels("stored"),
        panels("next", ["url", "document"]),
      )
    )
      .toThrow(/union branches/);
  });

  it("refuses ambiguous reference-only branch correspondence", () => {
    const schema = (moduleIdentity: string): JSONSchema => ({
      anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      $defs: {
        A: {
          type: "string",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
        B: {
          type: "number",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
      },
    });
    expect(() => mergeCfcSchemaEnvelopes(schema("stored"), schema("next")))
      .toThrow(/union branches/);
  });

  it("keeps literal defaults in branch correspondence, including keys named ifc and $ref", () => {
    const schema = (moduleIdentity: string, literal: string): JSONSchema => ({
      anyOf: [{
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        default: { ifc: literal, $ref: literal },
      }, { type: "undefined" }],
      $defs: {
        Value: {
          type: "string",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
      },
    });
    expect(() =>
      mergeCfcSchemaEnvelopes(
        schema("stored", "before"),
        schema("next", "after"),
      )
    )
      .toThrow(/union branches/);
  });

  it("leaves unions without policy on the existing candidate-wins path", () => {
    const merged = mergeCfcSchemaEnvelopes(
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { anyOf: [{ type: "boolean" }] },
    ) as JSONSchemaObj;
    expect(merged.anyOf).toEqual([{ type: "boolean" }]);
  });

  it("refuses a union merge that would produce unsupported inline policies", () => {
    const candidate = panels("successor") as JSONSchemaObj;
    const strengthened = {
      ...candidate,
      $defs: {
        Adder: { ...candidate.$defs!.Adder as JSONSchemaObj, minLength: 1 },
      },
    };
    expect(() => mergeCfcSchemaEnvelopes(panels("stored"), strengthened))
      .toThrow(/ifc inside divergent anyOf/);
  });

  it("keeps body claims when an IFC sibling overlays a reference", () => {
    const stored = {
      properties: {
        pin: { $ref: "#/$defs/Pin", ifc: { addIntegrity: ["copied"] } },
      },
      $defs: {
        Pin: { type: "string", ifc: { writeAuthorizedBy: writer("stored") } },
      },
    } as const;
    const merged = mergeCfcSchemaEnvelopes(stored, {
      properties: { pin: { type: "string" } },
    });
    expect(
      cfcSchemaEntries(merged).map((entry) =>
        (entry.schema as JSONSchemaObj).ifc
      ),
    )
      .toEqual([{
        addIntegrity: ["copied"],
        writeAuthorizedBy: writer("stored"),
      }]);
  });
});
