import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";

describe("mergeCfcSchemaEnvelopes", () => {
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

  it("rejects writeAuthorizedBy claims with conflicting identity stamps", () => {
    const claimFor = (moduleIdentity: string) => ({
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        moduleIdentity,
      },
    });
    expect(() =>
      mergeCfcSchemaEnvelopes({
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
        },
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
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
