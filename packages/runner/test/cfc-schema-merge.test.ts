import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  FabricBytes,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { cfcSchemaEntries } from "../src/cfc/schema-label-view.ts";
import { vnodeSchema } from "../src/schemas.ts";
import {
  addRootConfidentiality,
  cfcScalarTypeTransitions,
  cfcSchemaMergeIssue,
  mergeCfcSchemaEnvelopes,
} from "../src/cfc/schema-merge.ts";
import { storedSchemaCoversCandidateEnvelope } from "../src/cfc/prepare.ts";

describe("mergeCfcSchemaEnvelopes", () => {
  it("accepts an additive required field with an explicit undefined default", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {},
    }, {
      type: "object",
      properties: {
        marker: { type: "undefined", default: undefined },
      },
      required: ["marker"],
    }) as JSONSchemaObj;

    expect(merged.required).toEqual(["marker"]);
    const marker = merged.properties!.marker as JSONSchemaObj;
    expect(Object.hasOwn(marker, "default")).toBe(true);
    expect(marker.default).toBeUndefined();
  });

  it("keeps an authored false schema impossible", () => {
    expect(addRootConfidentiality(false, ["space"])).toEqual({
      not: {},
      ifc: { confidentiality: ["space"] },
    });
  });

  it("adds root confidentiality without weakening an authored label", () => {
    const authored = {
      type: "object",
      properties: { value: { type: "string" } },
      ifc: { confidentiality: ["authored"] },
    } as const;
    const augmented = addRootConfidentiality(authored, ["space"]);

    expect(augmented).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      ifc: { confidentiality: ["authored", "space"] },
    });
    const merged = mergeCfcSchemaEnvelopes(
      authored,
      augmented,
    ) as JSONSchemaObj;
    expect(merged.ifc?.confidentiality).toEqual(["authored", "space"]);
  });

  it("adds root confidentiality after resolving an authored root reference", () => {
    const authored = {
      $ref: "#/$defs/Result",
      $defs: {
        Result: {
          type: "object",
          properties: { value: { type: "string" } },
          ifc: { confidentiality: ["authored"] },
        },
      },
    } as const;
    const augmented = addRootConfidentiality(authored, ["space"]);

    expect(augmented).toEqual({
      $defs: authored.$defs,
      type: "object",
      properties: { value: { type: "string" } },
      ifc: { confidentiality: ["authored", "space"] },
    });
    const merged = mergeCfcSchemaEnvelopes(
      authored.$defs.Result,
      augmented,
    ) as JSONSchemaObj;
    expect(merged.ifc?.confidentiality).toEqual(["authored", "space"]);
  });

  it("keeps existing definitions referenced by retained schema branches", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [
        { $ref: "#/$defs/Present" },
        { $ref: "#/$defs/Empty" },
      ],
      $defs: {
        Present: { type: "string" },
        Empty: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    }, {
      $ref: "#/$defs/Present",
      $defs: {
        Present: { type: "string" },
      },
    }) as JSONSchemaObj;

    expect(merged.$defs).toEqual({
      Present: { type: "string" },
      Empty: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it("rejects referenced policy when another branch is merged", () => {
    const sharedPolicy = {
      writeAuthorizedBy: ["trusted-writer"],
      requiredIntegrity: ["admin"],
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          list: { $ref: "#/$defs/SharedList" },
        },
        $defs: {
          SharedList: {
            type: "array",
            items: { type: "string" },
            ifc: sharedPolicy,
          },
        },
      }, {
        anyOf: [
          { $ref: "#/$defs/Empty" },
          {
            type: "object",
            properties: {
              list: { $ref: "#/$defs/TrustedList" },
            },
          },
        ],
        $defs: {
          Empty: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          TrustedList: {
            type: "array",
            items: {
              type: "string",
              ifc: { addIntegrity: ["admin"] },
            },
            ifc: sharedPolicy,
          },
        },
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("keeps a retained reference bound across an unused name collision", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        legacy: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
    }, {
      type: "object",
      properties: {
        current: { type: "string" },
      },
      $defs: {
        Shared: { type: "string" },
      },
    }) as JSONSchemaObj;

    expect(
      cfcSchemaEntries(merged).map(({ path, label }) => ({
        path,
        confidentiality: label.confidentiality,
      })),
    ).toEqual([{
      path: ["legacy"],
      confidentiality: ["secret"],
    }]);
  });

  it("merges policy on a definition referenced by both sides", () => {
    const merged = mergeCfcSchemaEnvelopes({
      $ref: "#/$defs/Shared",
      $defs: {
        Shared: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
    }, {
      $ref: "#/$defs/Shared",
      $defs: {
        Shared: { type: "string" },
      },
    });

    expect(cfcSchemaEntries(merged).map(({ label }) => label.confidentiality))
      .toEqual([["secret"]]);
  });

  it("rejects incompatible definitions referenced by both sides", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        $ref: "#/$defs/Shared",
        $defs: {
          Shared: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
      }, {
        $ref: "#/$defs/Shared",
        $defs: {
          Shared: { type: "number" },
        },
      })
    ).toThrow("type changed incompatibly at /");
  });

  it("checks shared definition changes at every reference path", () => {
    const transitions: string[][] = [];
    mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Shared" },
        bar: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: { type: "string" },
      },
    }, {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Shared" },
        bar: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: { type: "number" },
      },
    }, {
      allowIncompatibleScalarTypeChange: ({ path }) => {
        transitions.push([...path]);
        return true;
      },
    });

    expect(transitions).toEqual([["foo"], ["bar"]]);
  });

  it("applies generated-output exemptions at a reference path", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: { type: "string" },
      },
    }, {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: { type: "unknown", asCell: ["cell"] },
      },
    }, {
      generatedOutputPaths: [["foo"]],
    }) as JSONSchemaObj;

    expect(merged.properties?.foo).toMatchObject({
      type: "string",
      asCell: ["cell"],
    });
  });

  it("retains recursive references without expanding indefinitely", () => {
    const recursive = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(
      recursive,
      recursive,
    ) as JSONSchemaObj;
    expect((merged.properties?.next as JSONSchemaObj).$ref).toBe(
      "#/$defs/Node",
    );
    expect(merged.$defs?.Node).toBeDefined();
  });

  it("merges the recursive VNode schema without expanding indefinitely", () => {
    expect(() => mergeCfcSchemaEnvelopes(vnodeSchema, vnodeSchema)).not
      .toThrow();
  });

  it("validates required siblings on a repeated recursive reference", () => {
    const existing = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: {
              $ref: "#/$defs/Node",
              required: ["value"],
            },
          },
        },
      },
    } as const;

    expect(() => mergeCfcSchemaEnvelopes(existing, candidate)).toThrow(
      "required field value needs a default",
    );
  });

  it("keeps a stored default during recursive required validation", () => {
    const existing = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string", default: "old" },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: {
              $ref: "#/$defs/Node",
              required: ["value"],
            },
          },
        },
      },
    } as const;

    expect(() => mergeCfcSchemaEnvelopes(existing, candidate)).not.toThrow();
  });

  it("validates scalar siblings on a repeated recursive reference", () => {
    const recursive = (nextType: "string" | "number") => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: {
              $ref: "#/$defs/Node",
              type: nextType,
            },
          },
        },
      },
    } as const);

    expect(() =>
      mergeCfcSchemaEnvelopes(recursive("string"), recursive("number"))
    ).toThrow("type changed incompatibly at /next");
  });

  it("keeps recursive reference policy beside the merged reference", () => {
    const existing = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: {
              $ref: "#/$defs/Node",
              ifc: { confidentiality: ["nested"] },
            },
          },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(
      existing,
      candidate,
    ) as JSONSchemaObj;
    const next = merged.properties?.next as JSONSchemaObj;
    expect(next.ifc?.confidentiality).toEqual(["nested"]);
    expect(next.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(next.allOf).toBeUndefined();
    expect(() => mergeCfcSchemaEnvelopes(merged, merged)).not.toThrow();
    expect(() =>
      mergeCfcSchemaEnvelopes(merged, {
        type: "object",
        properties: { next: { type: "string" } },
      })
    ).toThrow('type changed incompatibly at /next: ["object"] -> ["string"]');
  });

  it("does not copy outer reference policy into a recursive target", () => {
    const recursive = (valueType: "string" | "number") => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: valueType },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const);
    const existing = {
      ...recursive("string"),
      ifc: { addIntegrity: ["root-only"] },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(
      existing,
      recursive("number"),
      { allowIncompatibleScalarTypes: true },
    ) as JSONSchemaObj;
    const recursiveTarget = merged.$defs?.__cfc_merged_ref_0 as JSONSchemaObj;

    expect(merged.ifc?.addIntegrity).toEqual(["root-only"]);
    expect(recursiveTarget.ifc).toBeUndefined();
    expect(
      (recursiveTarget.properties?.next as JSONSchemaObj).ifc,
    ).toBeUndefined();
  });

  it("does not treat an authored synthetic-looking name as recursion", () => {
    const existing = {
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "string",
          ifc: { confidentiality: ["stored"] },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Value",
      $defs: { Value: { type: "string" } },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(
      existing,
      candidate,
    ) as JSONSchemaObj;

    expect(merged).toMatchObject({
      type: "string",
      ifc: { confidentiality: ["stored"] },
    });
    expect(merged.$ref).toBeUndefined();
  });

  it("keeps synthetic-looking names independent across local scopes", () => {
    const property = (
      valueType: "string" | "number",
      confidentiality: string,
    ) => ({
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: valueType },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
          ifc: { confidentiality: [confidentiality] },
        },
      },
    } as const);
    const schema = {
      type: "object",
      properties: {
        a: property("string", "a"),
        b: property("number", "b"),
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(schema, schema) as JSONSchemaObj;
    const a = merged.properties?.a as JSONSchemaObj;
    const b = merged.properties?.b as JSONSchemaObj;
    const aName = a.$ref?.split("/").at(-1) as string;
    const bName = b.$ref?.split("/").at(-1) as string;

    expect(aName).not.toBe(bName);
    expect(merged.$defs?.[aName]).toMatchObject({
      type: "object",
      properties: { value: { type: "string" } },
      ifc: { confidentiality: ["a"] },
    });
    expect(merged.$defs?.[bName]).toMatchObject({
      type: "object",
      properties: { value: { type: "number" } },
      ifc: { confidentiality: ["b"] },
    });
    expect(
      ((merged.$defs?.[bName] as JSONSchemaObj).properties
        ?.next as JSONSchemaObj).$ref,
    ).toBe(`#/$defs/${bName}`);
  });

  it("ignores same-named references in an independent local scope", () => {
    const sharedHelper = { type: "string" } as const;
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        shadow: {
          $ref: "#/$defs/Shared",
          $defs: { Shared: sharedHelper },
        },
      },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
            helper: { $ref: "#/$defs/Shared" },
          },
        },
        Shared: sharedHelper,
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { foo: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Candidate" },
            helper: { $ref: "#/$defs/CandidateShared" },
          },
        },
        CandidateShared: sharedHelper,
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const foo = merged.properties?.foo as JSONSchemaObj;
    const shadow = merged.properties?.shadow as JSONSchemaObj;

    expect(foo.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(
      (merged.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toEqual({ type: "string" });
    expect(shadow.$defs?.Shared).toBe(sharedHelper);
  });

  it("does not change another site through a shared synthetic definition", () => {
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        bar: { $ref: "#/$defs/__cfc_merged_ref_0" },
      },
      $defs: {
        __cfc_merged_ref_0: { type: "number" },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { foo: { type: "string" } },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypeChange: ({ path }) =>
        path.length === 1 && path[0] === "foo",
    }) as JSONSchemaObj;
    const foo = merged.properties?.foo as JSONSchemaObj;
    const bar = merged.properties?.bar as JSONSchemaObj;

    expect(foo.type).toBe("string");
    expect(bar.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(merged.$defs?.__cfc_merged_ref_0).toMatchObject({ type: "number" });
  });

  it("reserves ancestor definition names during a repeated local merge", () => {
    const recursiveDefinition = (
      valueType: "string" | "number",
      ref: string,
    ) => ({
      type: "object",
      properties: {
        value: { type: valueType },
        next: { $ref: ref },
      },
    } as const);
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        bar: { $ref: "#/$defs/__cfc_merged_ref_0" },
      },
      $defs: {
        __cfc_merged_ref_0: recursiveDefinition(
          "number",
          "#/$defs/__cfc_merged_ref_0",
        ),
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { foo: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: recursiveDefinition("string", "#/$defs/Candidate"),
      },
    } as const;

    const once = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    });
    const twice = mergeCfcSchemaEnvelopes(once, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const bar = twice.properties?.bar as JSONSchemaObj;

    expect(bar.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(
      (twice.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "number" });
  });

  it("forks a recursive definition for an inline site change", () => {
    const existing = {
      type: "object",
      properties: { next: { $ref: "#/$defs/__cfc_merged_ref_0" } },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        next: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypeChange: ({ path }) =>
        path.join("/") === "next/value",
    }) as JSONSchemaObj;
    const next = merged.properties?.next as JSONSchemaObj;
    const deeper = next.properties?.next as JSONSchemaObj;

    expect(next.properties?.value).toMatchObject({ type: "string" });
    expect(deeper.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(
      (next.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "number" });
  });

  it("does not reuse recursion for a finite referenced site change", () => {
    const existing = {
      type: "object",
      properties: { next: { $ref: "#/$defs/__cfc_merged_ref_0" } },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { next: { $ref: "#/$defs/OneLevel" } },
      $defs: {
        OneLevel: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypeChange: ({ path }) =>
        path.join("/") === "next/value",
    }) as JSONSchemaObj;
    const next = merged.properties?.next as JSONSchemaObj;
    const deeper = next.properties?.next as JSONSchemaObj;

    expect(next.properties?.value).toMatchObject({ type: "string" });
    expect(deeper.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect(
      (next.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "number" });
  });

  it("does not reuse recursion through different schema paths", () => {
    const existing = {
      type: "object",
      properties: { node: { $ref: "#/$defs/__cfc_merged_ref_0" } },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            other: { $ref: "#/$defs/Candidate" },
          },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypeChange: ({ path }) =>
        path.join("/") === "node/value",
    }) as JSONSchemaObj;
    const node = merged.properties?.node as JSONSchemaObj;

    expect(node.properties?.value).toMatchObject({ type: "string" });
    expect((node.properties?.next as JSONSchemaObj).$ref).toBe(
      "#/$defs/__cfc_merged_ref_0",
    );
    expect((node.properties?.other as JSONSchemaObj).$ref).toBe(
      "#/$defs/Candidate",
    );
    expect(
      (node.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "number" });
    expect(
      (node.$defs?.Candidate as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "string" });
  });

  it("preserves an unmatched stored recursive path", () => {
    const existing = {
      type: "object",
      properties: { node: { $ref: "#/$defs/__cfc_merged_ref_0" } },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
            legacy: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Candidate" },
          },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const node = merged.properties?.node as JSONSchemaObj;

    expect((node.properties?.legacy as JSONSchemaObj).$ref).toBe(
      "#/$defs/__cfc_merged_ref_0",
    );
    expect(
      (node.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "number" });
  });

  it("preserves an unmatched candidate recursive path", () => {
    const existing = {
      type: "object",
      properties: { node: { $ref: "#/$defs/__cfc_merged_ref_0" } },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Candidate" },
            other: { $ref: "#/$defs/Candidate" },
          },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const node = merged.properties?.node as JSONSchemaObj;

    expect((node.properties?.other as JSONSchemaObj).$ref).toBe(
      "#/$defs/Candidate",
    );
    expect(node.$defs?.Candidate).toBeDefined();
  });

  it("preserves a helper definition inside reused recursion", () => {
    const existing = {
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Candidate",
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Candidate" },
            helper: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: {
          type: "string",
          ifc: { confidentiality: ["helper"] },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const recursiveTarget = merged.$defs?.__cfc_merged_ref_0 as JSONSchemaObj;
    const helperRef = (recursiveTarget.properties?.helper as JSONSchemaObj)
      .$ref!;
    const helperName = helperRef.split("/").at(-1)!;

    expect(helperRef).toMatch(/^#\/\$defs\/__cfc_merged_dep_/);
    expect((recursiveTarget.properties?.next as JSONSchemaObj).$ref).toBe(
      "#/$defs/__cfc_merged_ref_0",
    );
    expect(recursiveTarget.$defs).toBeUndefined();
    expect(merged.$defs?.[helperName]).toMatchObject({
      type: "string",
      ifc: { confidentiality: ["helper"] },
    });
    const twice = mergeCfcSchemaEnvelopes(merged, candidate, {
      allowIncompatibleScalarTypes: true,
    });
    const threeTimes = mergeCfcSchemaEnvelopes(twice, candidate, {
      allowIncompatibleScalarTypes: true,
    });
    expect(threeTimes).toEqual(twice);
  });

  it("preserves helper-mediated recursion across repeated merges", () => {
    const existing = {
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
            helper: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: {
          type: "object",
          properties: {
            parent: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Candidate",
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Candidate" },
            helper: { $ref: "#/$defs/CandidateHelper" },
          },
        },
        CandidateHelper: {
          type: "object",
          properties: { parent: { $ref: "#/$defs/Candidate" } },
        },
      },
    } as const;

    let merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const stable = merged;
    const definitionNames = Object.keys(stable.$defs ?? {});
    const targetName = stable.$ref?.split("/").at(-1)!;
    const target = stable.$defs?.[targetName] as JSONSchemaObj;
    const helperName = (target.properties?.helper as JSONSchemaObj).$ref
      ?.split("/").at(-1)!;

    expect(definitionNames).toEqual([targetName, helperName]);
    expect(
      (stable.$defs?.[helperName] as JSONSchemaObj).properties?.parent,
    ).toMatchObject({ $ref: `#/$defs/${targetName}` });
    for (let iteration = 0; iteration < 4; iteration++) {
      merged = mergeCfcSchemaEnvelopes(merged, candidate, {
        allowIncompatibleScalarTypes: true,
      }) as JSONSchemaObj;
      expect(merged).toEqual(stable);
      expect(Object.keys(merged.$defs ?? {})).toEqual(definitionNames);
    }

    expect(() => mergeCfcSchemaEnvelopes(merged, merged)).not.toThrow();
  });

  it("forks recursion shared through an owned helper definition", () => {
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        bar: { $ref: "#/$defs/Helper" },
      },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            helper: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: {
          type: "object",
          properties: {
            parent: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Candidate" },
      },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            helper: { $ref: "#/$defs/CandidateHelper" },
          },
        },
        CandidateHelper: {
          type: "object",
          properties: { parent: { $ref: "#/$defs/Candidate" } },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const foo = merged.properties?.foo as JSONSchemaObj;
    const barRef = (merged.properties?.bar as JSONSchemaObj).$ref;
    const fooName = foo.$ref?.split("/").at(-1)!;

    expect(foo.$ref).toMatch(/^#\/\$defs\/__cfc_merged_ref_[0-9]+$/);
    expect(fooName).not.toBe("__cfc_merged_ref_0");
    expect(
      (merged.$defs?.[fooName] as JSONSchemaObj).properties?.value,
    ).toMatchObject({ type: "string" });
    expect(barRef).toBe("#/$defs/Helper");
    expect(
      (merged.$defs?.__cfc_merged_ref_0 as JSONSchemaObj).properties?.value,
    ).toEqual({ type: "number" });

    let repeated = merged;
    for (let iteration = 0; iteration < 4; iteration++) {
      repeated = mergeCfcSchemaEnvelopes(repeated, candidate, {
        allowIncompatibleScalarTypes: true,
      }) as JSONSchemaObj;
      expect(repeated).toEqual(merged);
    }
  });

  it("stabilizes a shared recursive graph reached through aliases", () => {
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        bar: { $ref: "#/$defs/Helper" },
      },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: { $ref: "#/$defs/__cfc_merged_ref_0" },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { foo: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/CandidateHelper" },
          },
        },
        CandidateHelper: { $ref: "#/$defs/Candidate" },
      },
    } as const;

    let merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const stable = merged;
    const fooName = (stable.properties?.foo as JSONSchemaObj).$ref
      ?.split("/").at(-1)!;

    expect(fooName).not.toBe("__cfc_merged_ref_0");
    expect(
      (stable.$defs?.[fooName] as JSONSchemaObj).properties?.next,
    ).toMatchObject({ $ref: `#/$defs/${fooName}` });
    expect(stable.properties?.bar).toEqual({ $ref: "#/$defs/Helper" });
    for (let iteration = 0; iteration < 4; iteration++) {
      merged = mergeCfcSchemaEnvelopes(merged, candidate, {
        allowIncompatibleScalarTypes: true,
      }) as JSONSchemaObj;
      expect(merged).toEqual(stable);
    }
    expect(() => mergeCfcSchemaEnvelopes(merged, merged)).not.toThrow();
  });

  it("preserves policy siblings on a recursive alias", () => {
    const helperPolicy = { confidentiality: ["helper-secret"] } as const;
    const existing = {
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/__cfc_merged_ref_0" },
        bar: { $ref: "#/$defs/Helper" },
      },
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: {
          $ref: "#/$defs/__cfc_merged_ref_0",
          ifc: helperPolicy,
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { foo: { $ref: "#/$defs/Candidate" } },
      $defs: {
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/CandidateHelper" },
          },
        },
        CandidateHelper: {
          $ref: "#/$defs/Candidate",
          ifc: helperPolicy,
        },
      },
    } as const;

    let merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const stable = merged;
    const foo = stable.properties?.foo as JSONSchemaObj;
    const nextName = (foo.properties?.next as JSONSchemaObj).$ref
      ?.split("/").at(-1)!;

    expect(foo.$defs?.[nextName]).toMatchObject({ ifc: helperPolicy });
    for (let iteration = 0; iteration < 4; iteration++) {
      merged = mergeCfcSchemaEnvelopes(merged, candidate, {
        allowIncompatibleScalarTypes: true,
      }) as JSONSchemaObj;
      expect(merged).toEqual(stable);
    }
  });

  it("stabilizes unequal concrete and alias cycle topologies", () => {
    const existing = {
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/Helper" },
          },
        },
        Helper: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/CandidateAlias",
      $defs: {
        CandidateAlias: { $ref: "#/$defs/Candidate" },
        Candidate: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/CandidateAlias" },
          },
        },
      },
    } as const;

    let merged = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;
    const stable = merged;
    for (let iteration = 0; iteration < 4; iteration++) {
      merged = mergeCfcSchemaEnvelopes(merged, candidate, {
        allowIncompatibleScalarTypes: true,
      }) as JSONSchemaObj;
      expect(merged).toEqual(stable);
    }

    const changedCandidate = {
      ...candidate,
      $defs: {
        ...candidate.$defs,
        Candidate: {
          ...candidate.$defs.Candidate,
          properties: {
            ...candidate.$defs.Candidate.properties,
            value: { type: "boolean" },
          },
        },
      },
    } as const;
    expect(
      mergeCfcSchemaEnvelopes(stable, changedCandidate, {
        allowIncompatibleScalarTypes: true,
      }),
    ).not.toEqual(stable);

    const restCandidate = {
      ...candidate,
      $defs: {
        ...candidate.$defs,
        Candidate: {
          ...candidate.$defs.Candidate,
          additionalProperties: { type: "boolean" },
        },
      },
    } as const;
    expect(
      mergeCfcSchemaEnvelopes(stable, restCandidate, {
        allowIncompatibleScalarTypes: true,
      }),
    ).not.toEqual(stable);

    const aliasOnly = {
      $ref: "#/$defs/A",
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/A" },
      },
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(stable, aliasOnly, {
        allowIncompatibleScalarTypes: true,
      })
    ).toThrow();
  });

  it("stabilizes unequal cycle topologies through container schemas", () => {
    const recursiveNode = (
      kind: "items" | "prefixItems" | "additionalProperties",
      ref: string,
    ): JSONSchemaObj => {
      if (kind === "items") {
        return { type: "array", items: { $ref: ref } };
      }
      if (kind === "prefixItems") {
        return { type: "array", prefixItems: [{ $ref: ref }] };
      }
      return { type: "object", additionalProperties: { $ref: ref } };
    };

    for (
      const kind of [
        "items",
        "prefixItems",
        "additionalProperties",
      ] as const
    ) {
      const existing = {
        $ref: "#/$defs/__cfc_merged_ref_0",
        $defs: {
          __cfc_merged_ref_0: recursiveNode(kind, "#/$defs/Helper"),
          Helper: recursiveNode(kind, "#/$defs/__cfc_merged_ref_0"),
        },
      };
      const candidate = {
        $ref: "#/$defs/CandidateAlias",
        $defs: {
          CandidateAlias: { $ref: "#/$defs/Candidate" },
          Candidate: recursiveNode(kind, "#/$defs/CandidateAlias"),
        },
      };

      let merged = mergeCfcSchemaEnvelopes(
        existing,
        candidate,
      ) as JSONSchemaObj;
      const stable = merged;
      for (let iteration = 0; iteration < 4; iteration++) {
        merged = mergeCfcSchemaEnvelopes(merged, candidate) as JSONSchemaObj;
        expect(merged, `recursive ${kind} graph changed`).toEqual(stable);
      }
    }
  });

  it("stabilizes unequal cycles with policy-bearing aliases", () => {
    const existing = {
      $ref: "#/$defs/__cfc_merged_ref_0",
      $defs: {
        __cfc_merged_ref_0: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Helper" } },
        },
        Helper: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/__cfc_merged_ref_0" },
          },
        },
      },
    } as const;

    for (
      const aliasSiblings of [
        { ifc: { confidentiality: ["secret"] } },
        { title: "Candidate alias" },
      ] as const
    ) {
      const candidate = {
        $ref: "#/$defs/CandidateAlias",
        $defs: {
          CandidateAlias: {
            $ref: "#/$defs/Candidate",
            ...aliasSiblings,
          },
          Candidate: {
            type: "object",
            properties: {
              next: { $ref: "#/$defs/CandidateAlias" },
            },
          },
        },
      } as const;

      let merged = mergeCfcSchemaEnvelopes(
        existing,
        candidate,
      ) as JSONSchemaObj;
      const stable = merged;
      for (let iteration = 0; iteration < 4; iteration++) {
        merged = mergeCfcSchemaEnvelopes(merged, candidate) as JSONSchemaObj;
        expect(
          merged,
          `recursive alias changed for ${Object.keys(aliasSiblings)[0]}`,
        ).toEqual(stable);
      }
    }
  });

  it("stabilizes nested unequal cycles with policy-bearing aliases", () => {
    const existing = {
      $ref: "#/$defs/A",
      $defs: {
        A: {
          type: "object",
          properties: { next: { $ref: "#/$defs/H1" } },
        },
        H1: {
          type: "object",
          properties: { next: { $ref: "#/$defs/A" } },
        },
      },
    } as const;

    for (
      const aliasSiblings of [
        { ifc: { confidentiality: ["secret"] } },
        { title: "Nested candidate alias" },
        { not: { required: ["blocked"] } },
        { allOf: [{ title: "candidate branch" }] },
        { contains: { title: "candidate item" } },
        { patternProperties: { "^x": { title: "candidate key" } } },
        { additionalProperties: true },
      ] as const
    ) {
      const candidate = {
        $ref: "#/$defs/C0",
        $defs: {
          C0: {
            type: "object",
            properties: { next: { $ref: "#/$defs/C1" } },
          },
          C1: { $ref: "#/$defs/C0", ...aliasSiblings },
        },
      } as const;

      let merged = mergeCfcSchemaEnvelopes(
        existing,
        candidate,
      ) as JSONSchemaObj;
      const stable = merged;
      for (let iteration = 0; iteration < 4; iteration++) {
        merged = mergeCfcSchemaEnvelopes(merged, candidate) as JSONSchemaObj;
        expect(
          merged,
          `nested recursive alias changed for ${Object.keys(aliasSiblings)[0]}`,
        ).toEqual(stable);
      }
      if ("title" in aliasSiblings) {
        const storedWithRule = {
          ...stable,
          allOf: [{ $ref: "#/$defs/Rule" }],
          $defs: { ...stable.$defs, Rule: { type: "string" } },
        } as const;
        const candidateWithRule = {
          ...candidate,
          allOf: [{ $ref: "#/$defs/Rule" }],
          $defs: { ...candidate.$defs, Rule: { type: "boolean" } },
        } as const;

        expect(
          mergeCfcSchemaEnvelopes(storedWithRule, candidateWithRule),
        ).not.toEqual(storedWithRule);
      }
    }
  });

  it("uses an authorized scalar type throughout a recursive target", () => {
    const recursive = (valueType: "string" | "number") => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: valueType },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const);

    const merged = mergeCfcSchemaEnvelopes(
      recursive("string"),
      recursive("number"),
      { allowIncompatibleScalarTypes: true },
    ) as JSONSchemaObj;
    const next = merged.properties?.next as JSONSchemaObj;
    const recursiveTarget = merged.$defs?.__cfc_merged_ref_0 as JSONSchemaObj;

    expect((merged.properties?.value as JSONSchemaObj).type).toBe("number");
    expect(next.$ref).toBe("#/$defs/__cfc_merged_ref_0");
    expect((recursiveTarget.properties?.value as JSONSchemaObj).type).toBe(
      "number",
    );
  });

  it("keeps recursive definition scopes stable across repeated merges", () => {
    const existing = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const candidate = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: {
              $ref: "#/$defs/Node",
              ifc: { confidentiality: ["nested"] },
            },
          },
        },
      },
    } as const;

    const once = mergeCfcSchemaEnvelopes(existing, candidate);
    const twice = mergeCfcSchemaEnvelopes(once, candidate);
    const threeTimes = mergeCfcSchemaEnvelopes(twice, candidate);
    const fourTimes = mergeCfcSchemaEnvelopes(threeTimes, candidate);

    expect(threeTimes).toEqual(twice);
    expect(fourTimes).toEqual(twice);
    expect(
      cfcSchemaEntries(fourTimes).map(({ path, label }) => ({
        path,
        confidentiality: label.confidentiality,
      })),
    ).toContainEqual({
      path: ["next"],
      confidentiality: ["nested"],
    });
  });

  it("does not reclassify recursive target requirements on remerge", () => {
    const recursive = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
    } as const;

    const once = mergeCfcSchemaEnvelopes(recursive, recursive);
    expect(() => mergeCfcSchemaEnvelopes(once, recursive)).not.toThrow();
  });

  it("finds stored defaults through a recursive reference carrier", () => {
    const base = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string", default: "old" },
            next: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as const;
    const policy = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: {
              $ref: "#/$defs/Node",
              ifc: { confidentiality: ["nested"] },
            },
          },
        },
      },
    } as const;
    const required = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: {
              $ref: "#/$defs/Node",
              required: ["value"],
            },
          },
        },
      },
    } as const;

    const withPolicy = mergeCfcSchemaEnvelopes(base, policy);
    expect(() => mergeCfcSchemaEnvelopes(withPolicy, required)).not.toThrow();
  });

  it("resolves stored property defaults through a recursive carrier", () => {
    const recursive = (
      value: JSONSchemaObj,
      next: JSONSchemaObj,
    ): JSONSchemaObj => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Value" },
            next,
          },
        },
        Value: value,
      },
    });
    const base = recursive(
      { type: "string", default: "old" },
      { $ref: "#/$defs/Node" },
    );
    const policy = recursive(
      { type: "string" },
      {
        $ref: "#/$defs/Node",
        ifc: { confidentiality: ["nested"] },
      },
    );
    const required = recursive(
      { type: "string" },
      { $ref: "#/$defs/Node", required: ["value"] },
    );

    const withPolicy = mergeCfcSchemaEnvelopes(base, policy);
    expect(() => mergeCfcSchemaEnvelopes(withPolicy, required)).not.toThrow();
  });

  // C5: `observes` is a scalar consumption class, not a set-like claim.
  // Agreement keeps the class through a merge; any disagreement (including
  // one covering side) merges to covering — the widest consumption, the
  // over-taint direction (fail-safe). Dropping it on every merge would
  // silently defeat the C5 narrowing on the common re-write path.
  it("keeps observes when both sides agree", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        rows: {
          type: "string",
          ifc: { confidentiality: ["a"], observes: "value" },
        },
      },
    }, {
      type: "object",
      properties: {
        rows: {
          type: "string",
          ifc: { confidentiality: ["a"], observes: "value" },
        },
      },
    }) as JSONSchemaObj;
    const rows = (merged.properties as Record<string, JSONSchemaObj>).rows;
    expect((rows.ifc as { observes?: string }).observes).toBe("value");
  });

  it("merges disagreeing observes to covering", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        rows: {
          type: "string",
          ifc: { confidentiality: ["a"], observes: "value" },
        },
      },
    }, {
      type: "object",
      properties: {
        rows: { type: "string", ifc: { confidentiality: ["a"] } },
      },
    }) as JSONSchemaObj;
    const rows = (merged.properties as Record<string, JSONSchemaObj>).rows;
    expect((rows.ifc as { observes?: string }).observes).toBeUndefined();
  });

  it("allows additive required fields when a default preserves old documents", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
        title: {
          type: "string",
          default: "",
        },
      },
      required: ["secret", "title"],
    });

    const mergedObject = merged as JSONSchemaObj;
    expect(mergedObject.properties?.title).toMatchObject({
      type: "string",
      default: "",
    });
    expect(mergedObject.required).toEqual(["secret", "title"]);
  });

  it("keeps referenced required fields when siblings are undefined", () => {
    const requiredObject = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const;
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/RequiredObject",
          required: undefined,
          $defs: { RequiredObject: requiredObject },
        },
      },
    }, {
      type: "object",
      properties: { nested: requiredObject },
    }) as JSONSchemaObj;

    expect(
      (merged.properties?.nested as JSONSchemaObj).required,
    ).toEqual(["value"]);
  });

  it("compares required fields through each side's definition scope", () => {
    const requiredObject = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const;
    const merged = mergeCfcSchemaEnvelopes({
      $defs: { RequiredObject: requiredObject },
      type: "object",
      properties: { nested: { $ref: "#/$defs/RequiredObject" } },
    }, {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/RequiredObject",
          $defs: { RequiredObject: requiredObject },
          ...requiredObject,
        },
      },
    }) as JSONSchemaObj;

    expect(
      (merged.properties?.nested as JSONSchemaObj).required,
    ).toEqual(["value"]);
  });

  it("accepts a referenced required field with a referenced default", () => {
    const merged = mergeCfcSchemaEnvelopes({
      $defs: {
        Value: { type: "object", properties: {} },
      },
      $ref: "#/$defs/Value",
    }, {
      $defs: {
        Value: {
          type: "object",
          properties: { value: { type: "string", default: "ready" } },
          required: ["value"],
        },
      },
      $ref: "#/$defs/Value",
    }) as JSONSchemaObj;

    expect(merged.required).toEqual(["value"]);
  });

  it("rejects additive required fields without a default", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      }, {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          title: {
            type: "string",
          },
        },
        required: ["secret", "title"],
      })
    ).toThrow(/required field.*default/i);
  });

  it("allows additive required fields anywhere in a generated result document", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: { type: "string" },
        meta: {
          type: "object",
          properties: { existing: { type: "string" } },
          required: ["existing"],
        },
      },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: { type: "string" },
        meta: {
          type: "object",
          properties: {
            existing: { type: "string" },
            generated: { type: "string" },
          },
          required: ["existing", "generated"],
        },
      },
      required: ["secret", "meta"],
    }, { generatedOutputPaths: [[]] }) as JSONSchemaObj;
    expect(merged.required).toEqual(["secret", "meta"]);
    expect((merged.properties?.meta as JSONSchemaObj).required).toEqual([
      "existing",
      "generated",
    ]);
  });

  it("does not infer output role from the value's stream capability", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { secret: { type: "string" } },
        required: ["secret"],
      }, {
        type: "object",
        properties: {
          secret: { type: "string" },
          evt: {
            type: "object",
            asCell: [{ kind: "stream", scope: "user" }],
          },
        },
        required: ["secret", "evt"],
      })
    ).toThrow(/required field.*default/i);
  });

  it("scopes the generated-output exemption to the declared path", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          generated: { type: "object", properties: {} },
          retained: { type: "object", properties: {} },
        },
      }, {
        type: "object",
        properties: {
          generated: {
            type: "object",
            properties: { output: { type: "string" } },
            required: ["output"],
          },
          retained: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      }, { generatedOutputPaths: [["generated"]] })
    ).toThrow(/required field input needs a default/i);

    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        generated: { type: "object", properties: {} },
      },
    }, {
      type: "object",
      properties: {
        generated: {
          type: "object",
          properties: { output: { type: "string" } },
          required: ["output"],
        },
      },
    }, { generatedOutputPaths: [["generated"]] }) as JSONSchemaObj;
    expect(
      (merged.properties?.generated as JSONSchemaObj).required,
    ).toEqual(["output"]);
  });

  it("rejects weakened ifc constraints", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { maxConfidentiality: ["secret"] },
          },
        },
      }, {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { maxConfidentiality: ["secret", "internal"] },
          },
        },
      })
    ).toThrow(/maxConfidentiality/i);
  });

  it("merges compatible set-like ifc labels", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: {
            confidentiality: ["secret"],
            addIntegrity: ["reviewed"],
            requiredIntegrity: ["trusted"],
            integrity: ["trusted", "narrow"],
            maxConfidentiality: ["internal", "public"],
          },
        },
      },
    }, {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: {
            confidentiality: ["secret", "internal"],
            addIntegrity: ["reviewed", "audited"],
            requiredIntegrity: ["trusted", "operator"],
            integrity: ["trusted"],
            maxConfidentiality: ["internal"],
          },
        },
      },
    });

    const ifc = (
      (merged as JSONSchemaObj).properties?.secret as JSONSchemaObj
    ).ifc;
    expect(ifc?.confidentiality).toEqual(["secret", "internal"]);
    expect(ifc?.addIntegrity).toEqual(["reviewed", "audited"]);
    expect(ifc?.requiredIntegrity).toEqual(["trusted", "operator"]);
    expect(ifc?.integrity).toEqual(["trusted"]);
    expect(ifc?.maxConfidentiality).toEqual(["internal"]);
  });

  it("rejects unstable scalar ifc labels", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { ownerPrincipal: "did:key:one" },
      }, {
        ifc: { ownerPrincipal: "did:key:two" },
      })
    ).toThrow(/ownerPrincipal must remain stable/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { confidentiality: "secret" } as any,
      }, {
        ifc: { confidentiality: "internal" } as any,
      })
    ).toThrow(/confidentiality must remain stable/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { writeAuthorizedBy: { notAClaim: true } } as any,
      }, {
        ifc: { writeAuthorizedBy: { notAClaim: false } } as any,
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("preserves stable copy and projection ifc metadata", () => {
    const stableIfc = {
      exactCopyOf: { source: "of:source" },
      projection: { path: ["value"] },
      collection: { id: "collection" },
      ownerPrincipal: "did:key:owner",
      flowPrecisionClaim: { path: ["legacy"] },
    };

    const merged = mergeCfcSchemaEnvelopes({
      ifc: stableIfc as any,
    }, {
      ifc: stableIfc as any,
    });

    expect((merged as JSONSchemaObj).ifc).toMatchObject(stableIfc);
  });

  it("preserves equal scalar ifc labels", () => {
    const claim = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["save"],
      },
    };

    const merged = mergeCfcSchemaEnvelopes({
      ifc: {
        confidentiality: "secret",
        writeAuthorizedBy: claim,
      } as any,
    }, {
      ifc: {
        confidentiality: "secret",
        writeAuthorizedBy: claim,
      } as any,
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toBe("secret");
    expect((merged as JSONSchemaObj).ifc?.writeAuthorizedBy).toEqual(claim);
  });

  it("preserves existing ifc when the candidate has none", () => {
    const merged = mergeCfcSchemaEnvelopes({
      ifc: { confidentiality: ["secret"] },
    }, {
      type: "object",
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toEqual(["secret"]);
  });

  it("rejects incompatible schema forms and types", () => {
    expect(() => mergeCfcSchemaEnvelopes(false, {})).toThrow(
      /unsupported schema form/,
    );

    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "string",
      }, {
        type: "number",
      })
    ).toThrow(/type changed incompatibly/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: ["string", "number"],
      }, {
        type: ["string", "boolean"],
      })
    ).toThrow(/type changed incompatibly/);
  });

  it("keeps concrete types beside permissive unknown schemas", () => {
    const existing = {
      type: "array",
      items: { type: "string" },
    } as const;
    const wrapper = {
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
    } as const;
    const merged = mergeCfcSchemaEnvelopes(existing, wrapper, {
      generatedOutputPaths: [[]],
    }) as JSONSchemaObj;
    expect(merged.items).toMatchObject({
      type: "string",
      asCell: ["cell"],
    });
    expect(
      mergeCfcSchemaEnvelopes(existing, wrapper),
    ).toEqual(merged);
    expect(
      mergeCfcSchemaEnvelopes(existing, {
        type: "array",
        items: { type: "unknown" },
      }),
    ).toMatchObject({ items: { type: "string" } });
    expect(
      mergeCfcSchemaEnvelopes({ type: "unknown" }, { type: "object" }),
    ).toMatchObject({ type: "object" });
    expect(
      mergeCfcSchemaEnvelopes(
        { type: "string" },
        { type: ["unknown", "number"] },
      ),
    ).toMatchObject({ type: "string" });
    expect(
      mergeCfcSchemaEnvelopes(
        { type: ["unknown", "string"] },
        { type: "object" },
      ),
    ).toMatchObject({ type: "object" });
  });
  it("matches concrete generated array items to wildcard schema paths", () => {
    const existing = {
      type: "array",
      items: { type: "object", properties: {} },
    } as const;
    const generated = {
      type: "array",
      items: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    } as const;

    expect(
      mergeCfcSchemaEnvelopes(existing, generated, {
        generatedOutputPaths: [["0"]],
      }),
    ).toMatchObject({
      type: "array",
      items: { required: ["value"] },
    });
    expect(() =>
      mergeCfcSchemaEnvelopes(existing, generated, {
        generatedOutputPaths: [["item"]],
      })
    ).toThrow(/required field value needs a default/);
  });

  it("removes minted integrity only for a source schema migration", () => {
    const existing = {
      type: "object",
      properties: {
        value: {
          type: "string",
          ifc: { addIntegrity: ["reviewed", "verified"] },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        value: {
          type: "string",
          ifc: { addIntegrity: ["reviewed"] },
        },
      },
    } as const;
    expect(() => mergeCfcSchemaEnvelopes(existing, candidate)).toThrow(
      /addIntegrity cannot be weakened/,
    );
    const reduced = mergeCfcSchemaEnvelopes(existing, candidate, {
      allowAddIntegrityWeakening: true,
    }) as JSONSchemaObj;
    expect(
      (reduced.properties?.value as JSONSchemaObj).ifc?.addIntegrity,
    ).toEqual(["reviewed"]);

    const removed = mergeCfcSchemaEnvelopes(existing, {
      type: "object",
      properties: { value: { type: "string" } },
    }, {
      allowAddIntegrityWeakening: true,
    }) as JSONSchemaObj;
    expect((removed.properties?.value as JSONSchemaObj).ifc).toEqual({});
  });

  it("accepts a confirmed scalar type change without weakening policy", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "string",
      ifc: { confidentiality: ["existing"] },
    }, {
      type: "number",
      ifc: { integrity: ["candidate"] },
    }, {
      allowIncompatibleScalarTypes: true,
    }) as JSONSchemaObj;

    expect(merged.type).toBe("number");
    expect(merged.ifc).toEqual({
      confidentiality: ["existing"],
      integrity: ["candidate"],
    });
    expect(() =>
      mergeCfcSchemaEnvelopes({ type: "object" }, { type: "string" }, {
        allowIncompatibleScalarTypes: true,
      })
    ).toThrow(/type changed incompatibly/);
  });

  it("finds a result scalar change beside a generated required field", () => {
    const existing = {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    } as const;
    const candidate = {
      type: "object",
      properties: {
        label: { type: "number" },
        added: { type: "string" },
      },
      required: ["label", "added"],
    } as const;

    expect(cfcScalarTypeTransitions(existing, candidate)).toBeUndefined();
    expect(cfcScalarTypeTransitions(existing, candidate, [[]])).toEqual([{
      path: ["label"],
      storedTypes: ["string"],
      candidateTypes: ["number"],
    }]);
  });

  it("merges item schemas and object defaults", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        default: { title: "Untitled" },
      },
    }, {
      type: "array",
      items: {
        type: "object",
        properties: {
          done: { type: "boolean" },
        },
        default: { done: false },
      },
    });

    const items = (merged as JSONSchemaObj).items as JSONSchemaObj;
    expect(items.properties).toMatchObject({
      title: { type: "string" },
      done: { type: "boolean" },
    });
    expect(items.default).toEqual({
      title: "Untitled",
      done: false,
    });
  });

  it("preserves special-object defaults atomically", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const hash = new FabricHash(new Uint8Array([4, 5, 6]), "test");
    const merged = mergeCfcSchemaEnvelopes(
      { default: bytes } as unknown as JSONSchema,
      { default: hash } as unknown as JSONSchema,
    ) as JSONSchemaObj;

    expect(merged.default).toBe(hash);
    expect(storedSchemaCoversCandidateEnvelope(
      { default: bytes } as unknown as JSONSchema,
      { default: hash } as unknown as JSONSchema,
    )).toBe(false);
  });

  it("merges tuple (prefixItems) slots slot-wise", () => {
    // CT-1895: the {...left, ...right} spread let one side's prefixItems
    // win wholesale, dropping the other side's slot ifc/defaults.
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [
        {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
        { type: "number" },
      ],
    }, {
      type: "array",
      prefixItems: [
        { type: "string", default: "cmd" },
        { type: "number" },
      ],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    // Slot 0 carries BOTH sides' contributions: the existing ifc and the
    // candidate default.
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["secret"]);
    expect(slots[0].default).toBe("cmd");
  });

  it("keeps slots only one side declares", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [{ type: "string", ifc: { confidentiality: ["secret"] } }],
    }, {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number", default: 3 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect(slots.length).toBe(2);
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["secret"]);
    expect(slots[1]).toEqual({ type: "number", default: 3 });
  });

  it("merges a rest items claim into the other side's extra tuple slots", () => {
    // 2020-12: a side's `items` speaks for every index past its slots — so
    // its claim about index 1 must land in the longer side's slot 1, not be
    // silently reinterpreted as "indices >= 2" by the merged arity.
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number", ifc: { confidentiality: ["x"] } },
    }, {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number", default: 3 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect((slots[1].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(slots[1].default).toBe(3);
    // The rest claim itself survives for indices past all slots.
    const items = (merged as JSONSchemaObj).items as JSONSchemaObj;
    expect((items.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
  });

  it("merges an items-only side into a side introducing prefixItems", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      items: { type: "number", ifc: { confidentiality: ["x"] } },
    }, {
      type: "array",
      prefixItems: [{ type: "number", default: 1 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(slots[0].default).toBe(1);
  });

  it("merges a rest additionalProperties claim into the other side's named keys", () => {
    // The record twin of the items/prefixItems rule: an object-valued
    // additionalProperties speaks for every undeclared key, so its claim
    // merges into keys only the other side names.
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    }, {
      type: "object",
      properties: { name: { type: "string", default: "d" } },
    });

    const props = (merged as JSONSchemaObj).properties as Record<
      string,
      JSONSchemaObj
    >;
    expect((props.name.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(props.name.default).toBe("d");
    // The rest claim itself survives for undeclared keys.
    const additional = (merged as JSONSchemaObj)
      .additionalProperties as JSONSchemaObj;
    expect((additional.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
  });

  it('keeps a property legitimately named "__proto__" through the merge', () => {
    // Regression pin for a PR #4969 review claim that did NOT reproduce:
    // in V8/Deno a computed store with a "__proto__" key creates an own
    // data property (verified by probe), so the merge preserves this valid
    // JSON key end-to-end. Pinned so an engine or refactor change that
    // breaks the assumption is caught.
    const left = {
      type: "object",
      properties: JSON.parse(
        '{"__proto__": {"type": "string", "ifc": {"confidentiality": ["x"]}}}',
      ),
    } as JSONSchemaObj;
    const right = {
      type: "object",
      properties: JSON.parse(
        '{"__proto__": {"type": "string", "default": "d"}}',
      ),
    } as JSONSchemaObj;

    const merged = mergeCfcSchemaEnvelopes(left, right) as JSONSchemaObj;
    const props = merged.properties as Record<string, JSONSchemaObj>;
    expect(Object.hasOwn(props, "__proto__")).toBe(true);
    const proto = Object.getOwnPropertyDescriptor(props, "__proto__")!
      .value as JSONSchemaObj;
    expect((proto.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(proto.default).toBe("d");
  });

  it("keeps the candidate's boolean additionalProperties via the spread", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    });
    expect((merged as JSONSchemaObj).additionalProperties).toBe(true);
  });

  it("merges object-valued additionalProperties from both sides", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    }, {
      type: "object",
      additionalProperties: { type: "string", default: "d" },
    });

    const additional = (merged as JSONSchemaObj)
      .additionalProperties as JSONSchemaObj;
    expect((additional.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(additional.default).toBe("d");
  });

  it("keeps candidate items when only the candidate declares them", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
    }, {
      type: "array",
      items: { type: "string" },
    });

    expect((merged as JSONSchemaObj).items).toEqual({ type: "string" });
  });

  it("preserves uiContract metadata when merging schema envelopes", () => {
    const uiContract = {
      helper: "UiAction",
      action: "SubmitDirectCommand",
      trustedPattern: "TrustedDirectCommandSurface",
      requiredEventIntegrity: ["TrustedDirectCommandSurface"],
    } as const;

    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        savedTitle: {
          type: "string",
          ifc: { uiContract },
        },
      },
    }, {
      type: "object",
      properties: {
        savedTitle: {
          type: "string",
          ifc: { uiContract },
        },
      },
    });

    const mergedObject = merged as JSONSchemaObj;
    expect(
      (mergedObject.properties?.savedTitle as JSONSchemaObj).ifc?.uiContract,
    ).toEqual(uiContract);
  });

  it("rejects branch-local ifc labels in divergent schemas", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
          },
        },
      }, {
        anyOf: [
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { confidentiality: ["secret"] },
              },
            },
          },
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
              },
            },
          },
        ],
      })
    ).toThrow(/divergent.*ifc|ifc.*divergent/i);
  });

  it("accepts a defaulted concrete projection of an empty-or-value union", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        anyOf: [
          { type: "object", properties: {}, additionalProperties: false },
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                ifc: { requiredIntegrity: ["admin"] },
              },
            },
          },
        ],
      }, {
        type: "object",
        properties: {
          list: {
            type: "array",
            ifc: { requiredIntegrity: ["admin"] },
          },
        },
        default: {},
      })
    ).not.toThrow();
  });

  it("accepts nested policy added to a defaulted union projection", () => {
    const stored = {
      type: "object",
      properties: {
        list: { $ref: "#/$defs/StoredList" },
      },
      default: {},
      $defs: {
        StoredList: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
    } as const;
    const candidate = {
      anyOf: [
        { type: "object", properties: {}, additionalProperties: false },
        {
          type: "object",
          properties: {
            list: { $ref: "#/$defs/CandidateList" },
          },
        },
      ],
      $defs: {
        CandidateList: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "string" } },
            ifc: { addIntegrity: ["admin"] },
          },
        },
      },
    } as const;

    expect(() => mergeCfcSchemaEnvelopes(stored, candidate)).not.toThrow();
  });

  it("rejects policy on the empty branch of a defaulted projection", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        anyOf: [
          {
            type: "object",
            properties: {},
            additionalProperties: false,
            ifc: { confidentiality: ["secret"] },
          },
          {
            type: "object",
            properties: { list: { type: "array" } },
          },
        ],
      }, {
        type: "object",
        properties: { list: { type: "array" } },
        default: {},
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("merges matching closed-empty unions independent of branch order", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [
        { $ref: "#/$defs/StoredValue" },
        { type: "object", properties: {}, additionalProperties: false },
      ],
      $defs: {
        StoredValue: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: { type: "string" },
              ifc: { requiredIntegrity: ["admin"] },
            },
          },
        },
      },
    }, {
      anyOf: [
        { type: "object", properties: {}, additionalProperties: false },
        { $ref: "#/$defs/TrustedValue" },
      ],
      $defs: {
        TrustedValue: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: {
                type: "string",
                ifc: { addIntegrity: ["admin"] },
              },
              ifc: { requiredIntegrity: ["admin"] },
            },
          },
        },
      },
    });
    const mergedAgain = mergeCfcSchemaEnvelopes(merged, merged);
    const emptyBranch = (merged as JSONSchemaObj).anyOf?.[1];

    expect(emptyBranch).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(
      cfcSchemaEntries(merged).map(({ path, schema }) => ({
        path,
        requiredIntegrity: typeof schema === "object" && schema !== null
          ? schema.ifc?.requiredIntegrity
          : undefined,
        addIntegrity: typeof schema === "object" && schema !== null
          ? schema.ifc?.addIntegrity
          : undefined,
      })),
    ).toEqual([
      {
        path: ["list"],
        requiredIntegrity: ["admin"],
        addIntegrity: undefined,
      },
      {
        path: ["list", "*"],
        requiredIntegrity: undefined,
        addIntegrity: ["admin"],
      },
    ]);
    expect(mergedAgain).toEqual(merged);
  });

  it("does not treat a constrained object as the empty-union branch", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [
        { $ref: "#/$defs/StoredValue" },
        { type: "object", properties: {}, additionalProperties: false },
      ],
      $defs: {
        StoredValue: {
          type: "object",
          properties: { list: { type: "array" } },
        },
      },
    }, {
      anyOf: [
        {
          type: "object",
          properties: {},
          additionalProperties: false,
          minProperties: 1,
        },
        { $ref: "#/$defs/TrustedValue" },
      ],
      $defs: {
        TrustedValue: {
          type: "object",
          properties: { list: { type: "array" } },
        },
      },
    }) as JSONSchemaObj;

    expect(merged.anyOf?.[0]).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
      minProperties: 1,
    });
  });

  it("rejects changed policy in a defaulted empty-or-value union", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        anyOf: [
          { type: "object", properties: {}, additionalProperties: false },
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                ifc: { addIntegrity: ["admin"] },
              },
            },
          },
        ],
        default: {},
      }, {
        anyOf: [
          { type: "object", properties: {}, additionalProperties: false },
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                ifc: { addIntegrity: ["attacker"] },
              },
            },
          },
        ],
      })
    ).toThrow(/addIntegrity cannot be weakened/);
  });

  it("retains equal branch-local policy while siblings change", () => {
    const valueSpecificPolicy = {
      anyOf: [
        {
          type: "boolean",
          const: true,
          ifc: { addIntegrity: ["admin"] },
        },
        { type: "boolean", const: false },
      ],
    } as const;
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { everyoneIsAdmin: valueSpecificPolicy },
    }, {
      type: "object",
      properties: {
        everyoneIsAdmin: valueSpecificPolicy,
        importedMessages: { type: "array" },
      },
    }) as JSONSchemaObj;

    expect(merged.properties?.everyoneIsAdmin).toEqual(valueSpecificPolicy);
    expect(merged.properties?.importedMessages).toEqual({ type: "array" });
  });

  it("retains equal branches while adding policy beside the union", () => {
    const branches = [
      {
        type: "boolean",
        const: true,
        ifc: { addIntegrity: ["admin"] },
      },
      { type: "boolean", const: false },
    ] as const satisfies readonly JSONSchema[];
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: branches,
      asCell: ["cell"],
    }, {
      anyOf: branches,
      ifc: { confidentiality: ["space"] },
    }) as JSONSchemaObj;

    expect(merged.anyOf).toEqual(branches);
    expect(merged.ifc?.confidentiality).toEqual(["space"]);
  });

  it("retains branch policy across cell materialization markers", () => {
    const branch = (asCell: boolean): JSONSchema => ({
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { const: "trusted" },
            author: {
              type: "object",
              ...(asCell ? { asCell: ["cell"] } : {}),
            },
          },
          required: ["kind", "author"],
          ifc: { addIntegrity: ["trusted"] },
        },
        {
          type: "object",
          properties: { kind: { const: "plain" } },
          required: ["kind"],
        },
      ],
    });

    expect(() => mergeCfcSchemaEnvelopes(branch(true), branch(false)))
      .not.toThrow();
  });

  it("retains one-sided branch-local policy without merging it", () => {
    const valueSpecificPolicy = {
      anyOf: [
        {
          type: "boolean",
          const: true,
          ifc: { addIntegrity: ["admin"] },
        },
        { type: "boolean", const: false },
      ],
    } as const;
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { messages: { type: "array" } },
    }, {
      type: "object",
      properties: { everyoneIsAdmin: valueSpecificPolicy },
    }) as JSONSchemaObj;

    expect(merged.properties?.everyoneIsAdmin).toEqual(valueSpecificPolicy);
    expect(merged.properties?.messages).toEqual({ type: "array" });
  });

  it("rejects branch-policy changes hidden behind local references", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: {
          Value: {
            anyOf: [
              {
                type: "string",
                ifc: { confidentiality: ["secret"] },
              },
              { type: "number" },
            ],
          },
        },
      }, {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: {
          Value: {
            anyOf: [
              { type: "string" },
              {
                type: "number",
                ifc: { confidentiality: ["secret"] },
              },
            ],
          },
        },
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("rejects changed policy directly behind alternative references", () => {
    const schema = (atom: string): JSONSchema => ({
      anyOf: [
        { $ref: "#/$defs/Protected" },
        { type: "number" },
      ],
      $defs: {
        Protected: {
          type: "string",
          ifc: { addIntegrity: [atom] },
        },
      },
    });

    expect(() => mergeCfcSchemaEnvelopes(schema("x"), schema("y")))
      .toThrow(/divergent anyOf branches/);
  });

  it("rejects changed policy behind nested alternative references", () => {
    const schema = (atom: string): JSONSchema => ({
      anyOf: [
        { $ref: "#/$defs/Wrapper" },
        { type: "number" },
      ],
      $defs: {
        Wrapper: {
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Protected" },
          },
        },
        Protected: {
          type: "string",
          ifc: { addIntegrity: [atom] },
        },
      },
    });

    expect(() => mergeCfcSchemaEnvelopes(schema("x"), schema("y")))
      .toThrow(/divergent anyOf branches/);
  });

  it("rejects changed policy behind recursive alternative references", () => {
    const schema = (atom: string): JSONSchema => ({
      anyOf: [
        { $ref: "#/$defs/Node" },
        { type: "number" },
      ],
      $defs: {
        Node: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
          },
          ifc: { addIntegrity: [atom] },
        },
      },
    });

    expect(() => mergeCfcSchemaEnvelopes(schema("x"), schema("y")))
      .toThrow(/divergent anyOf branches/);
  });

  it("checks inherited references inside equal wrapper schemas", () => {
    const wrapper = {
      type: "object",
      properties: {
        nested: { $ref: "#/$defs/Value" },
      },
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { wrapper },
        $defs: {
          Value: {
            anyOf: [
              {
                type: "string",
                ifc: { confidentiality: ["secret"] },
              },
              { type: "number" },
            ],
          },
        },
      }, {
        type: "object",
        properties: { wrapper },
        $defs: {
          Value: {
            anyOf: [
              { type: "string" },
              {
                type: "number",
                ifc: { confidentiality: ["secret"] },
              },
            ],
          },
        },
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("retains equal referenced branch policy while definitions grow", () => {
    const branchPolicy = {
      anyOf: [
        {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
        { type: "number" },
      ],
    } as const;
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: { Value: branchPolicy },
    }, {
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: {
        Value: {
          anyOf: [
            { ...branchPolicy.anyOf[0], default: undefined },
            branchPolicy.anyOf[1],
          ],
        },
        Unrelated: { type: "boolean" },
      },
    }) as JSONSchemaObj;

    expect(merged.properties?.value).toEqual(branchPolicy);
  });

  it("accepts renamed references in equal recursive branch policy", () => {
    const recursiveBranchPolicy = (name: string): JSONSchemaObj => ({
      $ref: `#/$defs/${name}`,
      $defs: {
        [name]: {
          anyOf: [
            {
              type: "object",
              properties: {
                next: { $ref: `#/$defs/${name}` },
              },
              ifc: { confidentiality: ["secret"] },
            },
            { type: "null" },
          ],
        },
      },
    });

    expect(() =>
      mergeCfcSchemaEnvelopes(
        recursiveBranchPolicy("StoredNode"),
        recursiveBranchPolicy("CandidateNode"),
      )
    ).not.toThrow();
  });

  it("checks branch-local policy against an object rest claim", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        additionalProperties: { type: "boolean" },
      }, {
        type: "object",
        properties: {
          everyoneIsAdmin: {
            anyOf: [
              {
                type: "boolean",
                const: true,
                ifc: { addIntegrity: ["admin"] },
              },
              { type: "boolean", const: false },
            ],
          },
        },
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("checks branch-local tuple policy against an array rest claim", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "array",
        items: { type: "boolean" },
      }, {
        type: "array",
        prefixItems: [{
          anyOf: [
            {
              type: "boolean",
              const: true,
              ifc: { addIntegrity: ["admin"] },
            },
            { type: "boolean", const: false },
          ],
        }],
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("allows branch-external ifc labels beside divergent schemas", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
      ifc: { confidentiality: ["secret"] },
    }, {
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
      ifc: { confidentiality: ["secret"] },
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toEqual(["secret"]);
  });

  it("rejects nested divergent branches with local ifc labels", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "array",
        items: {
          oneOf: [
            {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            { type: "number", minimum: 0 },
          ],
        },
      }, {
        type: "array",
        items: {
          oneOf: [
            {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            { type: "number" },
          ],
        },
      })
    ).toThrow(/divergent oneOf branches/);
  });

  it("rejects divergent branches with policy under conditional keywords", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        anyOf: [
          {
            type: "string",
            if: {
              type: "string",
              ifc: { addIntegrity: ["admin"] },
            },
          },
          { type: "number" },
        ],
      }, {
        anyOf: [
          { type: "boolean" },
          { type: "number" },
        ],
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("rejects divergent ifc branches nested under a tuple slot", () => {
    // CT-1895: the guard's recursion visited only properties and items, so
    // a divergent-ifc shape under a prefixItems slot escaped it.
    const withTupleBranches = {
      type: "array",
      prefixItems: [{
        oneOf: [
          { type: "string", ifc: { confidentiality: ["secret"] } },
          { type: "number" },
        ],
      }],
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(withTupleBranches, {
        type: "array",
        prefixItems: [{
          oneOf: [
            { type: "string", ifc: { confidentiality: ["secret"] } },
            { type: "number", minimum: 0 },
          ],
        }],
      })
    ).toThrow(/divergent oneOf branches/);
  });

  it("rejects divergent ifc branches nested under additionalProperties", () => {
    const withMapBranches = {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "string", ifc: { confidentiality: ["secret"] } },
          { type: "number" },
        ],
      },
    } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(withMapBranches, {
        type: "object",
        additionalProperties: {
          anyOf: [
            { type: "string", ifc: { confidentiality: ["secret"] } },
            { type: "number", minimum: 0 },
          ],
        },
      })
    ).toThrow(/divergent anyOf branches/);
  });

  it("allows non-object divergent branches without ifc labels", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [true, { type: "string" }],
    }, {
      anyOf: [true, { type: "string" }],
    });

    expect((merged as JSONSchemaObj).anyOf).toEqual([
      true,
      { type: "string" },
    ]);
  });

  it("merges writeAuthorizedBy claims that differ only by the identity stamp", () => {
    // Within one transaction the same protected field can be written through
    // two schema inputs: one recorded under a verified identity (its claim is
    // rebound with the identity's `moduleIdentity`) and one under no identity
    // (claim stays unstamped). The binding (file + path) is identical; only the
    // provenance stamp differs. The merge must keep the stamped claim rather
    // than reject the commit — the same tolerance prepare's
    // schemasEqualIgnoringWriterStamp applies elsewhere (regression:
    // "writeAuthorizedBy must remain stable at /elements" on every profile
    // element write, CT-1698).
    const unstamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
      },
    };
    const stamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        moduleIdentity: "module-identity-hash",
      },
    };

    for (
      const [left, right] of [[stamped, unstamped], [unstamped, stamped]]
    ) {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: left },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: right },
          },
        },
      });

      expect(
        (
          (merged as JSONSchemaObj).properties?.elements as JSONSchemaObj
        ).ifc?.writeAuthorizedBy,
      ).toEqual(stamped);
    }
  });

  it("strips a legacy bundleId stamp from pre-migration claims", () => {
    // Backward compat: a pre-migration claim may carry a legacy `bundleId`
    // (alongside, or instead of, `moduleIdentity`). `bundleId` is inert under
    // verification (which reads `moduleIdentity`), but reconciliation must
    // still strip it before comparing — otherwise a surviving `bundleId` on
    // one side manufactures a false conflict and rejects an otherwise-matching
    // protected write with "writeAuthorizedBy must remain stable".
    const unstamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
      },
    };
    const legacyStamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        bundleId: "fid1:bundle",
        moduleIdentity: "module-identity-hash",
      },
    };

    for (
      const [left, right] of [
        [legacyStamped, unstamped],
        [unstamped, legacyStamped],
      ]
    ) {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: left },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: right },
          },
        },
      });

      expect(
        (
          (merged as JSONSchemaObj).properties?.elements as JSONSchemaObj
        ).ifc?.writeAuthorizedBy,
      ).toEqual(legacyStamped);
    }
  });

  it("keeps the stored stamp when identity stamps conflict (version boundary, no rotation)", () => {
    // Same binding, two different stamps: a version boundary, not a merge
    // conflict. Claims are minted born stamped, so a republished module
    // re-presents this binding under its new moduleIdentity on every
    // envelope write — the stored stamp wins (never rotated; the new
    // version's field writes stay fail-closed at verification pending
    // setsrc-history delegation) and the envelope's sibling writes keep
    // committing instead of aborting the whole transaction.
    const claimFor = (moduleIdentity: string) => ({
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        moduleIdentity,
      },
    });
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        elements: {
          type: "array",
          ifc: { writeAuthorizedBy: claimFor("fid1:left") },
        },
      },
    }, {
      type: "object",
      properties: {
        elements: {
          type: "array",
          ifc: { writeAuthorizedBy: claimFor("fid1:right") },
        },
        displayName: { type: "string" },
      },
    });
    // deno-lint-ignore no-explicit-any
    expect((merged as any).properties.elements.ifc.writeAuthorizedBy)
      .toEqual(claimFor("fid1:left"));
    // This is the production reason for reconciling instead of aborting: the
    // candidate envelope can still contribute an unrelated sibling schema.
    // deno-lint-ignore no-explicit-any
    expect((merged as any).properties.displayName).toEqual({ type: "string" });
  });

  it("rejects writeAuthorizedBy claims with different bindings", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/system/profile-home.tsx",
                  path: ["addElement"],
                },
              },
            },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/system/profile-home.tsx",
                  path: ["removeElement"],
                },
              },
            },
          },
        },
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("rejects stamped writeAuthorizedBy claims with different bindings", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: {
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/system/profile-home.tsx",
              path: ["save"],
              moduleIdentity: "module-identity-hash",
            },
          },
        } as any,
      }, {
        ifc: {
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/system/profile-home.tsx",
              path: ["delete"],
            },
          },
        } as any,
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("treats true schema nodes as permissive when merging envelopes", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        result: true,
      },
    }, {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
          },
        },
      },
    });

    expect((merged as JSONSchemaObj).properties?.result).toMatchObject({
      type: "object",
      properties: {
        approved: { type: "boolean" },
      },
    });
  });
});

