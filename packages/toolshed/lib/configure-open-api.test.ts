import { assert, assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp();
configureOpenAPI(app);

Deno.test("openapi reference", async (t) => {
  await t.step("GET /doc serves the OpenAPI document", async () => {
    const response = await app.request("/doc");
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.openapi, "3.0.0");
    assertEquals(json.info.title, "Toolshed API");
  });

  // Scalar renders the configuration it is handed into the page without
  // validating it, serializing an unknown key as readily as a known one. The
  // document URL is read back out of the page and fetched, so the two routes
  // are checked against each other rather than against a repeated literal.
  await t.step(
    "GET /reference points at a document the app serves",
    async () => {
      const response = await app.request("/reference");
      assertEquals(response.status, 200);

      const html = await response.text();
      const match = html.match(/createApiReference\([^,]*,\s*(\{[\s\S]*?\})\)/);
      assert(match, "no Scalar configuration rendered into /reference");

      const config = JSON.parse(match[1]);
      assert(
        typeof config.url === "string",
        `Scalar carries the document URL under 'url'; got: ${match[1]}`,
      );
      assertEquals((await app.request(config.url)).status, 200);
    },
  );
});
