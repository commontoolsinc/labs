import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  agentLabel,
  defaultSpoolRoot,
  recordsDir,
  repositoryRelativePath,
  repositoryRoot,
} from "./paths.ts";

describe("paths", () => {
  let outside: string;

  beforeEach(async () => {
    outside = await Deno.makeTempDir({ prefix: "test-records-paths-" });
  });

  afterEach(async () => {
    await Deno.remove(outside, { recursive: true }).catch(() => {});
  });

  describe("repositoryRoot()", () => {
    it("returns the directory holding .git when run inside a repository", () => {
      const root = repositoryRoot();
      expect(root).toBeDefined();
      expect(Deno.statSync(join(root!, ".git")).isDirectory).toBe(true);
    });

    it("returns undefined outside any repository", () => {
      expect(repositoryRoot(outside)).toBeUndefined();
    });

    it("climbs from a nested directory to the same root", async () => {
      const nested = join(outside, "a", "b");
      await Deno.mkdir(join(outside, ".git"), { recursive: true });
      await Deno.mkdir(nested, { recursive: true });
      expect(repositoryRoot(nested)).toBe(outside);
    });
  });

  describe("repositoryRelativePath()", () => {
    it("falls back to a cwd-relative path outside any repository", () => {
      // The temporary tree has no .git above it on the runners this suite
      // uses; a path inside it resolves relative to the working directory.
      const path = repositoryRelativePath(join(outside, "x", "file.ts"));
      expect(path.endsWith("x/file.ts")).toBe(true);
      expect(path.startsWith("/")).toBe(false);
    });
  });

  describe("defaultSpoolRoot()", () => {
    it("prefers the explicit override", () => {
      const env = (name: string) =>
        name === "CF_TEST_RECORDS_SPOOL_ROOT" ? "/spool" : undefined;
      expect(defaultSpoolRoot(env)).toBe("/spool");
    });

    it("falls back from XDG_CACHE_HOME to HOME to USERPROFILE", () => {
      expect(
        defaultSpoolRoot((name) =>
          name === "XDG_CACHE_HOME" ? "/xdg" : undefined
        ),
      ).toBe(join("/xdg", "common-fabric", "test-records"));
      expect(
        defaultSpoolRoot((name) => name === "HOME" ? "/home/u" : undefined),
      ).toBe(join("/home/u", ".cache", "common-fabric", "test-records"));
      expect(
        defaultSpoolRoot((name) =>
          name === "USERPROFILE" ? "/Users/u" : undefined
        ),
      ).toBe(join("/Users/u", ".cache", "common-fabric", "test-records"));
      expect(defaultSpoolRoot(() => undefined)).toBeUndefined();
    });
  });

  describe("recordsDir()", () => {
    it("treats an empty variable as recording off", () => {
      expect(recordsDir(() => "")).toBeUndefined();
    });
  });

  describe("agentLabel()", () => {
    it("returns the label only when the variable is non-empty", () => {
      expect(agentLabel(() => "probe")).toBe("probe");
      expect(agentLabel(() => "")).toBeUndefined();
    });
  });
});
