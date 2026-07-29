import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  collectPatternFiles,
  isPatternSource,
  patternKey,
  PATTERNS_DIR,
} from "./pattern-files.ts";

describe("isPatternSource", () => {
  it("accepts authored .ts and .tsx entries", () => {
    expect(isPatternSource("packages/patterns/notes/note.tsx")).toBe(true);
    expect(isPatternSource("packages/patterns/system/home.tsx")).toBe(true);
    expect(isPatternSource("packages/patterns/vehicles.ts")).toBe(true);
  });

  it("rejects test files, which are never update targets themselves", () => {
    expect(isPatternSource("packages/patterns/notes/note.test.tsx")).toBe(
      false,
    );
    expect(isPatternSource("packages/patterns/vehicles.test.ts")).toBe(false);
  });

  it("rejects non-source files, including the baselines this gate writes", () => {
    expect(isPatternSource("packages/patterns/README.md")).toBe(false);
    expect(
      isPatternSource(
        "packages/patterns/baselines/a.tsx/20260101T000000Z-x.json",
      ),
    ).toBe(false);
  });

  it("rejects the excluded trees and files", () => {
    expect(isPatternSource("packages/patterns/integration/foo.ts")).toBe(false);
    expect(isPatternSource("packages/patterns/tools/foo.ts")).toBe(false);
    expect(isPatternSource("packages/patterns/mod.ts")).toBe(false);
    expect(isPatternSource("packages/patterns/scrabble/scrabble-words.ts"))
      .toBe(
        false,
      );
  });
});

describe("patternKey", () => {
  it("strips the patterns root, leaving the toolshed route suffix", () => {
    // The key is also the path the updater resolves `?identity` against, so it
    // has to be exactly the route suffix — not a basename, not an absolute path.
    expect(patternKey("packages/patterns/system/home.tsx")).toBe(
      "system/home.tsx",
    );
    expect(patternKey("packages/patterns/top.tsx")).toBe("top.tsx");
  });

  it("leaves a path that is not under the patterns root alone", () => {
    expect(patternKey("elsewhere/home.tsx")).toBe("elsewhere/home.tsx");
  });
});

describe("collectPatternFiles", () => {
  it("returns a sorted set of real pattern sources and no baselines", async () => {
    const files = await collectPatternFiles(PATTERNS_DIR);

    expect(files.length).toBeGreaterThan(100);
    expect([...files].sort()).toEqual(files);
    expect(files.includes(`${PATTERNS_DIR}/system/home.tsx`)).toBe(true);
    expect(files.some((f) => f.includes("/baselines/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.tsx"))).toBe(false);
    expect(files.some((f) => f.startsWith(`${PATTERNS_DIR}/integration/`)))
      .toBe(false);
  });
});
