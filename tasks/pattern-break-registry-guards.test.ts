import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type BreakRegistryEntry,
  collectBreakRegistryEntries,
  guardBreakRegistryEntries,
} from "./pattern-break-registry-guards.ts";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
} from "../packages/piece/src/system-pattern-url.ts";
import { requiredPatternKeys } from "./pattern-vintage-lib.ts";
import { fromFileUrl } from "@std/path/from-file-url";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

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

  it("reports every offending entry rather than the first", () => {
    const findings = guardBreakRegistryEntries({
      entries: [
        entry({ pattern: "system/home.tsx" }),
        entry({ record: "docs/history/never-written.md" }),
      ],
      requiredPatternKeys: new Set(["system/home.tsx"]),
      recordExists: () => false,
    });
    // The first entry also fails the existence probe, so three findings.
    expect(findings.length).toBe(3);
  });

  it("accepts the shipped registries against the real tree", () => {
    const findings = guardBreakRegistryEntries({
      entries: collectBreakRegistryEntries(),
      requiredPatternKeys: new Set(
        requiredPatternKeys([HOME_PATTERN_SOURCE, DEFAULT_APP_PATTERN_SOURCE]),
      ),
      recordExists: (path) => {
        try {
          return Deno.statSync(`${REPO_ROOT}/${path}`).isFile;
        } catch {
          return false;
        }
      },
    });
    expect(findings).toEqual([]);
  });
});
