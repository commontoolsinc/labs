import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { openGithubFabricRuntime } from "../src/fabric-runtime.ts";

describe("openGithubFabricRuntime", () => {
  let identityPath: string;
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    identityPath = await Deno.makeTempFile({ suffix: ".key" });
    await Deno.writeFile(identityPath, await Identity.generatePkcs8());
    realFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await Deno.remove(identityPath);
  });

  it("rejects an invalid API URL before reading identity", async () => {
    await expect(openGithubFabricRuntime({
      apiUrl: "not a URL",
      identityPath: `${identityPath}.absent`,
      space: "github-space",
      githubHost: "github.com",
      githubAccount: "acme",
    })).rejects.toThrow("Common Fabric API URL is not valid");
  });

  it("rejects an unreadable identity before making a request", async () => {
    let requested = false;
    globalThis.fetch = () => {
      requested = true;
      return Promise.resolve(new Response(null, { status: 503 }));
    };

    await expect(openGithubFabricRuntime({
      apiUrl: "https://fabric.example.test",
      identityPath: `${identityPath}.absent`,
      space: "github-space",
      githubHost: "github.com",
      githubAccount: "acme",
    })).rejects.toThrow(Deno.errors.NotFound);
    expect(requested).toBe(false);
  });

  it("disposes a runtime whose health check fails", async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 503 }));

    await expect(openGithubFabricRuntime({
      apiUrl: "https://fabric.example.test",
      identityPath,
      space: "github-space",
      githubHost: "github.com",
      githubAccount: "acme",
    })).rejects.toThrow("could not connect to https://fabric.example.test");
  });

  it("resolves the deployment posture before constructing the runtime", async () => {
    // The GitHub host is installed separately from the toolshed it talks
    // to, and every experimental flag is server-authoritative
    // (EXPERIMENTAL_FLAG_AUTHORITY) — so the host must ask the deployment
    // for its posture rather than fill unset flags with its own build's
    // defaults. A rebuilt host with an empty environment against a server
    // held on an explicit posture would otherwise run the two sides on
    // different arms (the #6535 Codex P1: an ON-client against a
    // rolled-back OFF-server waits for a serving loop that does not
    // exist). The posture request must come FIRST: it is what the runtime
    // is constructed from.
    const requestPaths: string[] = [];
    globalThis.fetch = (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
      );
      requestPaths.push(url.pathname);
      if (url.pathname === "/api/meta") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              did: "did:key:z",
              experimental: { serverExecution: false },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 503 }));
    };

    await expect(openGithubFabricRuntime({
      apiUrl: "https://fabric.example.test",
      identityPath,
      space: "github-space",
      githubHost: "github.com",
      githubAccount: "acme",
    })).rejects.toThrow("could not connect to https://fabric.example.test");
    // The FIRST request is the posture read — nothing runtime-owned may
    // precede it — and startup then went on to its health check.
    expect(requestPaths[0]).toBe("/api/meta");
    expect(requestPaths.length).toBeGreaterThan(1);
  });

  it("honors CF_ADOPT_SERVER_FLAGS=false without losing the request wiring", async () => {
    // The opt-out keeps a host on its own posture when a deployment
    // publishes something it cannot run. Both arms in one test, because
    // each is the other's control: without the opt-out the meta document
    // is requested (so the quiet arm below is the opt-out working, not
    // the adoption missing), and with it the request must not happen at
    // all (so the env reader is genuinely wired through — a host reading
    // nothing would fetch in both arms).
    const requestPaths: string[] = [];
    globalThis.fetch = (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
      );
      requestPaths.push(url.pathname);
      if (url.pathname === "/api/meta") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ did: "did:key:z", experimental: {} }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 503 }));
    };
    const open = () =>
      expect(openGithubFabricRuntime({
        apiUrl: "https://fabric.example.test",
        identityPath,
        space: "github-space",
        githubHost: "github.com",
        githubAccount: "acme",
      })).rejects.toThrow("could not connect to https://fabric.example.test");

    await open();
    expect(requestPaths).toContain("/api/meta");

    requestPaths.length = 0;
    const previous = Deno.env.get("CF_ADOPT_SERVER_FLAGS");
    Deno.env.set("CF_ADOPT_SERVER_FLAGS", "false");
    try {
      await open();
    } finally {
      if (previous === undefined) Deno.env.delete("CF_ADOPT_SERVER_FLAGS");
      else Deno.env.set("CF_ADOPT_SERVER_FLAGS", previous);
    }
    expect(requestPaths).not.toContain("/api/meta");
    // The health check still ran: the quiet arm skipped the posture
    // request specifically, not the startup around it.
    expect(requestPaths.length).toBeGreaterThan(0);
  });
});
