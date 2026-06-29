import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import app from "@/app.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

// Smoke tests for the location-ingest endpoint: confirm it is mounted and that
// the auth gate fast-fails BEFORE any storage write. These deliberately hit
// only the validation + session.open-verification paths (which reject before
// the operator runtime is touched), so they need no runtime fixture. The
// channel-authorization logic itself is unit-tested in channel-acl.test.ts; the
// durable append + mark in location-ingest.utils.test.ts.

describe("Location ingest route (smoke: wired up + auth gate)", () => {
  it("rejects a malformed body with 422", async () => {
    const res = await app.request("/api/location-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Missing `auth`, and `points` is empty (violates min(1)).
      body: JSON.stringify({ points: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects an unverifiable session.open with 401 (before any write)", async () => {
    const res = await app.request("/api/location-ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Well-formed enough to pass schema, but the authorization carries no
        // valid signature — verifySessionOpenAuthorization rejects it.
        auth: {
          space: "did:key:z6MkPresenterPickedThisSpace",
          session: {},
          invocation: { iss: "did:key:z6MkPresenter", cmd: "session.open" },
          authorization: "not-a-signature",
        },
        points: [{
          latitude: 37.1,
          longitude: -122.4,
          accuracy: 5,
          timestamp: 1,
        }],
      }),
    });
    expect(res.status).toBe(401);
  });
});
