import { assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/ai/spell/spell.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("spell routes", async (t) => {
  await t.step(
    "POST /ai/spell/search returns valid, empty response",
    async () => {
      const response = await app.fetch(
        new Request("http://localhost/ai/spell/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            "query": "test",
            "options": {
              "limit": 10,
              "offset": 0,
            },
          }),
        }),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(json.results != undefined, true);
      assertEquals(Array.isArray(json.results), true);
    },
  );

  await t.step(
    "POST /ai/spell/imagine returns valid, empty response",
    async () => {
      const response = await app.fetch(
        new Request("http://localhost/ai/spell/imagine", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            "schema": {
              "name": { "type": "string" },
            },
            "many": true,
            "prompt": "",
            "options": {
              "format": "json",
              "validate": true,
              "maxExamples": 5,
            },
          }),
        }),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      console.log(json);
      assertEquals(json.result != undefined, true);
      assertEquals(Array.isArray(json.result), true);
    },
  );
});
