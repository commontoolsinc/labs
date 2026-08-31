import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  parseManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import { dialSnapshot } from "./manifest.ts";
import { DIALS } from "./policy.ts";
import { sampleManifest } from "./testing.ts";

describe("manifest", () => {
  describe("dialSnapshot()", () => {
    it("records every dial, so a manifest explains its own behavior", () => {
      expect(Object.keys(dialSnapshot()).sort()).toEqual(
        DIALS.map((dial) => dial.name).sort(),
      );
    });

    it("survives the format's own validator", () => {
      const manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))?.dials).toEqual(
        dialSnapshot(),
      );
    });
  });
});
