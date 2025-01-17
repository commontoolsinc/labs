import { assertEquals } from "@std/assert";
import { sha256 } from "@/lib/sha2.ts";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "./blobby.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("blobby storage routes", async (t) => {
  const testContent = {
    message: `This is a test blob created at ${new Date().toISOString()}`,
  };
  const key = await sha256(JSON.stringify(testContent));

  await t.step("POST /api/storage/blobby/{key} uploads blob", async () => {
    const response = await app.fetch(
      new Request(`http://localhost/api/storage/blobby/${key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testContent),
      }),
    );

    assertEquals(response.status, 200);
    const json = await response.json();
    assertEquals(json.key, key);
  });

  await t.step("GET /api/storage/blobby/{key} retrieves blob", async () => {
    const response = await app.fetch(
      new Request(`http://localhost/api/storage/blobby/${key}`),
    );
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.message, testContent.message);
    assertEquals(typeof json.blobCreatedAt, "string");
    assertEquals(json.blobAuthor, "system");
  });

  await t.step("GET /api/storage/blobby lists blobs", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/storage/blobby"),
    );
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(Array.isArray(json.blobs), true);
    assertEquals(json.blobs.includes(key), true);
  });

  await t.step(
    "GET /api/storage/blobby?allWithData=true lists blobs with data",
    async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/storage/blobby?allWithData=true"),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(typeof json, "object");
      assertEquals(json[key].message, testContent.message);
      assertEquals(typeof json[key].blobCreatedAt, "string");
      assertEquals(json[key].blobAuthor, "system");
    },
  );

  await t.step(
    "GET /api/storage/blobby/{key}/message gets nested path",
    async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${key}/message`),
      );
      assertEquals(response.status, 200);

      const text = await response.text();
      assertEquals(text, testContent.message);
    },
  );

  await t.step(
    "GET /api/storage/blobby/{key}/invalid returns 404",
    async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${key}/invalid`),
      );
      assertEquals(response.status, 404);

      const json = await response.json();
      assertEquals(json.error, "Path not found");
    },
  );
});
