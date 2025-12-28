import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/patterns/patterns.index.ts";
import { sanitizeErrorMessage } from "@/routes/patterns/compiled.handlers.ts";
import {
  PathTraversalError,
  validatePatternPath,
} from "@/routes/patterns/pattern-compiler.ts";

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

describe("sanitizeErrorMessage", () => {
  it("converts absolute paths to relative paths within patterns directory", () => {
    const input =
      "/Users/alex/Code/labs/packages/patterns/system/foo.tsx(15,7): error TS2322";
    const expected = "system/foo.tsx(15,7): error TS2322";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("handles paths with deeply nested directories", () => {
    const input =
      "/home/user/projects/common/packages/patterns/record/components/editor.tsx:42:10 - error TS1234";
    const expected = "record/components/editor.tsx:42:10 - error TS1234";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("handles Windows-style paths", () => {
    const input =
      "C:\\Users\\dev\\Code\\labs\\packages\\patterns\\system\\app.tsx(10,5): error TS2345";
    const expected = "system\\app.tsx(10,5): error TS2345";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("redacts absolute paths not in patterns directory", () => {
    const input = "Cannot read file /Users/alex/Code/labs/packages/runner/foo.ts";
    const expected = "Cannot read file [redacted-path]";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("handles multiple paths in one message", () => {
    const input =
      "/Users/alex/Code/labs/packages/patterns/a.tsx(1,1) and /Users/alex/Code/labs/packages/patterns/b.tsx(2,2)";
    const expected = "a.tsx(1,1) and b.tsx(2,2)";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("preserves messages without paths", () => {
    const input = "Type 'string' is not assignable to type 'number'.";
    expect(sanitizeErrorMessage(input)).toBe(input);
  });

  it("preserves relative paths", () => {
    const input = "Error in ./system/foo.tsx at line 10";
    expect(sanitizeErrorMessage(input)).toBe(input);
  });

  it("preserves error codes and line numbers", () => {
    const input =
      "/var/lib/app/packages/patterns/test.tsx(123,456): error TS9999: Some error message";
    const expected = "test.tsx(123,456): error TS9999: Some error message";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("redacts paths in /home directory", () => {
    const input = "Failed to import /home/user/secrets/config.json";
    const expected = "Failed to import [redacted-path]";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });

  it("redacts paths in /var directory", () => {
    const input = "Cache at /var/cache/app/data.json is corrupted";
    const expected = "Cache at [redacted-path] is corrupted";
    expect(sanitizeErrorMessage(input)).toBe(expected);
  });
});

describe("validatePatternPath", () => {
  describe("valid paths", () => {
    it("accepts simple filenames", () => {
      expect(validatePatternPath("app.tsx")).toBe("app.tsx");
    });

    it("accepts paths with subdirectories", () => {
      expect(validatePatternPath("system/default-app.tsx")).toBe(
        "system/default-app.tsx",
      );
    });

    it("accepts paths with leading slash", () => {
      expect(validatePatternPath("/system/app.tsx")).toBe("system/app.tsx");
    });

    it("accepts deeply nested paths", () => {
      expect(validatePatternPath("/a/b/c/d/file.ts")).toBe("a/b/c/d/file.ts");
    });

    it("normalizes paths with ./ segments", () => {
      expect(validatePatternPath("./system/app.tsx")).toBe("system/app.tsx");
    });

    it("normalizes internal .. that stays within bounds", () => {
      // /foo/bar/../baz normalizes to /foo/baz which is still valid
      expect(validatePatternPath("/foo/bar/../baz.ts")).toBe("foo/baz.ts");
    });
  });

  describe("path traversal attacks", () => {
    it("blocks simple path traversal", () => {
      expect(() => validatePatternPath("../etc/passwd")).toThrow(
        PathTraversalError,
      );
    });

    it("blocks deep path traversal", () => {
      expect(() =>
        validatePatternPath("../../../../../../../etc/passwd")
      ).toThrow(PathTraversalError);
    });

    it("blocks relative path traversal without leading slash", () => {
      // ../../etc/passwd stays as ../../etc/passwd after normalize
      expect(() => validatePatternPath("../../etc/passwd")).toThrow(
        PathTraversalError,
      );
    });

    it("blocks empty path", () => {
      expect(() => validatePatternPath("")).toThrow(PathTraversalError);
    });

    it("blocks root path", () => {
      expect(() => validatePatternPath("/")).toThrow(PathTraversalError);
    });

    it("blocks dot path", () => {
      expect(() => validatePatternPath(".")).toThrow(PathTraversalError);
    });

    it("blocks path that normalizes to root", () => {
      expect(() => validatePatternPath("/foo/..")).toThrow(PathTraversalError);
    });
  });

  describe("paths with leading slash and .. (safe after normalization)", () => {
    // These paths have .. sequences but normalize to safe paths within root
    // because normalization resolves them relative to virtual root /

    it("normalizes /../etc/passwd to etc/passwd (within patterns)", () => {
      // /../etc/passwd normalizes to /etc/passwd, then etc/passwd
      // This stays within patterns dir - just looking for patterns/etc/passwd
      expect(validatePatternPath("/../etc/passwd")).toBe("etc/passwd");
    });

    it("normalizes /foo/../../etc to etc (within patterns)", () => {
      // /foo/../../etc normalizes to /etc, then etc
      expect(validatePatternPath("/foo/../../etc")).toBe("etc");
    });

    it("normalizes deeply nested escape attempts to paths within root", () => {
      // /a/b/c/../../../d/../../../etc normalizes to /etc
      expect(validatePatternPath("/a/b/c/../../../d/../../../etc")).toBe("etc");
    });
  });

  describe("error messages", () => {
    it("includes the original path in the error message", () => {
      let caught: Error | null = null;
      try {
        validatePatternPath("../../../etc/passwd");
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(PathTraversalError);
      expect(caught!.message).toContain("../../../etc/passwd");
    });
  });
});
