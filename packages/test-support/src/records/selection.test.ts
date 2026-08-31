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
      manifest.entries.push({
        // A cost that is not a number: one bad entry rejects the whole
        // object, because a partly obeyed manifest runs an arbitrary set.
        ...manifest.entries[0]!,
        test: { k: "unit", s: "memory", n: "another" },
        cost: Number.NaN,
      });
      expect(parseManifest(JSON.stringify(manifest))).toBeUndefined();
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
