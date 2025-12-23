import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/patterns/patterns.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

describe("Patterns API", () => {
  describe("basic pattern serving", () => {
    it("serves system/default-app.tsx", async () => {
      const response = await app.request("/api/patterns/system/default-app.tsx");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("export default pattern");
    });

    it("serves record.tsx", async () => {
      const response = await app.request("/api/patterns/record.tsx");
      expect(response.status).toBe(200);
      const text = await response.text();
      // record.tsx exports its pattern differently
      expect(text).toContain("export default Record");
    });

    it("returns 404 for non-existent pattern", async () => {
      const response = await app.request(
        "/api/patterns/non-existent-pattern.tsx",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("subdirectory imports", () => {
    // These tests validate that patterns with subdirectory structure work.
    // This was broken in PR #2314 when the patterns API blocked paths with '/'.
    // See PRs #2318 (revert) and #2319 (fix) for context.

    it("serves record/registry.ts (subdirectory import)", async () => {
      const response = await app.request("/api/patterns/record/registry.ts");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });

    it("serves record/template-registry.ts", async () => {
      const response = await app.request(
        "/api/patterns/record/template-registry.ts",
      );
      expect(response.status).toBe(200);
    });

    it("serves record/types.ts", async () => {
      const response = await app.request("/api/patterns/record/types.ts");
      expect(response.status).toBe(200);
    });

    it("serves nested subdirectory record/extraction/extractor-module.tsx", async () => {
      const response = await app.request(
        "/api/patterns/record/extraction/extractor-module.tsx",
      );
      expect(response.status).toBe(200);
    });

    it("serves deeply nested record/extraction/schema-utils.ts", async () => {
      const response = await app.request(
        "/api/patterns/record/extraction/schema-utils.ts",
      );
      expect(response.status).toBe(200);
    });

    it("serves record/extraction/schema-utils-pure.ts", async () => {
      const response = await app.request(
        "/api/patterns/record/extraction/schema-utils-pure.ts",
      );
      expect(response.status).toBe(200);
    });
  });

  describe("security validation", () => {
    // Note: Pure path traversal like "../../../etc/passwd" gets URL-normalized
    // before reaching the handler. These tests validate the handler-level checks.

    it("blocks .. in filename", async () => {
      // A filename containing .. should be blocked
      const response = await app.request("/api/patterns/foo..bar.tsx");
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid file path");
    });

    it("blocks .. in subdirectory path", async () => {
      // Even within a valid-looking path structure
      const response = await app.request("/api/patterns/record/..trick.ts");
      expect(response.status).toBe(400);
    });

    it("blocks URL scheme injection with colon", async () => {
      const response = await app.request(
        "/api/patterns/file:passwd",
      );
      expect(response.status).toBe(400);
    });

    it("blocks data: URL scheme", async () => {
      const response = await app.request(
        "/api/patterns/data:text",
      );
      expect(response.status).toBe(400);
    });
  });

  describe("CORS headers", () => {
    it("includes CORS headers for cross-origin access", async () => {
      const response = await app.request("/api/patterns/system/default-app.tsx");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
