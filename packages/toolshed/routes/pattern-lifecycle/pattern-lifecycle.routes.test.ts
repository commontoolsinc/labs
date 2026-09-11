import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import env from "@/env.ts";
import app from "@/app.ts";
import { BASE, MAX_BODY_BYTES } from "./pattern-lifecycle.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("pattern-lifecycle route (transport + middleware)", () => {
  // The mounted router's middleware stack: what runs before a handler and
  // in what order. The verbs themselves are tested against a real serving
  // host in pattern-lifecycle.utils.test.ts. The rate limiter is
  // module-level and keyed by client address, so each signed request below
  // names a distinct address.

  let clientCounter = 0;

  const post = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      ...init,
    });

  const signedRequest = async (verb: string, payload: unknown) => {
    const identity = await Identity.generate();
    const url = new URL(`${BASE}/${verb}`, "http://localhost");
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.1.0.${++clientCounter}`,
      },
      body,
      signer: identity,
    });
    return await app.request(url.toString(), { method: "POST", headers, body });
  };

  it("rejects an unsigned request on every verb", async () => {
    for (const verb of ["upload", "instantiate"]) {
      const res = await post(`${BASE}/${verb}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized",
        code: "unauthorized",
      });
    }
  });

  it("caps an oversized body before authenticating it", async () => {
    const res = await post(`${BASE}/instantiate`, {
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it("accepts a validly signed request and answers for the deployment's posture", async () => {
    // Under test no serving host runs, so a request that cleared the
    // signature check, the limiter, and body validation is answered with
    // the route's own 503 rather than by anything downstream.
    const res = await signedRequest("instantiate", {
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
      program: { main: "/main.tsx", files: [] },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("serving loop"),
      code: "server-execution-off",
    });
  });

  it("rejects a signed request whose body fails schema validation", async () => {
    const res = await signedRequest("upload", { space: "did:key:z6Mk" });
    expect(res.status).toBe(422);
  });
});
