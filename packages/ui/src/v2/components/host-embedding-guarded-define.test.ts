import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// Host-embedding contract seam 5 (docs/development/HOST_EMBEDDING.md §5): every
// cf-* component's index.ts guards its customElements.define with
// `if (!customElements.get(tag))`, so importing a component module twice — or
// importing a component whose tag is already registered — is a no-op instead of
// a `NotSupportedError: '<tag>' has already been defined` crash. That guard is
// what lets a host deep-import the full component set into one bundle and
// re-mount freely.
//
// Deno caches ES module evaluation, so a plain second `import` of the same
// specifier does not re-run the module body. We force re-evaluation with a
// cache-busting query string: the second evaluation re-runs the top-level
// define, exercising the guard. An unguarded raw `customElements.define` throws
// on that second run, turning this test red.
const components: Array<{ tag: string; path: string }> = [
  { tag: "cf-render", path: "./cf-render/index.ts" },
  { tag: "cf-cell-link", path: "./cf-cell-link/index.ts" },
  { tag: "cf-profile-badge", path: "./cf-profile-badge/index.ts" },
  { tag: "cf-toolbar", path: "./cf-toolbar/index.ts" },
];

describe("host embedding contract: guarded-define idiom", () => {
  for (const { tag, path } of components) {
    it(`${tag} is import-safe (re-evaluating its module does not throw)`, async () => {
      const base = new URL(path, import.meta.url).href;

      // First evaluation registers the tag.
      await import(base);
      expect(customElements.get(tag)).toBeDefined();

      // Second evaluation re-runs the module body via a cache-busting query.
      // The guard must swallow the redundant define; no throw, tag still there.
      await import(`${base}?reimport=host-embedding`);
      expect(customElements.get(tag)).toBeDefined();
    });
  }

  it("a redundant customElements.define is what the guard prevents", () => {
    // Documents the failure mode the guard defends against: defining an
    // already-registered tag throws. The guard turns this into a no-op.
    expect(customElements.get("cf-render")).toBeDefined();
    expect(() =>
      customElements.define("cf-render", class extends HTMLElement {})
    )
      .toThrow();
  });
});
