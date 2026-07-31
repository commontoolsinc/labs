import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
  systemPatternSource,
  systemPatternSourceForModuleName,
} from "../src/pattern-source-scheme.ts";

const HOST = "http://toolshed.test";

describe("resolveSystemPatternSource", () => {
  it("expands a ref to its patterns route", () => {
    expect(
      resolveSystemPatternSource(systemPatternSource("lunch-poll/main.tsx")),
    ).toBe("/api/patterns/lunch-poll/main.tsx");
    expect(resolveSystemPatternSource("system:system/default-app.tsx"))
      .toBe("/api/patterns/system/default-app.tsx");
  });

  it("refuses everything that is not a well-formed ref", () => {
    // The whitelist is the point. Each of these either did produce a fetch
    // under the old "any same-origin path" rule, or would under a looser one.
    for (
      const source of [
        "cf:published-pattern",
        "/api/patterns/system/home.tsx", // the pre-scheme spelling, unrewritten
        "/participant-identity-card.tsx", // a file-tree module name
        "/main.tsx",
        "http://toolshed.test/api/patterns/system/home.tsx",
        "system:", // no path
        "system:/leading-slash.tsx",
        "system:main.tsx?identity=", // the updater adds the query, not the ref
        "system:main.tsx#frag",
        "",
      ]
    ) {
      expect(resolveSystemPatternSource(source)).toBeUndefined();
    }
  });

  it("refuses a ref that climbs out of the patterns route", () => {
    expect(resolveSystemPatternSource("system:../secrets.tsx")).toBeUndefined();
    expect(resolveSystemPatternSource("system:system/../../etc/passwd"))
      .toBeUndefined();
    // Climbing back in is fine — it still addresses the route.
    expect(resolveSystemPatternSource("system:system/../system/home.tsx"))
      .toBe("/api/patterns/system/home.tsx");
  });
});

describe("systemPatternSourceForModuleName", () => {
  it("accepts a patterns-route module name", () => {
    expect(systemPatternSourceForModuleName("/api/patterns/system/home.tsx"))
      .toBe("system:system/home.tsx");
  });

  it("refuses a name that says nothing about a route", () => {
    // How a program deployed from a file tree names its modules — the case
    // this guard exists for.
    expect(systemPatternSourceForModuleName("/participant-identity-card.tsx"))
      .toBeUndefined();
    expect(systemPatternSourceForModuleName("/main.tsx")).toBeUndefined();
    expect(systemPatternSourceForModuleName("main.tsx")).toBeUndefined();
  });
});

describe("normalizePatternSource", () => {
  it("rewrites the rooted route path a system root was stamped with", () => {
    expect(normalizePatternSource("/api/patterns/system/home.tsx"))
      .toBe("system:system/home.tsx");
    expect(normalizePatternSource("/api/patterns/custom/my-app.tsx", HOST))
      .toBe("system:custom/my-app.tsx");
  });

  it("rewrites the absolute form only for the space's own host", () => {
    expect(
      normalizePatternSource(`${HOST}/api/patterns/system/home.tsx`, HOST),
    ).toBe("system:system/home.tsx");
    // Another host's route is not this host's to re-point at.
    expect(
      normalizePatternSource("http://elsewhere.test/api/patterns/x.tsx", HOST),
    ).toBe("http://elsewhere.test/api/patterns/x.tsx");
    // With no host there is nothing to compare against.
    expect(normalizePatternSource(`${HOST}/api/patterns/system/home.tsx`))
      .toBe(`${HOST}/api/patterns/system/home.tsx`);
  });

  it("leaves everything else exactly as it found it", () => {
    for (
      const source of [
        "cf:published-pattern",
        "system:system/home.tsx",
        "/main.tsx",
        "/api/other/thing.tsx",
        `${HOST}/api/patterns/system/home.tsx?v=2`,
        "not an origin",
      ]
    ) {
      expect(normalizePatternSource(source, HOST)).toBe(source);
    }
  });
});
