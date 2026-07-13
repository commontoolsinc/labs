import { assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/health/health.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("health routes", async (t) => {
  await t.step("GET /_health returns 200 with health status", async () => {
    const response = await app.request("/_health");
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.status, "OK");
    assertEquals(typeof json.timestamp, "number");
  });

  await t.step(
    "GET /api/health/stats exposes server execution pool metrics",
    async () => {
      const response = await app.request("/api/health/stats");
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals("serverExecutionPool" in json, true);
      assertEquals(json.serverExecutionPool, null);
    },
  );
});
