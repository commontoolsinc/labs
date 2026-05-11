import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
  cfcOpaqueLinkForPath,
  joinCfcObservedConfidentiality,
  uniqueCfcAtoms,
} from "../src/cfc/mod.ts";

describe("CFC observation helpers", () => {
  it("deduplicates observed confidentiality atoms by value", () => {
    const atom = { type: "secret", source: "a" };

    expect(uniqueCfcAtoms([atom, { type: "secret", source: "a" }, "public"]))
      .toEqual([atom, "public"]);
    expect(joinCfcObservedConfidentiality([[atom], [atom], ["public"]]))
      .toEqual([atom, "public"]);
  });

  it("checks whether observed confidentiality fits an observation ceiling", () => {
    const secret = { type: "secret" };

    expect(cfcObservationFitsCeiling([], ["internal"])).toBe(true);
    expect(cfcObservationFitsCeiling(["internal"], ["internal", secret]))
      .toBe(true);
    expect(cfcObservationFitsCeiling([secret], [{ type: "secret" }]))
      .toBe(true);
    expect(cfcObservationFitsCeiling(["secret"], ["internal"])).toBe(false);
  });

  it("combines schema and label-view confidentiality for an observation node", () => {
    const result = cfcConfidentialityForObservationNode({
      schema: {
        type: "string",
        ifc: { confidentiality: ["schema-secret"] },
      },
      labelView: {
        version: 1,
        entries: [
          { path: ["body"], label: { confidentiality: ["body-secret"] } },
          { path: ["other"], label: { confidentiality: ["other-secret"] } },
        ],
      },
      logicalPath: ["body", "summary"],
    });

    expect(result).toEqual(["schema-secret", "body-secret"]);
  });

  it("builds opaque links with JSON Pointer escaping", () => {
    expect(cfcOpaqueLinkForPath("run/id", ["a/b", "~c", 2])).toEqual({
      "@link": "opaque:run%2Fid#/a~1b/~0c/2",
    });
  });
});
