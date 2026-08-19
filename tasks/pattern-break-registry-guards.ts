/**
 * Static guards over the two accepted-break registries
 * (`pattern-compat-accepted-breaks.ts`, `pattern-vintage-accepted-drops.ts`).
 *
 * The registries' own audits are per-run and per-finding: an entry that stops
 * forgiving anything fails the run that would have used it. These guards are
 * about what an entry IS, before any finding exists:
 *
 * - **No entry may name a required pattern.** The home and default-app roots
 *   are the patterns that update aggressively and unconditionally — a break
 *   accepted there is a decision to strand every space's root the moment it
 *   merges, which is never the intent of a per-pattern exemption. The
 *   required set comes in from the caller, derived from the runtime's own
 *   constants (the same seam `pattern-vintage` already uses), so this guard
 *   cannot drift from what actually auto-updates.
 * - **Every entry names its decision record, and the record exists.** The
 *   registry line is the declaration; the record under `docs/history/` is the
 *   deliberation — what broke, why it was accepted, and what happens to the
 *   pieces holding the old shape. A record is a Markdown document of that
 *   tree's own: the path may not step back out of it, and the tree's live
 *   scaffolding (`README.md`, `INDEX.md`) does not qualify.
 *   `check-docs-history-index` forces every other document under the tree to
 *   be indexed, so this guard's shape-plus-existence check is membership.
 *
 * Pure and parameterized (entries, required set, existence probe) so the
 * rules are provable against synthetic registries in
 * `pattern-break-registry-guards.test.ts`, with the shipped registries
 * checked against the real tree in the same suite.
 */

import { ACCEPTED_CONTRACT_BREAKS } from "./pattern-compat-accepted-breaks.ts";
import { ACCEPTED_STATE_DROPS } from "./pattern-vintage-accepted-drops.ts";

/** The registry-independent shape both kinds of entry share. */
export interface BreakRegistryEntry {
  /** Which registry the entry sits in, for reporting. */
  registry: string;
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;
  /** Repo-relative path of the entry's decision record. */
  record: string;
}

export interface BreakRegistryFinding {
  registry: string;
  pattern: string;
  detail: string;
}

const RECORD_PREFIX = "docs/history/";

/** The history tree's own live scaffolding — never a decision record. */
const RECORD_SCAFFOLDING = new Set(["README.md", "INDEX.md"]);

/**
 * Why `record` cannot name a decision record, or `undefined` when its shape
 * qualifies. Shape only — existence is the caller's probe, and it runs only
 * on paths this has already passed, so the probe never resolves a traversal
 * out of the tree.
 */
function recordPathProblem(record: string): string | undefined {
  if (!record.startsWith(RECORD_PREFIX)) {
    return `is not under ${RECORD_PREFIX} — the decision record lives in ` +
      `the history tree`;
  }
  // Both separators: on Windows the probe's stat resolves a backslash as a
  // path separator, so a slash-only split would let `..\` step out.
  const segments = record.slice(RECORD_PREFIX.length).split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    return `steps back out of ${RECORD_PREFIX} — a dot or empty segment ` +
      `defeats the prefix`;
  }
  if (!record.endsWith(".md")) {
    return `is not a Markdown document — a decision record is one`;
  }
  // The tree root's own two files; a NESTED file by either name is an
  // ordinary indexed document.
  if (segments.length === 1 && RECORD_SCAFFOLDING.has(segments[0])) {
    return `is the history tree's own scaffolding, not a decision record`;
  }
  return undefined;
}

/** Both shipped registries, flattened to the shape the guards judge. */
export function collectBreakRegistryEntries(): BreakRegistryEntry[] {
  return [
    ...ACCEPTED_CONTRACT_BREAKS.map((entry) => ({
      registry: "pattern-compat-accepted-breaks",
      pattern: entry.pattern,
      record: entry.record,
    })),
    ...ACCEPTED_STATE_DROPS.map((entry) => ({
      registry: "pattern-vintage-accepted-drops",
      pattern: entry.pattern,
      record: entry.record,
    })),
  ];
}

export function guardBreakRegistryEntries(options: {
  entries: readonly BreakRegistryEntry[];
  requiredPatternKeys: ReadonlySet<string>;
  recordExists: (repoRelativePath: string) => boolean;
}): BreakRegistryFinding[] {
  const findings: BreakRegistryFinding[] = [];
  for (const entry of options.entries) {
    if (options.requiredPatternKeys.has(entry.pattern)) {
      findings.push({
        registry: entry.registry,
        pattern: entry.pattern,
        detail: `names a required pattern — the auto-updating roots are ` +
          `never eligible for an accepted break`,
      });
    }
    const pathProblem = recordPathProblem(entry.record);
    if (pathProblem !== undefined) {
      findings.push({
        registry: entry.registry,
        pattern: entry.pattern,
        detail: `record "${entry.record}" ${pathProblem}`,
      });
    } else if (!options.recordExists(entry.record)) {
      findings.push({
        registry: entry.registry,
        pattern: entry.pattern,
        detail: `record "${entry.record}" does not exist — an accepted ` +
          `break carries its deliberation, not just its declaration`,
      });
    }
  }
  return findings;
}

/**
 * Guard the shipped registries against the real tree, formatted for a task's
 * failure output. Returns `undefined` when every entry is permitted.
 */
export function reportBreakRegistryFindings(options: {
  requiredPatternKeys: ReadonlySet<string>;
  recordExists: (repoRelativePath: string) => boolean;
}): string | undefined {
  const findings = guardBreakRegistryEntries({
    entries: collectBreakRegistryEntries(),
    requiredPatternKeys: options.requiredPatternKeys,
    recordExists: options.recordExists,
  });
  if (findings.length === 0) return undefined;
  const lines = findings.map((finding) =>
    `  ${finding.registry}: ${finding.pattern}\n    ${finding.detail}`
  );
  return `${findings.length} accepted-break registry entr` +
    `${findings.length === 1 ? "y is" : "ies are"} not permitted:\n\n` +
    lines.join("\n");
}
