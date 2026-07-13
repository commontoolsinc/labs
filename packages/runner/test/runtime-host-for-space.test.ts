import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runtime-host-for-space");
const spaceA = signer.did();
const spaceB = "did:key:z6Mk-host-for-space-b" as MemorySpace;

function makeRuntime(spaceHostMap?: Record<string, string>) {
  const storageManager = StorageManager.emulate({ as: signer });
  return new Runtime({
    apiUrl: new URL("http://host-a.test/"),
    spaceHostMap,
    storageManager,
  });
}

describe("Runtime.registerSpaceHost", () => {
  it("follows storage's verdict and routes compute on acceptance", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return host !== "http://refused.test/";
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
      // Storage refusal ⇒ compute routing must NOT diverge.
      const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
      expect(runtime.registerSpaceHost(spaceC, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceC)).toBeUndefined();
      expect(storageVerdicts.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns false when the manager has no remote resolution", async () => {
    const runtime = makeRuntime();
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

describe("Runtime.hostForSpace", () => {
  it("resolves mapped spaces to their host and others to apiUrl", async () => {
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.hostForSpace(spaceA).toString()).toBe(
        "http://host-a.test/",
      );
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("healthCheck fans out over the default and every mapped host", async () => {
    const dialed: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      dialed.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const runtime = makeRuntime({
      [spaceB]: "http://host-b.test",
      "did:key:z6Mk-host-for-space-c": "http://host-b.test", // dupe host
    });
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(dialed.sort()).toEqual([
        "http://host-a.test/_health",
        "http://host-b.test/_health",
      ]);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck is false when any host is unreachable", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response("", {
          status: String(input).includes("host-b") ? 500 : 200,
        }),
      )) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(await runtime.healthCheck()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });
});

describe("Runtime.fetchBuiltin", () => {
  it("preserves mapped-host resolution when routing through the server broker", async () => {
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      patternEnvironment: { apiUrl: new URL("http://host-a.test/") },
      spaceHostMap: { [spaceB]: "http://host-b.test" },
      storageManager: StorageManager.emulate({ as: signer }),
      experimental: { serverPrimaryExecution: true },
    });
    const brokerUrls: string[] = [];
    runtime.installServerBuiltinFetch((_builtinId, url) => {
      brokerUrls.push(url);
      return Promise.resolve(new Response("ok"));
    });
    try {
      await runtime.fetchBuiltin(
        "fetchJson",
        "/api/value",
        new URL("http://host-b.test/api/value"),
      );
      await runtime.fetchBuiltin(
        "fetchJson",
        "/api/local",
        new URL("http://host-a.test/api/local"),
      );
      expect(brokerUrls).toEqual([
        "http://host-b.test/api/value",
        "/api/local",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
