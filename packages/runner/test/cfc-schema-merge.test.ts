import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { storedSchemaCoversCandidateEnvelope } from "../src/cfc/prepare.ts";

describe("mergeCfcSchemaEnvelopes", () => {
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

  it("exempts an additive required STREAM slot from the default requirement", () => {
    // A stream (`asCell: ["stream"]`) is a runtime-materialized capability
    // marker, not stored document data, so an old doc that predates it has
    // nothing to preserve and no meaningful default a `Stream<…>` could carry
    // (estuary home handler streams). Additive-required WITHOUT a default is
    // therefore allowed — the pattern re-materializes the marker on every run.
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { secret: { type: "string" } },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: { type: "string" },
        evt: { type: "object", asCell: ["stream"] },
      },
      required: ["secret", "evt"],
    }) as JSONSchemaObj;
    expect(merged.required).toEqual(["secret", "evt"]);
  });

  it("exempts an additive required stream slot in the scoped-descriptor dialect", () => {
    // The outer `asCell` entry may be a `{ kind, scope }` descriptor rather than
    // a bare string; the exemption keys on the normalized KIND, so a scoped
    // stream is still a stream. A bare `.includes("stream")` missed this.
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { secret: { type: "string" } },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: { type: "string" },
        evt: { type: "object", asCell: [{ kind: "stream", scope: "user" }] },
      },
      required: ["secret", "evt"],
    }) as JSONSchemaObj;
    expect(merged.required).toEqual(["secret", "evt"]);
  });

  it("does NOT exempt an additive required CELL that merely nests a stream", () => {
    // `["cell", "stream"]` is a CELL of a stream: its IMMEDIATE outer slot is a
    // cell, so it DOES hold preservable data and an additive-required instance
    // still needs a default. The prior `asCell.includes("stream")` wrongly
    // exempted this (#4967 review, Blocking 3) — only the FIRST entry decides.
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { secret: { type: "string" } },
        required: ["secret"],
      }, {
        type: "object",
        properties: {
          secret: { type: "string" },
          nested: { type: "object", asCell: ["cell", "stream"] },
        },
        required: ["secret", "nested"],
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
            { type: "number" },
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
    expect(() => mergeCfcSchemaEnvelopes(withTupleBranches, withTupleBranches))
      .toThrow(/divergent oneOf branches/);
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
    expect(() => mergeCfcSchemaEnvelopes(withMapBranches, withMapBranches))
      .toThrow(/divergent anyOf branches/);
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
