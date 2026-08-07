import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRouter } from "@/lib/create-app.ts";
import { BASE } from "./ingest-channels.routes.ts";

// The gate's ROUTING consequence, which env.test.ts does not cover — that pins
// the flag's default value, not what the router does with it.
//
// The middleware is rebuilt here against a stub rather than imported, because
// the real router reads `env` once at module load and `.env.test` enables the
// feature so the other suites can exercise it. What is asserted is the shape
// the real router relies on: a first `use` on `${BASE}/*` that short-circuits
// before anything downstream runs.
describe("self-serve gate", () => {
  const build = (enabled: boolean) => {
    const seen: string[] = [];
    const router = createRouter();
    router.use(`${BASE}/*`, async (c, next) => {
      if (!enabled) return c.notFound();
      await next();
    });
    router.use(`${BASE}/*`, async (_c, next) => {
      seen.push("downstream");
      await next();
    });
    router.post(`${BASE}/mint`, (c) => c.json({ ok: true }));
    return { router, seen };
  };

  const spellings = [
    `${BASE}/mint`,
    `${BASE}/./mint`,
    `${BASE}/x/../mint`,
    `${BASE}/%6Dint`,
    `${BASE}/`,
    BASE,
  ];

  it("404s every spelling of every verb when disabled", async () => {
    const { router, seen } = build(false);
    for (const path of spellings) {
      const res = await router.request(`http://localhost${path}`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    }
    // Nothing downstream of the gate runs — not the body limit, not the rate
    // limiter, not signature verification.
    expect(seen).toEqual([]);
  });

  it("passes through to the handler when enabled", async () => {
    const { router, seen } = build(true);
    const res = await router.request(`http://localhost${BASE}/mint`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["downstream"]);
  });
});
