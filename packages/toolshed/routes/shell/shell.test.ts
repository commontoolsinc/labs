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
});
