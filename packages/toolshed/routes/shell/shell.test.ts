import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/shell/shell.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

// The shell document must stay NON-cross-origin-isolated so that untrusted
// patterns are never handed SharedArrayBuffer / Atomics or a high-resolution
// clock. A page is cross-origin isolated only when it is served with BOTH
// `Cross-Origin-Opener-Policy: same-origin` AND a require-corp/credentialless
// `Cross-Origin-Embedder-Policy`. These tests fail loudly if a future change
// flips the served document to that isolating combination.
//
// See docs/specs/sandboxing/cross-origin-isolation.md.
describe("Shell cross-origin isolation posture", () => {
  it("does not serve the isolating COOP+COEP header combination", async () => {
    const response = await app.request("/");
    // Drain the body so the response does not leak into the test runner.
    await response.text();

    const coop = response.headers.get("Cross-Origin-Opener-Policy");
    const coep = response.headers.get("Cross-Origin-Embedder-Policy");

    const isolatingCoop = coop === "same-origin";
    const isolatingCoep = coep === "require-corp" || coep === "credentialless";

    // Isolation requires BOTH headers; assert we never emit both together.
    expect(isolatingCoop && isolatingCoep).toBe(false);
  });

  it("pins COOP to a non-isolating value", async () => {
    const response = await app.request("/");
    await response.text();

    const coop = response.headers.get("Cross-Origin-Opener-Policy");
    expect(coop).not.toBe("same-origin");
    expect(coop).toBe("same-origin-allow-popups");
  });

  it("pins COEP to a non-isolating value", async () => {
    const response = await app.request("/");
    await response.text();

    const coep = response.headers.get("Cross-Origin-Embedder-Policy");
    expect(coep).not.toBe("require-corp");
    expect(coep).not.toBe("credentialless");
    expect(coep).toBe("unsafe-none");
  });

  it("applies the non-isolating headers to nested paths too", async () => {
    // The posture must hold for every served path, not just the document root,
    // because any same-origin response can establish or reuse the page's agent
    // cluster.
    const response = await app.request("/assets/app.js");
    await response.text();

    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "unsafe-none",
    );
  });
});

// The shell routes serve read-only content to any origin. These pin that
// permissive CORS keeps working alongside the isolation headers, so a future
// change to one does not silently disturb the other.
describe("Shell route CORS", () => {
  it("allows a cross-origin GET with a wildcard origin", async () => {
    const response = await app.request("/", {
      headers: { Origin: "https://example.com" },
    });
    await response.text();

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers an OPTIONS preflight", async () => {
    const response = await app.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    await response.text();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// With no compiled frontend and no SHELL_URL proxy target — the unit-test
// environment — the shell router answers with a 404 that tells an operator how
// to bring the shell up. This guards that operator hint and its port.
describe("Shell dev fallback without a compiled build or proxy", () => {
  it("returns 404 with a hint naming SHELL_URL and the shell port", async () => {
    const response = await app.request("/anything");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(/Shell app not available/.test(body)).toBe(true);
    expect(/SHELL_URL=http:\/\/localhost:\d+/.test(body)).toBe(true);
  });
});
