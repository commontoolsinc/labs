import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildsMatch,
  fetchToolshedGitSha,
} from "../src/harness/version-gate.ts";

describe("buildsMatch", () => {
  it("is true only when both versions are known and equal", () => {
    expect(buildsMatch("abc123", "abc123")).toBe(true);
  });

  it("is false when the versions differ", () => {
    expect(buildsMatch("abc123", "def456")).toBe(false);
  });

  it("is false when either side is unknown", () => {
    expect(buildsMatch(undefined, "abc123")).toBe(false);
    expect(buildsMatch("abc123", undefined)).toBe(false);
    expect(buildsMatch(undefined, undefined)).toBe(false);
  });
});

describe("fetchToolshedGitSha", () => {
  const jsonResponse = (body: unknown, ok = true): Response =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });

  it("returns the gitSha from /api/meta", async () => {
    let requested: string | undefined;
    const fetchImpl = ((input: string | URL | Request) => {
      requested = input.toString();
      return Promise.resolve(jsonResponse({ did: "did:x", gitSha: "sha-1" }));
    }) as typeof globalThis.fetch;

    const sha = await fetchToolshedGitSha(fetchImpl, "https://host.example");
    expect(sha).toBe("sha-1");
    expect(requested).toBe("https://host.example/api/meta");
  });

  it("returns undefined for a null gitSha (dev toolshed)", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({ did: "did:x", gitSha: null }),
      )) as typeof globalThis.fetch;
    expect(await fetchToolshedGitSha(fetchImpl, "https://host.example")).toBe(
      undefined,
    );
  });

  it("returns undefined on a non-2xx response", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({ error: "nope" }, false),
      )) as typeof globalThis.fetch;
    expect(await fetchToolshedGitSha(fetchImpl, "https://host.example")).toBe(
      undefined,
    );
  });

  it("returns undefined when fetch throws", async () => {
    const fetchImpl =
      (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch;
    expect(await fetchToolshedGitSha(fetchImpl, "https://host.example")).toBe(
      undefined,
    );
  });
});