// CT-1895: the merge-skip decision judged envelopes "covered" via the items
// branch while their tuple slots differed, dropping the candidate's slot
// info instead of merging it (fail-open: coverage=true skips the merge).
describe("storedSchemaCoversCandidateEnvelope (merge-skip decision)", () => {
  it("differing tuple slots are not judged covered by matching items", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string", default: "x" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("covers slot-wise when arities are equal and slots cover", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(true);
  });

  it("fails closed on differing tuple arities (PR #4969 review)", () => {
    // With differing arities, the candidate's `items` claims positions the
    // stored side covers with slots — the shared items branch cannot
    // compare those, so coverage must fail closed and merge.
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("does not judge a candidate additionalProperties claim covered via properties alone", () => {
    // PR #4969 review: the properties branch early-returned without
    // comparing rest claims, so a candidate map-value claim was dropped
    // instead of merged.
    const stored = {
      type: "object",
      properties: { a: { type: "string" } },
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("boolean rest claims must match exactly for coverage", () => {
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: false,
    } as const;
    const covered = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    } as const;
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, covered)).toBe(true);
    expect(storedSchemaCoversCandidateEnvelope(stored, open)).toBe(false);
  });

  it("fails closed when only the candidate declares prefixItems", () => {
    const stored = {
      type: "array",
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("stored-only named properties must cover the candidate rest claim", () => {
    // PR #4969 review round 2: the candidate rest claim governs every key
    // absent from the CANDIDATE's properties — including stored-NAMED keys.
    // An unlabeled stored `b` does not cover a confidential rest claim, so
    // coverage must fail closed and merge (the earlier version of this test
    // pinned the fail-open behavior).
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("covers the rest claim when stored-only named properties carry it too", () => {
    const restClaim = {
      type: "string",
      ifc: { confidentiality: ["x"] },
    } as const;
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: restClaim },
      additionalProperties: restClaim,
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: restClaim,
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(true);
  });

  it("fails closed when the candidate declares more slots than stored", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("stored-only prefixItems fails closed — rest items do not speak for slots", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });
});

// `cfcSchemaMergeIssue` is the dry-run seam over the SAME merge: `cf piece
// setsrc --check` asks it whether a candidate envelope would be accepted
// rather than attempting the swap and taking a low-level commit rejection.
// What it must not do is reimplement the rules, so these cases pin that its
// verdict is the merge's own — including the message, verbatim.
describe("cfcSchemaMergeIssue", () => {
  it("reports no issue when the merge succeeds", () => {
    expect(cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" } },
    })).toBe(undefined);
  });

  it("discriminates the additive-required migration class", () => {
    // The class the runnability backstop rolls forward on: an old document
    // predating a now-required field that declares no default. A caller has to
    // be able to tell it apart from a hard incompatibility, because only this
    // one is recoverable.
    const issue = cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["b"],
    });
    expect(issue?.migration).toBe(true);
    expect(issue?.message).toContain("needs a default");
  });

  it("reports a weakened ifc claim as a hard incompatibility", () => {
    const issue = cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["x"] } } },
    }, {
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["y"] } } },
    });
    expect(issue?.migration).toBe(false);
    expect(issue?.message).toContain("confidentiality cannot be weakened");
  });

  it("refuses two different claims whose identity is an array", () => {
    // A claim reconciles with another only when their bindings correspond,
    // which is read from the identity's `file` and `path`. An array carries
    // neither. Different bindings conflict.
    const mergeArrayIdentities = () =>
      mergeCfcSchemaEnvelopes({
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: ["one"] },
        } as any,
      }, {
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: ["two"] },
        } as any,
      });

    expect(mergeArrayIdentities).toThrow(
      "writeAuthorizedBy must remain stable",
    );
  });
});
