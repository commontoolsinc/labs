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

  it("rejects non-HTTP hints before forwarding them to storage", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return true;
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      for (
        const host of [
          "ws://host-b.test",
          "wss://host-b.test",
          "ftp://host-b.test",
        ]
      ) {
        expect(() => runtime.registerSpaceHost(spaceB, host))
          .toThrow(`Invalid host for space ${spaceB}`);
      }
      expect(storageVerdicts).toEqual([]);

      expect(runtime.registerSpaceHost(spaceB, "https://host-b.test"))
        .toBe(true);
      expect(storageVerdicts).toEqual([
        [spaceB, "https://host-b.test/"],
      ]);
      expect(runtime.mappedHostFor(spaceB)).toBe("https://host-b.test/");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("Runtime.hostForSpace", () => {
  it("rejects seeded hosts that cannot serve HTTP requests", () => {
    for (
      const host of [
        "ws://host-b.test",
        "wss://host-b.test",
        "ftp://host-b.test",
      ]
    ) {
      expect(() => makeRuntime({ [spaceB]: host }))
        .toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
    }
  });

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

  it("healthCheck captures the default host's gitSha; other hosts don't overwrite it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const body = String(input).startsWith("http://host-a.test")
        ? JSON.stringify({ status: "OK", gitSha: "  abc123  " })
        : JSON.stringify({ status: "OK", gitSha: "not-the-default-host" });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.serverGitSha).toBe(null);
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck reports null gitSha for non-JSON or field-less bodies, and resets a stale capture", async () => {
    const realFetch = globalThis.fetch;
    let body = JSON.stringify({ status: "OK", gitSha: "abc123" });
    globalThis.fetch =
      (() =>
        Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;
    const runtime = makeRuntime();
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
      // An older server answering plain text must reset the capture.
      body = "ok";
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe(null);
      // A JSON body without the field stays null too.
      body = JSON.stringify({ status: "OK" });
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe(null);
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
