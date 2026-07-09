import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SESRuntime } from "../src/sandbox/ses-runtime.ts";
import { identitySourceMap } from "@commonfabric/js-compiler/source-map";

// The runner-facing source-map surface of the SES runtime. The ESM boot path
// now registers DEFERRED providers (CT-1819), but the eager chain stays
// load-bearing: the AMD/isolate `execute` path registers per-script maps
// directly, and an explicit registration must win over any pending provider
// for the same name.
describe("SESRuntime source-map registration", () => {
  it("eager loads resolve immediately and supersede lazy providers", () => {
    const runtime = new SESRuntime();
    let providerCalls = 0;
    runtime.loadSourceMapLazy("m.js", () => {
      providerCalls++;
      return identitySourceMap(3, "/id/stale.tsx");
    });
    runtime.loadSourceMap("m.js", identitySourceMap(3, "/id/fresh.tsx"));

    const pos = runtime.mapPosition("m.js", 2, 0);
    expect(pos?.source).toBe("/id/fresh.tsx");
    expect(pos?.line).toBe(2);
    // The pending provider was displaced without ever running.
    expect(providerCalls).toBe(0);
    // Stack parsing rides the same registry.
    expect(runtime.parseStack("    at fn (m.js:3:0)")).toContain(
      "/id/fresh.tsx:3:0",
    );
  });

  it("lazy providers materialize once, on first lookup", () => {
    const runtime = new SESRuntime();
    let providerCalls = 0;
    runtime.loadSourceMapLazy("lazy.js", () => {
      providerCalls++;
      return identitySourceMap(2, "/id/lazy.tsx");
    });
    expect(providerCalls).toBe(0);
    expect(runtime.mapPosition("lazy.js", 1, 0)?.source).toBe("/id/lazy.tsx");
    runtime.mapPosition("lazy.js", 2, 0);
    expect(providerCalls).toBe(1);
  });
});
