import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricAuthorityMatchesSpaceHost,
  normalizeSpaceHost,
  spaceHostFromFabricAuthority,
  SpaceHostValidationError,
} from "../src/space-host.ts";

/** Returns the `Error` thrown by `run`. */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

/** Returns a URL whose `.href` getter throws `cause`. */
function urlWithThrowingHref(cause: Error): URL {
  const host = new URL("https://route.example/");
  Object.defineProperty(host, "href", {
    get() {
      throw cause;
    },
  });
  return host;
}

describe("space-host", () => {
  describe("normalizeSpaceHost()", () => {
    it("returns the canonical HTTP or HTTPS origin", () => {
      expect(normalizeSpaceHost("HTTPS://ROUTE.EXAMPLE:443").toString()).toBe(
        "https://route.example/",
      );
      expect(
        normalizeSpaceHost(new URL("http://route.example:8080")).toString(),
      )
        .toBe("http://route.example:8080/");
    });

    it("throws for every component beyond the origin", () => {
      for (
        const host of [
          "https://@route.example/",
          "https://:@route.example/",
          "https://user@route.example/",
          "https://user:secret@route.example/",
          "https://route.example/api",
          "https://route.example/api/..",
          "https://route.example/%2e%2e/",
          "https://route.example/?region=west",
          "https://route.example/?",
          "https://route.example/#primary",
          "https://route.example/#",
        ]
      ) {
        expect(() => normalizeSpaceHost(host)).toThrow();
      }
    });

    it("throws for protocols that cannot serve shared space routes", () => {
      for (
        const host of [
          "ws://route.example/",
          "wss://route.example/",
          "ftp://route.example/",
        ]
      ) {
        expect(() => normalizeSpaceHost(host)).toThrow(
          "Unsupported space host protocol",
        );
      }
    });

    it("propagates errors while reading URL objects unchanged", () => {
      for (
        const cause of [
          new Error("unexpected URL read failure"),
          new TypeError("unexpected URL read type failure"),
        ]
      ) {
        expect(
          captureError(() => normalizeSpaceHost(urlWithThrowingHref(cause))),
        )
          .toBe(cause);
      }
    });

    it("throws a sanitized validation error for malformed strings", () => {
      const secret = "parser-password-sentinel";
      const error = captureError(() =>
        normalizeSpaceHost(`https://user:${secret}@[`)
      );
      expect(error).toBeInstanceOf(SpaceHostValidationError);
      expect(error.message).toBe("Invalid space host URL");
      expect(error.message).not.toContain(secret);
    });
  });

  describe("spaceHostFromFabricAuthority()", () => {
    it("returns an HTTPS origin for a bare fabric authority", () => {
      expect(spaceHostFromFabricAuthority("ROUTE.EXAMPLE:443").toString()).toBe(
        "https://route.example/",
      );
      expect(spaceHostFromFabricAuthority("localhost:8787").toString()).toBe(
        "https://localhost:8787/",
      );
    });

    it("returns an HTTP origin for a requested loopback route", () => {
      for (
        const authority of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]
      ) {
        expect(
          spaceHostFromFabricAuthority(authority, {
            useLoopbackHttp: true,
          }).protocol,
        ).toBe("http:");
      }
      expect(
        spaceHostFromFabricAuthority("route.example:8787", {
          useLoopbackHttp: true,
        }).protocol,
      ).toBe("https:");
      expect(
        spaceHostFromFabricAuthority("localhost:443", {
          useLoopbackHttp: true,
        }).toString(),
      ).toBe("http://localhost:443/");
    });

    it("throws for authority components beyond the origin", () => {
      for (
        const authority of [
          "user@route.example",
          "route.example/api",
          "route.example?region=west",
          "route.example#primary",
        ]
      ) {
        expect(() => spaceHostFromFabricAuthority(authority)).toThrow();
      }
    });
  });

  describe("fabricAuthorityMatchesSpaceHost()", () => {
    it("compares an authority using the route's configured transport", () => {
      expect(
        fabricAuthorityMatchesSpaceHost(
          "ROUTE.EXAMPLE:80",
          "http://route.example/",
        ),
      ).toBe(true);
      expect(
        fabricAuthorityMatchesSpaceHost(
          "ROUTE.EXAMPLE:443",
          "https://route.example/",
        ),
      ).toBe(true);
      expect(
        fabricAuthorityMatchesSpaceHost(
          "other.example",
          "https://route.example/",
        ),
      ).toBe(false);
    });

    it("throws for non-authority components", () => {
      for (const authority of ["user@route.example", "route.example/api"]) {
        expect(() =>
          fabricAuthorityMatchesSpaceHost(
            authority,
            "https://route.example/",
          )
        ).toThrow();
      }
    });
  });
});
