import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import app from "@/app.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

// Smoke tests: confirm POST /api/ingest/:id is mounted and its transport-level
// branches behave. Driven through the real `app` (not a freshly-mounted router)
// because the handler imports the `runtime` singleton from `@/index.ts`, which
// is uninitialized under test — so any path that reaches storage yields 502,
// which is itself the storage-error contract. The full auth + validation
// contract is unit-tested against a real runtime in ingest.utils.test.ts
// (processIngest).
describe("Ingest route (smoke: wired up + transport paths)", () => {
  it("POST /api/ingest/:id without a bearer token -> 401", async () => {
    const res = await app.request("/api/ingest/ing_nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partition: "2026-07-01", records: [{ x: 1 }] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/ingest/:id parses the body only after auth (malformed body hits auth first)", async () => {
    // Bearer present + malformed body: auth runs before body parsing, so this
    // reaches the (unavailable) runtime and 502s rather than returning 400 — a
    // bad token is never distinguished by body validity. The value-level 400
    // path is unit-tested in ingest.utils.test.ts (valid token + malformed body).
    const res = await app.request("/api/ingest/ing_nope", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer x",
      },
      body: "{not json",
    });
    expect(res.status).toBe(502);
  });

  it("POST /api/ingest/:id with a bearer + valid body -> 502 (runtime unavailable under test)", async () => {
    const res = await app.request("/api/ingest/ing_nope", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer x",
      },
      body: JSON.stringify({ partition: "2026-07-01", records: [{ x: 1 }] }),
    });
    expect(res.status).toBe(502);
  });
});
