import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  fetchManifest,
  generatedAtOf,
  manifestObjectName,
  manifestPrefix,
  newestAtOrBefore,
  selectionPrefix,
  stateObjectName,
  statePrefix,
} from "./store.ts";
import { serializeManifest } from "./manifest.ts";
import { sampleManifest } from "./testing.ts";

const NO_ENV = () => undefined;

/** A fetch that answers a listing and one object, and nothing else. */
function storeOf(objects: Record<string, Uint8Array | string>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = Object.keys(objects)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { status: 200 }),
      );
    }
    const name = decodeURIComponent(
      url.pathname.split("/").slice(2).join("/"),
    );
    const body = objects[name];
    if (body === undefined) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return Promise.resolve(
      new Response(body as BodyInit, { status: 200 }),
    );
  }) as typeof fetch;
}

describe("store", () => {
  describe("object names", () => {
    it("puts the manifest area beside the records area", () => {
      expect(selectionPrefix(NO_ENV)).toBe("labs/test-selection");
      expect(manifestPrefix(NO_ENV)).toBe("labs/test-selection/v1");
      expect(statePrefix(NO_ENV)).toBe("labs/test-selection/v1/state");
    });

    it("adds the version to the area the environment names", () => {
      // The infra root sets this to the dataset area, the way
      // TEST_RECORDS_PREFIX names `labs/test-records`, so a job and a
      // workstation have to agree on where the version segment comes
      // from or they write to two different layouts.
      const configured = (name: string) =>
        name === "TEST_SELECTION_PREFIX" ? "labs/test-selection" : undefined;
      expect(manifestPrefix(configured)).toBe(manifestPrefix(NO_ENV));
      expect(statePrefix(configured)).toBe(statePrefix(NO_ENV));
    });

    it("leads a manifest's name with its generation time", () => {
      const name = manifestObjectName(
        "2026-08-20T04:00:00.000Z",
        "01K3",
        NO_ENV,
      );
      expect(name).toBe(
        "labs/test-selection/v1/manifest-2026-08-20T04:00:00.000Z-01K3.json.gz",
      );
      expect(generatedAtOf(name)).toBe("2026-08-20T04:00:00.000Z");
    });

    it("leads a state object's name with its day", () => {
      expect(stateObjectName("2026-08-20", "01K3", NO_ENV)).toBe(
        "labs/test-selection/v1/state/2026-08-20-01K3.json.gz",
      );
    });

    it("reads no generation time out of a name that is not one", () => {
      expect(generatedAtOf("labs/test-selection/v1/state/x.json.gz"))
        .toBeUndefined();
      expect(generatedAtOf("something-else")).toBeUndefined();
    });
  });

  describe("newestAtOrBefore()", () => {
    const names = [
      "p/manifest-2026-08-20T00:00:00.000Z-a.json.gz",
      "p/manifest-2026-08-20T04:00:00.000Z-b.json.gz",
      "p/manifest-2026-08-20T08:00:00.000Z-c.json.gz",
      "p/state/2026-08-20-d.json.gz",
    ];

    it("takes the newest that is not after the moment asked about", () => {
      expect(newestAtOrBefore(names, "2026-08-20T05:00:00.000Z")).toBe(
        "p/manifest-2026-08-20T04:00:00.000Z-b.json.gz",
      );
    });

    it("gives a re-run the same answer as the run it replaces", () => {
      const at = "2026-08-20T05:00:00.000Z";
      const later = [
        ...names,
        "p/manifest-2026-08-20T12:00:00.000Z-e.json.gz",
      ];
      expect(newestAtOrBefore(later, at)).toBe(newestAtOrBefore(names, at));
    });

    it("returns undefined when every manifest is newer", () => {
      expect(newestAtOrBefore(names, "2026-08-19T00:00:00.000Z"))
        .toBeUndefined();
    });
  });

  describe("fetchManifest()", () => {
    const at = "2026-08-20T05:00:00.000Z";
    const name =
      "labs/test-selection/v1/manifest-2026-08-20T04:00:00.000Z-b.json.gz";

    it("returns the newest manifest at or before the moment", async () => {
      const manifest = sampleManifest();
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({ [name]: serializeManifest(manifest) }),
      });
      expect(found.objectName).toBe(name);
      expect(found.manifest).toEqual(manifest);
    });

    it("reports an absent manifest rather than throwing", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({}),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("no manifest");
    });

    it("treats a malformed manifest as absent", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({ [name]: "{not a manifest" }),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("not a manifest this reader understands");
    });

    it("treats an unreachable store as absent", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("no network");
    });
  });
});
