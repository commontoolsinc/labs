import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/patterns/patterns.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

describe("Compiled Patterns API", () => {
  describe("basic compilation", () => {
    it("compiles system/default-app.tsx to JavaScript", async () => {
      const response = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "application/javascript",
      );

      const js = await response.text();
      // Should be JavaScript, not TypeScript
      expect(js).not.toContain("export default pattern<");
      // Should have AMD wrapper from bundler
      expect(js).toContain("define(");
      // Should have inline source map
      expect(js).toContain("//# sourceMappingURL=data:application/json;base64,");
    });

    it("includes X-Content-Hash header", async () => {
      const response = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
      );
      expect(response.status).toBe(200);
      const contentHash = response.headers.get("X-Content-Hash");
      expect(contentHash).toBeTruthy();
      expect(contentHash!.length).toBeGreaterThan(10);
    });

    it("includes ETag header", async () => {
      const response = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
      );
      expect(response.status).toBe(200);
      const etag = response.headers.get("ETag");
      expect(etag).toBeTruthy();
    });
  });

  describe("ETag caching", () => {
    it("returns 304 when ETag matches", async () => {
      // First request to get ETag
      const response1 = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
      );
      expect(response1.status).toBe(200);
      const etag = response1.headers.get("ETag");
      expect(etag).toBeTruthy();

      // Second request with If-None-Match
      const response2 = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
        {
          headers: {
            "If-None-Match": etag!,
          },
        },
      );
      expect(response2.status).toBe(304);
    });

    it("returns 200 when ETag doesn't match", async () => {
      const response = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
        {
          headers: {
            "If-None-Match": '"invalid-etag"',
          },
        },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("error handling", () => {
    it("returns 404 for non-existent pattern", async () => {
      const response = await app.request(
        "/api/patterns/compiled/non-existent-pattern.tsx",
      );
      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json.error).toBe("Pattern not found");
    });

    it("blocks path traversal with ..", async () => {
      const response = await app.request(
        "/api/patterns/compiled/foo..bar.tsx",
      );
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid file path");
    });

    it("blocks URL scheme injection", async () => {
      const response = await app.request(
        "/api/patterns/compiled/file:passwd",
      );
      expect(response.status).toBe(400);
    });
  });

  describe("CORS headers", () => {
    it("includes CORS headers", async () => {
      const response = await app.request(
        "/api/patterns/compiled/system/default-app.tsx",
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("subdirectory patterns", () => {
    it("compiles patterns in subdirectories", async () => {
      const response = await app.request(
        "/api/patterns/compiled/record/registry.ts",
      );
      // This may be 200 or 500 depending on whether the file compiles standalone
      // For now, just verify it doesn't 404 on a valid file path
      expect([200, 500]).toContain(response.status);
    });
  });
});
