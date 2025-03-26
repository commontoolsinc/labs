import { Identity } from "@commontools/identity";
import { assertEquals } from "@std/assert";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import type { MetaResponse } from "./meta.handlers.ts";
import router from "@/routes/meta/meta.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("meta routes", async (t) => {
  await t.step("GET /api/meta returns 200 with meta status", async () => {
    const response = await app.request("/api/meta");
    assertEquals(response.status, 200);

    const json = await response.json();
    // DID of "./test.key"
    assertEquals(
      json.did,
      "did:key:z6Mkqqy6FetDFSzm3oegQmJEUWrqBpxAZvWrw3xZTyNqJYj9",
    );
  });
});
