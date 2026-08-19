import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type BreakRegistryEntry,
  collectBreakRegistryEntries,
  deriveRequiredPatternKeys,
  guardBreakRegistryEntries,
  recordExistsUnder,
} from "./pattern-break-registry-guards.ts";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
} from "../packages/piece/src/system-pattern-url.ts";

const entry = (overrides: Partial<BreakRegistryEntry>): BreakRegistryEntry => ({
  registry: "pattern-compat-accepted-breaks",
  pattern: "lunch-poll/main.tsx",
  record: "docs/history/topics-crossref-identity-break.md",
  ...overrides,
});

describe("pattern-break-registry-guards", () => {
  it("returns no findings for an ordinary entry with an existing record", () => {
    expect(guardBreakRegistryEntries({
      entries: [entry({})],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => true,
    })).toEqual([]);
  });

  it("returns a finding for an entry naming a required pattern", () => {
    const findings = guardBreakRegistryEntries({
      entries: [entry({ pattern: "system/home.tsx" })],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => true,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].detail).toContain("required pattern");
  });

  it("returns a finding for a record outside docs/history/", () => {
    const findings = guardBreakRegistryEntries({
      entries: [entry({ record: "docs/plans/some-plan.md" })],
      requiredPatternKeys: new Set(),
      recordExists: () => true,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].detail).toContain("docs/history/");
  });

  it("returns a finding for a record that does not exist", () => {
    const findings = guardBreakRegistryEntries({
      entries: [entry({ record: "docs/history/never-written.md" })],
      requiredPatternKeys: new Set(),
      recordExists: () => false,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].detail).toContain("does not exist");
  });

  it("returns a finding for a record that steps back out of the tree", () => {
    // The prefix alone would accept these, and the probe would then stat a
    // file OUTSIDE the history tree — so the shape check refuses them before
    // the probe ever sees them. The second spelling is the Windows face:
    // stat resolves a backslash as a separator there.
    for (
      const record of [
        "docs/history/../../README.md",
        "docs/history/..\\..\\README.md",
      ]
    ) {
      const findings = guardBreakRegistryEntries({
        entries: [entry({ record })],
        requiredPatternKeys: new Set(),
        recordExists: () => true,
      });
      expect(findings.length).toBe(1);
      expect(findings[0].detail).toContain("steps back out");
    }
  });

  it("returns a finding for a record that is not a Markdown document", () => {
    const findings = guardBreakRegistryEntries({
      entries: [entry({ record: "docs/history/evidence.sqlite" })],
      requiredPatternKeys: new Set(),
      recordExists: () => true,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].detail).toContain("Markdown");
  });

  it("returns a finding for the history tree's own scaffolding", () => {
    // Both live files under the tree exist and end in .md, and neither is a
    // decision record.
    for (const record of ["docs/history/README.md", "docs/history/INDEX.md"]) {
      const findings = guardBreakRegistryEntries({
        entries: [entry({ record })],
        requiredPatternKeys: new Set(),
        recordExists: () => true,
      });
      expect(findings.length).toBe(1);
      expect(findings[0].detail).toContain("scaffolding");
    }
  });

  it("accepts a nested record named like the scaffolding", () => {
    // Only the tree root's own two files are scaffolding. A nested README.md
    // is an ordinary document the index covers.
    expect(guardBreakRegistryEntries({
      entries: [entry({ record: "docs/history/some-break/README.md" })],
      requiredPatternKeys: new Set(),
      recordExists: () => true,
    })).toEqual([]);
  });

  it("reports every offending entry rather than the first", () => {
    const findings = guardBreakRegistryEntries({
      entries: [
        entry({ pattern: "system/home.tsx" }),
        entry({ record: "docs/history/never-written.md" }),
      ],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => false,
    });
    // Asserted by CONTENT, not by count: the first entry also fails the
    // existence probe, so a bare `length === 3` passes on the wrong three.
    expect(findings.map((finding) => `${finding.pattern} ${finding.detail}`))
      .toEqual([
        "system/home.tsx names a required pattern — the auto-updating roots " +
        "are never eligible for an accepted break",
        'system/home.tsx record "docs/history/topics-crossref-identity-break' +
        '.md" does not exist — an accepted break carries its deliberation, ' +
        "not just its declaration",
        'lunch-poll/main.tsx record "docs/history/never-written.md" does not ' +
        "exist — an accepted break carries its deliberation, not just its " +
        "declaration",
      ]);
  });

  it("refuses a required pattern written as a bare suffix key", () => {
    // `acceptedDropsFor` claims an entry by path SUFFIX, so `home.tsx` really
    // does forgive drops on `system/home.tsx`. An exact-match floor would let
    // the shorter spelling walk straight around it.
    const findings = guardBreakRegistryEntries({
      entries: [entry({ pattern: "home.tsx" })],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => true,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].detail).toContain("required pattern");
  });

  it("allows a pattern the required key merely ends with textually", () => {
    // The boundary the suffix rule needs: `home.tsx` is claimed because the
    // separator lines up, but `whome.tsx` is a different pattern that no
    // required key addresses.
    expect(guardBreakRegistryEntries({
      entries: [entry({ pattern: "whome.tsx" })],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => true,
    })).toEqual([]);
  });

  it("accepts the shipped registries against the real tree", () => {
    // Through the same derivation and the same probe the gates use, so this
    // case also proves those resolve correctly from wherever tests run.
    const required = deriveRequiredPatternKeys(
      [HOME_PATTERN_SOURCE, DEFAULT_APP_PATTERN_SOURCE],
    );
    expect("error" in required).toBe(false);
    expect(guardBreakRegistryEntries({
      entries: collectBreakRegistryEntries(),
      requiredPatternKeys: (required as { keys: ReadonlySet<string> }).keys,
      recordExists: recordExistsUnder(),
    })).toEqual([]);
  });
});
