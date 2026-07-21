import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { PATTERN_RESPONSE_BUILD_HEADER } from "../src/harness/version-gate.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { VersionSkewInfo } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("pattern update cache");

/**
 * Covers the Runtime-level system-pattern update helpers directly (they are
 * otherwise exercised only from the piece package, which does not credit runner
 * coverage): toolshedGitSha / cachedPatternIdentity / clearPatternUpdateCaches
 * (+ the single-flight, evict-on-failure #cachedLookup) and reportVersionSkew.
 */
describe("Runtime system-pattern update helpers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let calls: string[];
  let metaGitSha: string | null;
  let identityBody: string | { status: number };
  let identityBuildSha: string | null;

  function makeRuntime(
    onVersionSkew?: (info: VersionSkewInfo) => void,
  ): Runtime {
    const fetchImpl = ((input: string | URL | Request) => {
      const href = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      const url = new URL(href);
      calls.push(url.pathname + (url.search ? url.search : ""));
      if (url.pathname === "/api/meta") {
        return Promise.resolve(
          new Response(JSON.stringify({ did: "did:x", gitSha: metaGitSha }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.searchParams.has("identity")) {
        if (typeof identityBody === "object") {
          return Promise.resolve(
            new Response("nope", { status: identityBody.status }),
          );
        }
        return Promise.resolve(
          new Response(identityBody, {
            headers: identityBuildSha === null
              ? undefined
              : { [PATTERN_RESPONSE_BUILD_HEADER]: identityBuildSha },
          }),
        );
      }
      return Promise.resolve(new Response("nf", { status: 404 }));
    }) as typeof globalThis.fetch;

    return new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: fetchImpl,
      ...(onVersionSkew ? { onVersionSkew } : {}),
    });
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    calls = [];
    metaGitSha = "build-1";
    identityBody = "the-identity";
    identityBuildSha = "build-1";
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  it("toolshedGitSha reads /api/meta and caches per host", async () => {
    const rt = makeRuntime();
    try {
      expect(await rt.toolshedGitSha("http://toolshed.test")).toBe("build-1");
      expect(await rt.toolshedGitSha("http://toolshed.test")).toBe("build-1");
      // One fetch — the second hit the cache.
      expect(calls.filter((c) => c === "/api/meta").length).toBe(1);
    } finally {
      await rt.dispose();
    }
  });

  it("toolshedGitSha returns undefined for a null (dev) gitSha and does not cache it", async () => {
    metaGitSha = null;
    const rt = makeRuntime();
    try {
      expect(await rt.toolshedGitSha("http://toolshed.test")).toBe(undefined);
      // A failed/unknown lookup is evicted → the next call retries.
      expect(await rt.toolshedGitSha("http://toolshed.test")).toBe(undefined);
      expect(calls.filter((c) => c === "/api/meta").length).toBe(2);
    } finally {
      await rt.dispose();
    }
  });

  it("cachedPatternIdentity fetches ?identity, caches, and re-fetches after clear", async () => {
    const rt = makeRuntime();
    const host = "http://toolshed.test";
    const url = "/api/patterns/system/default-app.tsx";
    try {
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        "the-identity",
      );
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        "the-identity",
      );
      const idFetches = () =>
        calls.filter((c) => c.includes("identity")).length;
      expect(idFetches()).toBe(1);

      rt.clearPatternUpdateCaches();
      identityBody = "next-identity";
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        "next-identity",
      );
      expect(idFetches()).toBe(2);
    } finally {
      await rt.dispose();
    }
  });

  it("cachedPatternIdentity returns undefined on a non-2xx and retries", async () => {
    identityBody = { status: 500 };
    const rt = makeRuntime();
    const host = "http://toolshed.test";
    const url = "/api/patterns/system/default-app.tsx";
    try {
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        undefined,
      );
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        undefined,
      );
      expect(calls.filter((c) => c.includes("identity")).length).toBe(2);
    } finally {
      await rt.dispose();
    }
  });

  it("cachedPatternIdentity requires and keys by the serving build", async () => {
    const rt = makeRuntime();
    const host = "http://toolshed.test";
    const url = "/api/patterns/system/default-app.tsx";
    try {
      expect(await rt.cachedPatternIdentity(host, url, "build-1")).toBe(
        "the-identity",
      );

      identityBody = "next-identity";
      identityBuildSha = "build-2";
      expect(await rt.cachedPatternIdentity(host, url, "build-2")).toBe(
        "next-identity",
      );

      identityBuildSha = "other-build";
      expect(await rt.cachedPatternIdentity(host, url, "build-3")).toBe(
        undefined,
      );
      expect(calls.filter((c) => c.includes("identity")).length).toBe(3);
    } finally {
      await rt.dispose();
    }
  });

  it("reportVersionSkew invokes the configured handler; inert without one", async () => {
    const seen: VersionSkewInfo[] = [];
    const rt = makeRuntime((info) => seen.push(info));
    try {
      rt.reportVersionSkew({
        space: "did:key:z6Mk",
        clientVersion: "c",
        toolshedVersion: "t",
      });
      expect(seen).toEqual([{
        space: "did:key:z6Mk",
        clientVersion: "c",
        toolshedVersion: "t",
      }]);
    } finally {
      await rt.dispose();
    }

    const rt2 = makeRuntime();
    try {
      // No handler configured — must not throw.
      rt2.reportVersionSkew({ space: "did:key:z6Mk" });
    } finally {
      await rt2.dispose();
    }
  });
});
