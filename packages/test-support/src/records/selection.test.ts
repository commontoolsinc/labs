import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
} from "./selection.ts";
import { sampleManifest } from "./selection-testing.ts";

describe("selection", () => {
  describe("parseManifest()", () => {
    it("round-trips a manifest through its serialization", () => {
      const manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });

    it("returns undefined for a schema version it does not know", () => {
      const ahead = {
        ...sampleManifest(),
        schema: MANIFEST_SCHEMA_VERSION + 1,
      };
      expect(parseManifest(JSON.stringify(ahead))).toBeUndefined();
    });

    it("returns undefined rather than obeying part of a manifest", () => {
      const manifest = sampleManifest();
      // Written into the JSON rather than the object: `JSON.stringify`
      // turns a NaN into null, so a test that sets one never reaches the
      // validator with the value it meant to.
      const text = JSON.stringify(manifest).replace(
        '"cost":0.05',
        '"cost":"free"',
      );
      expect(text).toContain('"cost":"free"');
      expect(parseManifest(text)).toBeUndefined();
    });

    it("returns undefined for text that is not JSON", () => {
      expect(parseManifest("{not json")).toBeUndefined();
      expect(parseManifest("[]")).toBeUndefined();
      expect(parseManifest(7)).toBeUndefined();
    });

    it("rejects an identity that appears twice", () => {
      const manifest = sampleManifest();
      manifest.entries.push({ ...manifest.entries[0]! });
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });

    it("keeps a variant apart from the default it shadows", () => {
      const manifest = sampleManifest();
      manifest.entries.push({
        ...manifest.entries[0]!,
        test: { ...manifest.entries[0]!.test, v: "server-execution" },
      });
      const parsed = parseManifest(JSON.stringify(manifest));
      expect(parsed?.entries.length).toBe(manifest.entries.length);
      expect(parsed?.entries.at(-1)?.test.v).toBe("server-execution");
    });

    it("rejects a repeat count nothing can run", () => {
      const manifest = sampleManifest();
      manifest.entries[0]!.repeats = 1.5;
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });

    it("rejects a flake rate that is not a share of runs", () => {
      // A negative rate sits under the exclusion threshold and would stay
      // selectable, which is the direction a corrupt manifest must not go.
      for (const flakeRate of [-1, 1.5]) {
        const manifest = sampleManifest();
        manifest.entries[0]!.flakeRate = flakeRate;
        expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
      }
    });

    it("rejects a generation time that is not one", () => {
      // A reader measures a manifest's age from this, and a value that
      // does not parse compares false against every threshold, so a
      // corrupt manifest would read as freshly generated forever.
      for (const generatedAt of ["", "yesterday", "2026-13-45T00:00:00.000Z"]) {
        const manifest = { ...sampleManifest(), generatedAt };
        expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
      }
    });

    it("rejects a correction that would make everything free", () => {
      const manifest = sampleManifest();
      manifest.calibration.suites["workspace-unit"] = {
        overhead: 0,
        correction: 0,
      };
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
    });
  });

  describe("digestIdentities()", () => {
    it("agrees whatever order the identities were walked in", () => {
      const keys = ["a", "b", "c"];
      expect(digestIdentities(keys)).toBe(
        digestIdentities([...keys].reverse()),
      );
    });

    it("changes when the set changes", () => {
      expect(digestIdentities(["a", "b"])).not.toBe(
        digestIdentities(["a", "b", "c"]),
      );
    });

    it("has a digest for the empty set", () => {
      expect(digestIdentities([]).length).toBeGreaterThan(0);
    });
  });

  describe("the sample fixture", () => {
    it("is a manifest the validator accepts", () => {
      const manifest: Manifest = sampleManifest();
      expect(parseManifest(serializeManifest(manifest))).toBeDefined();
    });
  });
});
