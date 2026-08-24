import { assertEquals } from "@std/assert";
import { SERVER_EXPERIMENTAL_PATH } from "@commonfabric/runner";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import { publishExperimentalPosture } from "@/lib/experimental-posture.ts";
import router from "@/routes/meta/meta.index.ts";
import * as routes from "@/routes/meta/meta.routes.ts";

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
    assertEquals(json.gitSha, null);
    // A source run has no compiled marker: the shell's baked
    // server-execution define is unknown (null), like gitSha.
    assertEquals(json.shellServerExecutionDefine, null);
  });

  await t.step(
    "GET /api/meta reports no posture until one is published",
    async () => {
      // The state of a server whose Runtime does not exist yet. Set here
      // rather than assumed: the posture is module state, and another test
      // file in the same process publishes one.
      publishExperimentalPosture(null);
      const json = await (await app.request("/api/meta")).json();
      assertEquals(json.experimental, null);
    },
  );

  await t.step(
    "GET /api/meta reports the Runtime's resolved flags",
    async () => {
      publishExperimentalPosture({
        modernCellRep: false,
        serverExecution: true,
      });
      try {
        const json = await (await app.request("/api/meta")).json();
        assertEquals(json.experimental, {
          modernCellRep: false,
          serverExecution: true,
        });
      } finally {
        publishExperimentalPosture(null);
      }
    },
  );

  await t.step("serves the document clients read their posture from", () => {
    // The client half names this path as a constant it cannot see the route
    // from; moving the route without moving the constant would leave every
    // deployed client silently back on its own environment.
    assertEquals(SERVER_EXPERIMENTAL_PATH, routes.index.path);
  });
});
