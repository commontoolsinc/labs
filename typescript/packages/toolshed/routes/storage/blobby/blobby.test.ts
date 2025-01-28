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

  await t.step(
    "GET /api/storage/blobby?prefix=test- lists blobs with prefix",
    async () => {
      const testPrefixContent = {
        message: "This is a test-prefixed blob",
      };
      const testKey = `test-${await sha256(JSON.stringify(testPrefixContent))}`;

      const otherContent = {
        message: "This is another blob",
      };
      const otherKey = `other-${await sha256(JSON.stringify(otherContent))}`;

      await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${testKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testPrefixContent),
        }),
      );

      await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${otherKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(otherContent),
        }),
      );

      const response = await app.fetch(
        new Request("http://localhost/api/storage/blobby?prefix=test-"),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(Array.isArray(json.blobs), true);
      assertEquals(json.blobs.includes(testKey), true);
      assertEquals(json.blobs.includes(otherKey), false);
    },
  );

  await t.step(
    "GET /api/storage/blobby?prefix=test-&allWithData=true lists prefixed blobs with data",
    async () => {
      const response = await app.fetch(
        new Request(
          "http://localhost/api/storage/blobby?prefix=test-&allWithData=true",
        ),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(typeof json, "object");

      Object.keys(json).forEach((key) => {
        assertEquals(key.startsWith("test-"), true);
      });

      const testKeys = Object.keys(json).filter((k) => k.startsWith("test-"));
      for (const key of testKeys) {
        assertEquals(typeof json[key].message, "string");
        assertEquals(typeof json[key].blobCreatedAt, "string");
        assertEquals(json[key].blobAuthor, "system");
      }
    },
  );

  await t.step(
    "GET /api/storage/blobby?search=test lists blobs containing text",
    async () => {
      // Create blobs with different content
      const matchingContent = {
        message: "This contains test in the content",
        other: "field",
      };
      const matchingKey = await sha256(JSON.stringify(matchingContent));

      const nonMatchingContent = {
        message: "This has different content",
        other: "nothing here",
      };
      const nonMatchingKey = await sha256(JSON.stringify(nonMatchingContent));

      // Upload both blobs
      await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${matchingKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(matchingContent),
        }),
      );

      await app.fetch(
        new Request(`http://localhost/api/storage/blobby/${nonMatchingKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nonMatchingContent),
        }),
      );

      // Test fulltext search
      const response = await app.fetch(
        new Request("http://localhost/api/storage/blobby?search=test"),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(Array.isArray(json.blobs), true);
      assertEquals(json.blobs.includes(matchingKey), true);
      assertEquals(json.blobs.includes(nonMatchingKey), false);
    },
  );

  await t.step(
    "GET /api/storage/blobby?search=test&allWithData=true lists matching blobs with data",
    async () => {
      const response = await app.fetch(
        new Request(
          "http://localhost/api/storage/blobby?search=test&allWithData=true",
        ),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(typeof json, "object");

      // Verify all returned objects contain the search term
      Object.entries(json).forEach(([key, value]) => {
        const stringified = JSON.stringify(value).toLowerCase();
        assertEquals(stringified.includes("test"), true);
      });
    },
  );

  await t.step(
    "GET /api/storage/blobby?prefix=test-&search=blob combines prefix and search",
    async () => {
      const response = await app.fetch(
        new Request(
          "http://localhost/api/storage/blobby?prefix=test-&search=blob",
        ),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(Array.isArray(json.blobs), true);

      // Verify all returned keys start with prefix and content contains search term
      for (const key of json.blobs) {
        assertEquals(key.startsWith("test-"), true);
        const blobResponse = await app.fetch(
          new Request(`http://localhost/api/storage/blobby/${key}`),
        );
        const blobContent = await blobResponse.json();
        const stringified = JSON.stringify(blobContent).toLowerCase();
        assertEquals(stringified.includes("blob"), true);
      }
    },
  );

  await t.step(
    "GET /api/storage/blobby?keys=key1,key2 fetches specific blobs",
    async () => {
      // Create three test blobs
      const blob1 = {
        message: "First test blob",
        id: 1,
      };
      const blob2 = {
        message: "Second test blob",
        id: 2,
      };
      const blob3 = {
        message: "Third test blob",
        id: 3,
      };

      const key1 = await sha256(JSON.stringify(blob1));
      const key2 = await sha256(JSON.stringify(blob2));
      const key3 = await sha256(JSON.stringify(blob3));

      // Upload all three blobs
      const blobs = [[blob1, key1], [blob2, key2], [blob3, key3]];
      for (
        const [content, key] of blobs
      ) {
        await app.fetch(
          new Request(`http://localhost/api/storage/blobby/${key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(content),
          }),
        );
      }

      // Fetch only two of the blobs
      const response = await app.fetch(
        new Request(`http://localhost/api/storage/blobby?keys=${key1},${key2}`),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(typeof json, "object");

      // Should only contain the two requested blobs
      assertEquals(Object.keys(json).length, 2);
      assertEquals(json[key1].message, blob1.message);
      assertEquals(json[key2].message, blob2.message);
      assertEquals(json[key3], undefined);

      // Verify blob metadata
      assertEquals(typeof json[key1].blobCreatedAt, "string");
      assertEquals(json[key1].blobAuthor, "system");
      assertEquals(typeof json[key2].blobCreatedAt, "string");
      assertEquals(json[key2].blobAuthor, "system");
    },
  );

  await t.step(
    "GET /api/storage/blobby?keys=invalid returns empty result",
    async () => {
      const response = await app.fetch(
        new Request(
          "http://localhost/api/storage/blobby?keys=invalid1,invalid2",
        ),
      );
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals(typeof json, "object");
      assertEquals(Object.keys(json).length, 0);
    },
  );
});
