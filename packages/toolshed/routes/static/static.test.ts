import { assert } from "@std/assert";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/static/static.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("static routes", async (t) => {
  await t.step(
    "GET /static/prompts/system.md returns 200 with prompt",
    async () => {
      const response = await app.request("/static/prompts/system.md");
      assert(response.status === 200);
      assert(/# React Component Builder/.test(await response.text()));
    },
  );
});
