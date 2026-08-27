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
});
