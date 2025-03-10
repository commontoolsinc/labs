import { assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/ai/spell/spell.index.ts";
import llmRouter from "@/routes/ai/llm/llm.index.ts";
import blobbyRouter from "@/routes/storage/blobby/blobby.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp()
  .route("/", router)
  .route("/", llmRouter)
  .route("/", blobbyRouter);
// Deno.serve(app.fetch);

// bf: these are commented out because the LLM is not configured in CI and they will fail
// they work locally if you have claude set up
Deno.test("spell routes", async (t) => {
  // await t.step(
  //   "POST /ai/spell/search returns valid, empty response",
  //   async () => {
  //     const response = await app.fetch(
  //       new Request("http://localhost/ai/spell/search", {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //         },
  //         body: JSON.stringify({
  //           "query": "test",
  //           "options": {
  //             "limit": 10,
  //             "offset": 0,
  //           },
  //         }),
  //       }),
  //     );
  //     assertEquals(response.status, 200);

  //     const json = await response.json();
  //     assertEquals(json.results != undefined, true);
  //     assertEquals(Array.isArray(json.results), true);
  //   },
  // );

  // await t.step(
  //   "POST /ai/spell/imagine returns valid, empty response",
  //   async () => {
  //     const response = await app.fetch(
  //       new Request("http://localhost/ai/spell/imagine", {
  //         method: "POST",
  //         headers: {
  //           "Content-Type": "application/json",
  //         },
  //         body: JSON.stringify({
  //           "schema": {
  //             "name": { "type": "string" },
  //           },
  //           "many": true,
  //           "prompt": "",
  //           "options": {
  //             "format": "json",
  //             "validate": true,
  //             "maxExamples": 5,
  //           },
  //         }),
  //       }),
  //     );
  //     assertEquals(response.status, 200);

  //     const json = await response.json();
  //     console.log(json);
  //     assertEquals(json.result != undefined, true);
  //     assertEquals(Array.isArray(json.result), true);
  //   },
  // );
});
